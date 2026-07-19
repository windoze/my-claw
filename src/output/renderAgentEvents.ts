/** Shared accumulation of backend Agent events into user-visible Markdown text. */

import type { AgentEvent, AgentPlanEntry } from "../backend/types.js";
import type { Logger } from "../utils/logger.js";
import { formatAgentErrorEvent } from "./formatErrors.js";

export const EMPTY_OUTPUT_MESSAGE = "任务已完成，但没有文本输出。";
export const DEFAULT_STOPPED_MESSAGE = "当前 Agent 任务已中断。";

export type AgentEventTerminalStatus = "running" | "done" | "stopped" | "error";

/** Incrementally converts backend events to the same Markdown used by final replies. */
export class AgentEventTextAccumulator {
  private readonly messages: string[] = [];
  private readonly textParts: string[] = [];
  private readonly thoughtParts: string[] = [];
  private lastPlanMarkdown: string | undefined;

  public status: AgentEventTerminalStatus = "running";
  public sessionId: string | undefined;

  /**
   * Adds one backend event to the current Markdown snapshot.
   *
   * Text and thought chunks accumulate into separate "runs"; switching between
   * them (or reaching a terminal event) flushes the active run into a finalized
   * block, so the snapshot preserves arrival order while staying append-only for
   * the delta-based streaming flush.
   */
  public append(event: AgentEvent, logger?: Logger): void {
    switch (event.type) {
      case "text":
        this.flushThoughtParts();
        this.textParts.push(event.text);
        return;
      case "thought":
        this.flushTextParts();
        this.thoughtParts.push(event.text);
        return;
      case "plan":
        this.appendPlan(event.entries);
        return;
      case "notice":
        this.flushTextParts();
        this.flushThoughtParts();
        this.messages.push(event.text);
        return;
      case "done":
        this.flushThoughtParts();
        appendDoneResult(this.textParts, event.result);
        this.status = "done";
        this.sessionId = event.sessionId;
        return;
      case "error":
        this.flushThoughtParts();
        this.flushTextParts();
        this.messages.push(formatAgentErrorEvent(event));
        this.status = "error";
        return;
      case "stopped":
        this.flushThoughtParts();
        this.flushTextParts();
        this.messages.push(event.message ?? DEFAULT_STOPPED_MESSAGE);
        this.status = "stopped";
        this.sessionId = event.sessionId;
        return;
      case "tool_start":
        logger?.debug("Agent tool started.", { tool: event.name, status: event.status });
        return;
      case "tool_finish":
        logger?.debug("Agent tool finished.", { tool: event.name, status: event.status });
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

  /**
   * Appends a plan snapshot as a new finalized block when it differs from the
   * last one. ACP sends the full plan on every update; keeping the accumulator
   * append-only (rather than replacing an earlier block) preserves the
   * monotonic-growth invariant the streaming delta flush relies on.
   */
  private appendPlan(entries: readonly AgentPlanEntry[]): void {
    const planMarkdown = formatPlanMarkdown(entries);

    if (planMarkdown.length === 0 || planMarkdown === this.lastPlanMarkdown) {
      return;
    }

    this.flushTextParts();
    this.flushThoughtParts();
    this.messages.push(planMarkdown);
    this.lastPlanMarkdown = planMarkdown;
  }

  private flushTextParts(): void {
    const text = this.textParts.join("").trimEnd();
    this.textParts.length = 0;

    if (text.trim().length > 0) {
      this.messages.push(text);
    }
  }

  private flushThoughtParts(): void {
    const thought = this.thoughtParts.join("").trim();
    this.thoughtParts.length = 0;

    if (thought.length > 0) {
      this.messages.push(formatThoughtMarkdown(thought));
    }
  }
}

/** Renders accumulated reasoning text as a Markdown blockquote with a marker. */
function formatThoughtMarkdown(thought: string): string {
  const quoted = thought
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `> 💭 **思考**\n${quoted}`;
}

/** Renders a plan snapshot as a Markdown checklist with per-entry status icons. */
function formatPlanMarkdown(entries: readonly AgentPlanEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  const lines = entries.map((entry) => `${planStatusIcon(entry.status)} ${entry.content}`);
  return ["📋 **执行计划**", ...lines].join("\n");
}

/** Maps a plan entry status to a checklist icon. */
function planStatusIcon(status: AgentPlanEntry["status"]): string {
  switch (status) {
    case "completed":
      return "- [x]";
    case "in_progress":
      return "- [~]";
    case "pending":
      return "- [ ]";
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
