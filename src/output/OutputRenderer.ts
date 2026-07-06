/** Renders backend Agent events into replies for the current chat. */

import type { AgentEvent } from "../backend/types.js";
import type { OutputConfig, StreamingConfig } from "../config/types.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { CardStreamingRenderer } from "./CardStreamingRenderer.js";
import {
  AgentEventTextAccumulator,
  EMPTY_OUTPUT_MESSAGE,
  renderAgentEventMessages,
} from "./renderAgentEvents.js";
import { splitMarkdown } from "./splitMarkdown.js";
import type { OutputRenderContext, ReplySink } from "./types.js";

/** Options required by the backend event renderer. */
export interface OutputRendererOptions {
  config: OutputConfig;
  streaming?: StreamingConfig;
  logger?: Logger;
  now?: () => number;
}

/** Converts backend-neutral Agent events to Markdown replies. */
export class OutputRenderer {
  private readonly config: OutputConfig;
  private readonly streamingConfig: StreamingConfig | undefined;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly cardRenderer: CardStreamingRenderer | undefined;

  public constructor(options: OutputRendererOptions) {
    this.config = options.config;
    this.streamingConfig = options.streaming;
    this.logger = options.logger ?? createLogger("output");
    this.now = options.now ?? Date.now;
    this.cardRenderer =
      this.streamingConfig?.mode === "ai-card"
        ? new CardStreamingRenderer({
            config: this.streamingConfig,
            fallbackRenderer: this,
            logger: this.logger,
          })
        : undefined;
  }

  /** Renders all collected events to the supplied reply sink. */
  public async render(
    events: readonly AgentEvent[],
    replySink: ReplySink,
    _context: OutputRenderContext = {},
  ): Promise<void> {
    const messages = this.renderMessages(events);

    if (messages.length === 0) {
      await this.sendMarkdown(EMPTY_OUTPUT_MESSAGE, replySink);
      return;
    }

    for (const message of messages) {
      await this.sendMarkdown(message, replySink);
    }
  }

  /** Renders a backend event stream and returns every event it consumed. */
  public async renderStream(
    events: AsyncIterable<AgentEvent>,
    replySink: ReplySink,
    context: OutputRenderContext = {},
  ): Promise<AgentEvent[]> {
    if (this.cardRenderer !== undefined && replySink.cardStreamer !== undefined) {
      return this.cardRenderer.renderStream(events, replySink, context);
    }

    if (this.streamingConfig?.mode === "ai-card" && replySink.cardStreamer === undefined) {
      this.logger.warn("AI Card streaming is configured but the reply sink has no card streamer; using Markdown fallback.", {
        taskId: context.taskId,
      });
    }

    if (this.config.progressIntervalMs > 0) {
      return this.renderStreamWithProgress(events, replySink);
    }

    const collectedEvents = await collectAgentEvents(events);
    await this.render(collectedEvents, replySink, context);
    return collectedEvents;
  }

  /**
   * Consumes the event stream while periodically flushing newly produced text so the
   * user sees intermediate progress instead of only the final reply. Each flush sends
   * only the text produced since the previous flush; intervals with no new text send
   * nothing, and any remaining text is flushed once the stream completes.
   */
  private async renderStreamWithProgress(
    events: AsyncIterable<AgentEvent>,
    replySink: ReplySink,
  ): Promise<AgentEvent[]> {
    const collectedEvents: AgentEvent[] = [];
    const accumulator = new AgentEventTextAccumulator();
    let flushedLength = 0;
    let lastFlushAt = this.now();

    for await (const event of events) {
      collectedEvents.push(event);
      accumulator.append(event, this.logger);

      if (
        accumulator.status === "running" &&
        this.now() - lastFlushAt >= this.config.progressIntervalMs
      ) {
        flushedLength = await this.flushProgress(accumulator, flushedLength, replySink);
        lastFlushAt = this.now();
      }
    }

    await this.flushFinal(accumulator, flushedLength, replySink);
    return collectedEvents;
  }

  /** Sends the text produced since the last flush and returns the new flushed length. */
  private async flushProgress(
    accumulator: AgentEventTextAccumulator,
    flushedLength: number,
    replySink: ReplySink,
  ): Promise<number> {
    const full = accumulator.toMarkdown();
    const delta = full.slice(flushedLength).trim();

    if (delta.length === 0) {
      return flushedLength;
    }

    for (const chunk of splitMarkdown(delta, this.config.maxMessageChars)) {
      await this.sendMarkdown(chunk, replySink);
    }

    return full.length;
  }

  /** Flushes any remaining text after the stream ends, using empty-output text when needed. */
  private async flushFinal(
    accumulator: AgentEventTextAccumulator,
    flushedLength: number,
    replySink: ReplySink,
  ): Promise<void> {
    const full = accumulator.toMarkdown();
    const remainder = full.slice(flushedLength).trim();

    if (remainder.length === 0) {
      if (flushedLength === 0) {
        await this.sendMarkdown(EMPTY_OUTPUT_MESSAGE, replySink);
      }
      return;
    }

    for (const chunk of splitMarkdown(remainder, this.config.maxMessageChars)) {
      await this.sendMarkdown(chunk, replySink);
    }
  }

  /** Converts an event list into user-visible Markdown message bodies. */
  private renderMessages(events: readonly AgentEvent[]): string[] {
    return renderAgentEventMessages(events, this.logger).flatMap((message) =>
      splitMarkdown(message, this.config.maxMessageChars),
    );
  }

  /** Sends a Markdown body according to the configured output mode. */
  private async sendMarkdown(markdown: string, replySink: ReplySink): Promise<void> {
    switch (this.config.mode) {
      case "markdown":
        await replySink.sendMarkdown(markdown);
        return;
    }
  }
}

async function collectAgentEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collectedEvents: AgentEvent[] = [];

  for await (const event of events) {
    collectedEvents.push(event);
  }

  return collectedEvents;
}
