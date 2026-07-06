/** Shared accumulation of backend Agent events into user-visible Markdown text. */

import type { AgentEvent } from "../backend/types.js";
import type { Logger } from "../utils/logger.js";
import { formatAgentErrorEvent } from "./formatErrors.js";

export const EMPTY_OUTPUT_MESSAGE = "任务已完成，但没有文本输出。";
export const DEFAULT_STOPPED_MESSAGE = "当前 Agent 任务已中断。";

export type AgentEventTerminalStatus = "running" | "done" | "stopped" | "error";

/** Incrementally converts backend events to the same Markdown used by final replies. */
export class AgentEventTextAccumulator {
  private readonly messages: string[] = [];
  private readonly textParts: string[] = [];

  public status: AgentEventTerminalStatus = "running";
  public sessionId: string | undefined;

  /** Adds one backend event to the current Markdown snapshot. */
  public append(event: AgentEvent, logger?: Logger): void {
    switch (event.type) {
      case "text":
        this.textParts.push(event.text);
        return;
      case "done":
        appendDoneResult(this.textParts, event.result);
        this.status = "done";
        this.sessionId = event.sessionId;
        return;
      case "error":
        this.flushTextParts();
        this.messages.push(formatAgentErrorEvent(event));
        this.status = "error";
        return;
      case "stopped":
        this.flushTextParts();
        this.messages.push(event.message ?? DEFAULT_STOPPED_MESSAGE);
        this.status = "stopped";
        this.sessionId = event.sessionId;
        return;
      case "tool_start":
        logger?.debug("Agent tool started.", { tool: event.name });
        return;
      case "tool_finish":
        logger?.debug("Agent tool finished.", { tool: event.name });
        return;
    }
  }

  /** Returns non-empty finalized Markdown message bodies without mutating the accumulator. */
  public toMessages(): string[] {
    return snapshotMessages(this.messages, this.textParts);
  }

  /** Returns the current Markdown body, using the standard empty-output text when requested. */
  public toMarkdown(options: { includeEmpty: boolean } = { includeEmpty: false }): string {
    const messages = this.toMessages();

    if (messages.length === 0 && options.includeEmpty) {
      return EMPTY_OUTPUT_MESSAGE;
    }

    return messages.join("\n\n");
  }

  private flushTextParts(): void {
    const text = this.textParts.join("").trimEnd();
    this.textParts.length = 0;

    if (text.trim().length > 0) {
      this.messages.push(text);
    }
  }
}

/** Converts a collected event list into final Markdown message bodies. */
export function renderAgentEventMessages(
  events: readonly AgentEvent[],
  logger?: Logger,
): string[] {
  const accumulator = new AgentEventTextAccumulator();

  for (const event of events) {
    accumulator.append(event, logger);
  }

  return accumulator.toMessages();
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

function snapshotMessages(messages: readonly string[], textParts: readonly string[]): string[] {
  const snapshot = [...messages];
  const text = textParts.join("").trimEnd();

  if (text.trim().length > 0) {
    snapshot.push(text);
  }

  return snapshot;
}
