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
    let lastUpdateAt = this.now();
    let cardFailed = false;

    for await (const event of eventStream) {
      events.push(event);
      accumulator.append(event, this.logger);

      if (
        !cardFailed &&
        accumulator.status === "running" &&
        this.shouldSendThrottledUpdate(lastUpdateAt)
      ) {
        const updated = await this.tryUpdateCard(streamer, handle, accumulator, context, {
          isFinal: false,
        });
        cardFailed = !updated;
        lastUpdateAt = this.now();
      }
    }

    if (!cardFailed) {
      const updated = await this.tryUpdateCard(streamer, handle, accumulator, context, {
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
    options: { isFinal: boolean },
  ): Promise<boolean> {
    const status = toCardStatus(accumulator.status, options.isFinal);

    try {
      await streamer.update(handle, {
        title: CARD_TITLE,
        content: accumulator.toMarkdown({ includeEmpty: options.isFinal }),
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

async function collectAgentEvents(eventStream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];

  for await (const event of eventStream) {
    events.push(event);
  }

  return events;
}

function createOutTrackId(taskId: string | undefined, uniqueId: string): string {
  const safeTaskId = taskId?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const suffix = uniqueId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return safeTaskId === undefined || safeTaskId.length === 0
    ? `agent-${suffix}`
    : `agent-${safeTaskId}-${suffix}`;
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
