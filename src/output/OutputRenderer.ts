/** Renders backend Agent events into replies for the current chat. */

import type { AgentEvent } from "../backend/types.js";
import type { OutputConfig, StreamingConfig } from "../config/types.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { CardStreamingRenderer } from "./CardStreamingRenderer.js";
import { EMPTY_OUTPUT_MESSAGE, renderAgentEventMessages } from "./renderAgentEvents.js";
import { splitMarkdown } from "./splitMarkdown.js";
import type { OutputRenderContext, ReplySink } from "./types.js";

/** Options required by the backend event renderer. */
export interface OutputRendererOptions {
  config: OutputConfig;
  streaming?: StreamingConfig;
  logger?: Logger;
}

/** Converts backend-neutral Agent events to Markdown replies. */
export class OutputRenderer {
  private readonly config: OutputConfig;
  private readonly streamingConfig: StreamingConfig | undefined;
  private readonly logger: Logger;
  private readonly cardRenderer: CardStreamingRenderer | undefined;

  public constructor(options: OutputRendererOptions) {
    this.config = options.config;
    this.streamingConfig = options.streaming;
    this.logger = options.logger ?? createLogger("output");
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

    const collectedEvents = await collectAgentEvents(events);
    await this.render(collectedEvents, replySink, context);
    return collectedEvents;
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
