/** Renders backend Agent events into replies for the current chat. */

import type { AgentEvent } from "../backend/types.js";
import type { OutputConfig } from "../config/types.js";
import { createLogger, type Logger } from "../utils/logger.js";
import type { ReplySink } from "./types.js";

const EMPTY_OUTPUT_MESSAGE = "任务已完成，但没有文本输出。";
const DEFAULT_STOPPED_MESSAGE = "当前 Agent 任务已中断。";

/** Options required by the backend event renderer. */
export interface OutputRendererOptions {
  config: OutputConfig;
  logger?: Logger;
}

/** Converts backend-neutral Agent events to Markdown replies. */
export class OutputRenderer {
  private readonly config: OutputConfig;
  private readonly logger: Logger;

  public constructor(options: OutputRendererOptions) {
    this.config = options.config;
    this.logger = options.logger ?? createLogger("output");
  }

  /** Renders all collected events to the supplied reply sink. */
  public async render(events: readonly AgentEvent[], replySink: ReplySink): Promise<void> {
    const messages = this.renderMessages(events);

    if (messages.length === 0) {
      await this.sendMarkdown(EMPTY_OUTPUT_MESSAGE, replySink);
      return;
    }

    for (const message of messages) {
      await this.sendMarkdown(message, replySink);
    }
  }

  /** Converts an event list into user-visible Markdown message bodies. */
  private renderMessages(events: readonly AgentEvent[]): string[] {
    const messages: string[] = [];
    const textParts: string[] = [];

    for (const event of events) {
      switch (event.type) {
        case "text":
          textParts.push(event.text);
          break;
        case "done":
          appendDoneResult(textParts, event.result);
          break;
        case "error":
          flushTextParts(textParts, messages);
          messages.push(`执行失败：${event.message}`);
          break;
        case "stopped":
          flushTextParts(textParts, messages);
          messages.push(event.message ?? DEFAULT_STOPPED_MESSAGE);
          break;
        case "tool_start":
          this.logger.debug("Agent tool started.", { tool: event.name });
          break;
        case "tool_finish":
          this.logger.debug("Agent tool finished.", { tool: event.name });
          break;
      }
    }

    flushTextParts(textParts, messages);
    return messages.flatMap((message) => splitByConfiguredLimit(message, this.config.maxMessageChars));
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

/** Adds a final result after streamed text without merging unrelated paragraphs. */
function appendDoneResult(textParts: string[], result: string | undefined): void {
  if (result === undefined || result.trim().length === 0) {
    return;
  }

  if (textParts.join("").trim().length > 0) {
    textParts.push("\n\n");
  }

  textParts.push(result);
}

/** Moves accumulated text into the outgoing message list when it contains content. */
function flushTextParts(textParts: string[], messages: string[]): void {
  const text = textParts.join("").trimEnd();
  textParts.length = 0;

  if (text.trim().length > 0) {
    messages.push(text);
  }
}

/** Applies the configured hard limit until richer Markdown-aware splitting is added. */
function splitByConfiguredLimit(message: string, maxMessageChars: number): string[] {
  const limit = Math.max(1, maxMessageChars);

  if (message.length <= limit) {
    return [message];
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < message.length; offset += limit) {
    chunks.push(message.slice(offset, offset + limit));
  }

  return chunks;
}
