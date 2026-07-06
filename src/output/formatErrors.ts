/** User-facing error formatting helpers for Agent output rendering. */

import type { AgentErrorEvent } from "../backend/types.js";

const UNKNOWN_AGENT_ERROR = "未知错误";

/** Formats a backend error event for Markdown output. */
export function formatAgentErrorEvent(event: AgentErrorEvent): string {
  return formatAgentErrorMessage(event.message);
}

/** Formats a backend error message with the stable user-facing prefix. */
export function formatAgentErrorMessage(message: string): string {
  const safeMessage = message.trim().length > 0 ? message.trim() : UNKNOWN_AGENT_ERROR;
  return `执行失败：${safeMessage}`;
}

/** Formats an unknown thrown value for callers that need the same output convention. */
export function formatUnknownAgentError(error: unknown): string {
  if (error instanceof Error) {
    return formatAgentErrorMessage(error.message);
  }

  if (typeof error === "string") {
    return formatAgentErrorMessage(error);
  }

  return formatAgentErrorMessage(UNKNOWN_AGENT_ERROR);
}
