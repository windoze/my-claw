/** Streams Agent output into a DingTalk AI Card with Markdown fallback. */

import { randomUUID } from "node:crypto";

import type { AgentEvent } from "../backend/types.js";
import type { StreamingConfig } from "../config/types.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { AgentEventTextAccumulator } from "./renderAgentEvents.js";
import type {
  OutputRenderContext,
  ReplyCardStreamHandle,
  ReplyCardStreamStatus,
  ReplySink,
} from "./types.js";

interface FallbackRenderer {
  render(
    events: readonly AgentEvent[],
    replySink: ReplySink,
    context?: OutputRenderContext,
  ): Promise<void>;
}

/** Options needed to stream backend events into a card. */
export interface CardStreamingRendererOptions {
  config: StreamingConfig;
  fallbackRenderer: FallbackRenderer;
  logger?: Logger;
  now?: () => number;
  createId?: () => string;
}

const CARD_TITLE = "Agent 回复";
const EMPTY_CARD_CONTENT = "任务已完成，但没有文本输出。";
const TOOL_PROGRESS_HEADER = "任务仍在运行，正在处理：";
const MAX_TOOL_PROGRESS_LINES = 6;
/** Tools that surface an out-of-band prompt and therefore split the card stream. */
const INTERACTIVE_TOOL_NAMES = new Set(["AskUserQuestion", "ExitPlanMode"]);
const OUT_TRACK_ID_PREFIX = "agent";
const MAX_OUT_TRACK_ID_LENGTH = 64;
const OUT_TRACK_ID_RANDOM_CHARS = 16;
const MAX_OUT_TRACK_TASK_ID_CHARS =
  MAX_OUT_TRACK_ID_LENGTH -
  OUT_TRACK_ID_PREFIX.length -
  OUT_TRACK_ID_RANDOM_CHARS -
  2;

/** Consumes backend events and updates a card no more often than the configured throttle. */
export class CardStreamingRenderer {
  private readonly config: StreamingConfig;
  private readonly fallbackRenderer: FallbackRenderer;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly createId: () => string;

