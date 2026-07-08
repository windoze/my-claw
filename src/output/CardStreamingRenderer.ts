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
const INITIAL_CARD_CONTENT = "任务已开始，等待 Agent 输出…";
const TOOL_PROGRESS_HEADER = "任务仍在运行，正在处理工具调用：";
const MAX_TOOL_PROGRESS_LINES = 6;
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

  /** Streams events into an AI Card, falling back to final Markdown if card APIs fail. */
  public async renderStream(
    eventStream: AsyncIterable<AgentEvent>,
    replySink: ReplySink,
    context: OutputRenderContext = {},
  ): Promise<AgentEvent[]> {
    const streamer = replySink.cardStreamer;

    if (streamer === undefined || this.config.mode !== "ai-card") {
      return this.renderFallback(eventStream, replySink, context);
    }

    const outTrackId = createOutTrackId(context.taskId, this.createId());
    let handle: ReplyCardStreamHandle;

    try {
      handle = await streamer.start({
        outTrackId,
        title: CARD_TITLE,
        content: INITIAL_CARD_CONTENT,
        status: "running",
        taskId: context.taskId,
      });
      this.logger.info("DingTalk AI Card streaming started.", {
        cardId: handle.cardId ?? handle.outTrackId,
        outTrackId: handle.outTrackId,
        taskId: context.taskId,
      });
    } catch (error: unknown) {
      this.logger.warn("DingTalk AI Card creation failed; falling back to Markdown.", {
        error,
        outTrackId,
        taskId: context.taskId,
      });
      return this.renderFallback(eventStream, replySink, context);
    }

    const events: AgentEvent[] = [];
    const accumulator = new AgentEventTextAccumulator();
    const toolProgressLines: string[] = [];
    let lastUpdateAt = this.now();
    let lastSentContent = INITIAL_CARD_CONTENT;
    let cardFailed = false;

    for await (const event of eventStream) {
      events.push(event);
      accumulator.append(event, this.logger);
      appendToolProgressLine(toolProgressLines, event);

      if (
        !cardFailed &&
        accumulator.status === "running" &&
        this.shouldSendThrottledUpdate(lastUpdateAt)
      ) {
        const content = createCardContent(accumulator, toolProgressLines, {
          includeEmpty: false,
        });

        if (content === lastSentContent) {
          continue;
        }

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
      const content = createCardContent(accumulator, toolProgressLines, {
        includeEmpty: true,
      });
      const updated = await this.tryUpdateCard(streamer, handle, accumulator, context, {
        content,
        isFinal: true,
      });
      cardFailed = !updated;
    }

    if (cardFailed) {
      await this.fallbackRenderer.render(events, replySink, context);
      return events;
    }

    this.logger.info("DingTalk AI Card streaming finalized.", {
      cardId: handle.cardId ?? handle.outTrackId,
      outTrackId: handle.outTrackId,
      taskId: context.taskId,
      sessionId: accumulator.sessionId,
      status: toCardStatus(accumulator.status, true),
    });
    return events;
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

    try {
      await streamer.update(handle, {
        title: CARD_TITLE,
        content: options.content,
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
  if (event.type !== "tool_start" && event.type !== "tool_finish") {
    return;
  }

  const name = normalizeToolName(event.name);
  lines.push(
    event.type === "tool_start" ? `- 正在使用工具：${name}` : `- 工具已完成：${name}`,
  );

  if (lines.length > MAX_TOOL_PROGRESS_LINES) {
    lines.splice(0, lines.length - MAX_TOOL_PROGRESS_LINES);
  }
}

function createCardContent(
  accumulator: AgentEventTextAccumulator,
  toolProgressLines: readonly string[],
  options: { includeEmpty: boolean },
): string {
  const markdown = accumulator.toMarkdown({ includeEmpty: options.includeEmpty });

  if (markdown.trim().length > 0) {
    return markdown;
  }

  if (accumulator.status === "running" && toolProgressLines.length > 0) {
    return [TOOL_PROGRESS_HEADER, "", ...toolProgressLines].join("\n");
  }

  return INITIAL_CARD_CONTENT;
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