  public constructor(options: CardStreamingRendererOptions) {
    this.config = options.config;
    this.fallbackRenderer = options.fallbackRenderer;
    this.logger = options.logger ?? createLogger("output:cards");
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  /**
   * Streams events into AI Cards, falling back to final Markdown if card APIs fail.
   *
   * Cards are created lazily on first real content (no placeholder card). When an
   * interactive tool (AskUserQuestion / ExitPlanMode) fires, the current card is
   * finalized and a fresh card is started for subsequent output, so out-of-band
   * prompt/answer messages sit between the two cards in chat order.
   */
  public async renderStream(
    eventStream: AsyncIterable<AgentEvent>,
    replySink: ReplySink,
    context: OutputRenderContext = {},
  ): Promise<AgentEvent[]> {
    const streamer = replySink.cardStreamer;

    if (streamer === undefined || this.config.mode !== "ai-card") {
      return this.renderFallback(eventStream, replySink, context);
    }

    const events: AgentEvent[] = [];
    const accumulator = new AgentEventTextAccumulator();
    let toolProgressLines: string[] = [];
    let handle: ReplyCardStreamHandle | undefined;
    let publishedBaseline = 0;
    let lastSentContent = "";
    let lastUpdateAt = this.now();
    let cardFailed = false;

    for await (const event of eventStream) {
      events.push(event);
      accumulator.append(event, this.logger);
      appendToolProgressLine(toolProgressLines, event);

      if (cardFailed) {
        continue;
      }

      // An interactive tool sends an out-of-band prompt; close the current card and
      // start a fresh segment so post-interaction output lands on a new card below it.
      if (event.type === "tool_start" && isInteractiveTool(event.name)) {
        if (handle !== undefined) {
          const content = segmentContent(accumulator, publishedBaseline, toolProgressLines, {
            isFinal: true,
          });
          const updated = await this.tryUpdateCard(streamer, handle, accumulator, context, {
            content: content ?? EMPTY_CARD_CONTENT,
            isFinal: true,
          });
          cardFailed = !updated;
        }

        publishedBaseline = accumulator.toMarkdown().length;
        handle = undefined;
        toolProgressLines = [];
        lastSentContent = "";
        continue;
      }

      if (accumulator.status !== "running") {
        continue;
      }

      const content = segmentContent(accumulator, publishedBaseline, toolProgressLines, {
        isFinal: false,
      });

      if (content === undefined) {
        continue;
      }

      if (handle === undefined) {
        handle = await this.startCard(streamer, context, content);
        cardFailed = handle === undefined;
        lastSentContent = content;
        lastUpdateAt = this.now();
        continue;
      }

      if (this.shouldSendThrottledUpdate(lastUpdateAt) && content !== lastSentContent) {
        const updated = await this.tryUpdateCard(streamer, handle, accumulator, context, {
          content,
          isFinal: false,
        });
        cardFailed = !updated;
        lastSentContent = content;
        lastUpdateAt = this.now();
      }
    }

    if (!cardFailed) {
      const outcome = await this.finalizeLastCard(
        streamer,
        handle,
        accumulator,
        publishedBaseline,
        toolProgressLines,
        context,
      );

      if (outcome.status === "failed") {
        await this.fallbackRenderer.render(events, replySink, context);
        return events;
      }

      // Nothing was ever published and no card was closed earlier: emit empty-output text.
      if (outcome.status === "empty" && publishedBaseline === 0) {
        await this.fallbackRenderer.render(events, replySink, context);
        return events;
      }

      if (outcome.status === "finalized") {
        this.logger.info("DingTalk AI Card streaming finalized.", {
          cardId: outcome.handle.cardId ?? outcome.handle.outTrackId,
          outTrackId: outcome.handle.outTrackId,
          taskId: context.taskId,
          sessionId: accumulator.sessionId,
          status: toCardStatus(accumulator.status, true),
        });
      }

      return events;
    }

    await this.fallbackRenderer.render(events, replySink, context);
    return events;
  }

  /** Finalizes the trailing segment into its card, creating one lazily if needed. */
  private async finalizeLastCard(
    streamer: NonNullable<ReplySink["cardStreamer"]>,
    handle: ReplyCardStreamHandle | undefined,
    accumulator: AgentEventTextAccumulator,
    publishedBaseline: number,
    toolProgressLines: readonly string[],
    context: OutputRenderContext,
  ): Promise<FinalizeOutcome> {
    const content = segmentContent(accumulator, publishedBaseline, toolProgressLines, {
      isFinal: true,
    });

    if (handle === undefined) {
      if (content === undefined) {
        return { status: "empty" };
      }

      const created = await this.startCard(streamer, context, content);
      if (created === undefined) {
        return { status: "failed" };
      }

      const updated = await this.tryUpdateCard(streamer, created, accumulator, context, {
        content,
        isFinal: true,
      });
      return updated ? { status: "finalized", handle: created } : { status: "failed" };
    }

    const updated = await this.tryUpdateCard(streamer, handle, accumulator, context, {
      content: content ?? EMPTY_CARD_CONTENT,
      isFinal: true,
    });
    return updated ? { status: "finalized", handle } : { status: "failed" };
  }

  /** Creates a fresh AI Card seeded with real content, or `undefined` on failure. */
  private async startCard(
    streamer: NonNullable<ReplySink["cardStreamer"]>,
    context: OutputRenderContext,
    content: string,
  ): Promise<ReplyCardStreamHandle | undefined> {
    const outTrackId = createOutTrackId(context.taskId, this.createId());

    try {
      const handle = await streamer.start({
        outTrackId,
        title: CARD_TITLE,
        content,
        status: "running",
        taskId: context.taskId,
      });
      this.logger.info("DingTalk AI Card streaming started.", {
        cardId: handle.cardId ?? handle.outTrackId,
        outTrackId: handle.outTrackId,
        taskId: context.taskId,
      });
      return handle;
    } catch (error: unknown) {
      this.logger.warn("DingTalk AI Card creation failed; falling back to Markdown.", {
        error,
        outTrackId,
        taskId: context.taskId,
      });
      return undefined;
    }
  }

  private shouldSendThrottledUpdate(lastUpdateAt: number): boolean {
    return this.now() - lastUpdateAt >= this.config.updateThrottleMs;
  }

  private async renderFallback(
    eventStream: AsyncIterable<AgentEvent>,
    replySink: ReplySink,
    context: OutputRenderContext,
  ): Promise<AgentEvent[]> {
    const events = await collectAgentEvents(eventStream);
    await this.fallbackRenderer.render(events, replySink, context);
    return events;
  }

  private async tryUpdateCard(
    streamer: NonNullable<ReplySink["cardStreamer"]>,
    handle: ReplyCardStreamHandle,
    accumulator: AgentEventTextAccumulator,
    context: OutputRenderContext,
    options: { content: string; isFinal: boolean },
  ): Promise<boolean> {
    const status = toCardStatus(accumulator.status, options.isFinal);
    // Inline local images only on the finalized card: streaming re-sends the full body
    // on every throttled update, so uploading mid-stream would churn and duplicate work.
    const content =
      options.isFinal && context.inlineImages
        ? await context.inlineImages(options.content)
        : options.content;

    try {
      await streamer.update(handle, {
        title: CARD_TITLE,
        content,
        status,
        taskId: context.taskId,
        sessionId: accumulator.sessionId,
        isFinal: options.isFinal,
        isError: status === "error",
      });
      return true;
    } catch (error: unknown) {
      this.logger.warn("DingTalk AI Card update failed; falling back to Markdown.", {
        error,
        cardId: handle.cardId ?? handle.outTrackId,
        outTrackId: handle.outTrackId,
        taskId: context.taskId,
      });
      return false;
    }
  }
}

function appendToolProgressLine(lines: string[], event: AgentEvent): void {
  const line = toProgressLine(event);

  if (line === undefined) {
    return;
  }

  lines.push(line);

  if (lines.length > MAX_TOOL_PROGRESS_LINES) {
    lines.splice(0, lines.length - MAX_TOOL_PROGRESS_LINES);
  }
}

/** Builds a rolling progress line for tool and plan events, or undefined to skip. */
function toProgressLine(event: AgentEvent): string | undefined {
  if (event.type === "tool_start") {
    const name = event.title ?? normalizeToolName(event.name);
    return `- 正在使用工具：${name}`;
  }

  if (event.type === "tool_finish") {
    const name = normalizeToolName(event.name);
    const failed = event.status === "failed";
    return failed ? `- 工具执行失败：${name}` : `- 工具已完成：${name}`;
  }

  if (event.type === "plan") {
    const total = event.entries.length;
    const done = event.entries.filter((entry) => entry.status === "completed").length;
    return `- 更新执行计划（${done}/${total}）`;
  }

  return undefined;
}

/** Outcome of finalizing the trailing card segment. */
type FinalizeOutcome =
  | { status: "finalized"; handle: ReplyCardStreamHandle }
  | { status: "empty" }
  | { status: "failed" };

/** Reports whether a tool surfaces an out-of-band prompt that should split the card. */
function isInteractiveTool(name: string): boolean {
  return INTERACTIVE_TOOL_NAMES.has(name.trim());
}

/**
 * Builds the content for the current card segment: the accumulated Markdown beyond
 * `publishedBaseline` (text belonging to earlier, already-finalized cards). Falls back
 * to a tool-progress placeholder while a tool runs before any text, and returns
 * `undefined` when there is nothing to display yet for this segment.
 */
function segmentContent(
  accumulator: AgentEventTextAccumulator,
  publishedBaseline: number,
  toolProgressLines: readonly string[],
  options: { isFinal: boolean },
): string | undefined {
  const full = accumulator.toMarkdown();
  const segment = full.slice(publishedBaseline).trim();

  if (segment.length > 0) {
    return segment;
  }

  if (!options.isFinal && toolProgressLines.length > 0) {
    return [TOOL_PROGRESS_HEADER, "", ...toolProgressLines].join("\n");
  }

  return undefined;
}

function normalizeToolName(name: string): string {
  const normalized = name.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 ? normalized : "未知工具";
}

async function collectAgentEvents(eventStream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];

  for await (const event of eventStream) {
    events.push(event);
  }

  return events;
}

function createOutTrackId(taskId: string | undefined, uniqueId: string): string {
  const safeTaskId = createSafeOutTrackTaskId(taskId);
  const suffix = createSafeOutTrackSuffix(uniqueId);

  return safeTaskId === undefined
    ? `${OUT_TRACK_ID_PREFIX}-${suffix}`
    : `${OUT_TRACK_ID_PREFIX}-${safeTaskId}-${suffix}`;
}

function createSafeOutTrackTaskId(taskId: string | undefined): string | undefined {
  const safeTaskId = taskId
    ?.replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, MAX_OUT_TRACK_TASK_ID_CHARS);
  return safeTaskId === undefined || safeTaskId.length === 0 ? undefined : safeTaskId;
}

function createSafeOutTrackSuffix(uniqueId: string): string {
  const suffix = uniqueId
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, OUT_TRACK_ID_RANDOM_CHARS);
  return suffix.length > 0 ? suffix : "stream";
}

function toCardStatus(
  status: AgentEventTextAccumulator["status"],
  isFinal: boolean,
): ReplyCardStreamStatus {
  if (status === "running" && isFinal) {
    return "done";
  }

  return status === "running" ? "running" : status;
}
