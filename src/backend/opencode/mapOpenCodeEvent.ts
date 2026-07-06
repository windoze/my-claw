/** Centralized OpenCode SDK event-to-AgentEvent mapping. */

import type { Event, Part } from "@opencode-ai/sdk";

import { redactLogString } from "../../utils/logger.js";
import type { AgentEvent } from "../types.js";

/** Mutable state needed to convert cumulative text part updates into deltas. */
export interface OpenCodeEventMappingState {
  sessionId: string;
  messageRolesById: Map<string, "user" | "assistant">;
  textByPartId: Map<string, string>;
}

/** Creates event mapping state for one OpenCode prompt stream. */
export function createOpenCodeEventMappingState(sessionId: string): OpenCodeEventMappingState {
  return {
    sessionId,
    messageRolesById: new Map<string, "user" | "assistant">(),
    textByPartId: new Map<string, string>(),
  };
}

/** Maps one OpenCode event to a backend-neutral AgentEvent, or null when ignored. */
export function mapOpenCodeEvent(
  event: Event,
  state: OpenCodeEventMappingState,
): AgentEvent | null {
  switch (event.type) {
    case "message.updated":
      state.messageRolesById.set(event.properties.info.id, event.properties.info.role);
      return null;
    case "message.part.updated":
      return mapMessagePartUpdated(event, state);
    case "session.idle":
      if (event.properties.sessionID !== state.sessionId) {
        return null;
      }

      return { type: "done", sessionId: state.sessionId };
    case "session.error":
      if (
        event.properties.sessionID !== undefined &&
        event.properties.sessionID !== state.sessionId
      ) {
        return null;
      }

      return { type: "error", message: formatOpenCodeError(event.properties.error) };
    default:
      return null;
  }
}

/** Formats OpenCode API and event errors for safe user-visible AgentEvent values. */
export function formatOpenCodeError(error: unknown): string {
  return `OpenCode 执行失败：${redactLogString(describeOpenCodeError(error))}`;
}

/** Extracts text deltas from OpenCode text part updates for the active session. */
function mapMessagePartUpdated(
  event: Extract<Event, { type: "message.part.updated" }>,
  state: OpenCodeEventMappingState,
): AgentEvent | null {
  const part = event.properties.part;

  if (
    !isTextPartForSession(part, state.sessionId) ||
    state.messageRolesById.get(part.messageID) !== "assistant"
  ) {
    return null;
  }

  const previousText = state.textByPartId.get(part.id) ?? "";
  state.textByPartId.set(part.id, part.text);

  const delta =
    typeof event.properties.delta === "string"
      ? event.properties.delta
      : deriveTextDelta(part.text, previousText);

  return delta.length > 0 ? { type: "text", text: delta } : null;
}

/** Narrows OpenCode parts to text output for the current session. */
function isTextPartForSession(part: Part, sessionId: string): part is Extract<Part, { type: "text" }> {
  return part.type === "text" && part.sessionID === sessionId;
}

/** Computes an incremental delta when the SDK sends a cumulative text part. */
function deriveTextDelta(currentText: string, previousText: string): string {
  if (previousText.length === 0) {
    return currentText;
  }

  if (currentText.startsWith(previousText)) {
    return currentText.slice(previousText.length);
  }

  return currentText;
}

/** Converts known OpenCode error payloads and thrown values into concise text. */
function describeOpenCodeError(error: unknown): string {
  if (error === undefined || error === null) {
    return "会话执行失败。";
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  if (isRecord(error)) {
    const data = error.data;
    if (isRecord(data)) {
      const message = readNonEmptyString(data.message);
      if (message !== null) {
        return message;
      }
    }

    const message = readNonEmptyString(error.message);
    if (message !== null) {
      return message;
    }

    const name = readNonEmptyString(error.name);
    if (name !== null) {
      return describeOpenCodeErrorName(name);
    }
  }

  return String(error);
}

/** Provides stable fallback text for OpenCode error names without useful messages. */
function describeOpenCodeErrorName(name: string): string {
  switch (name) {
    case "MessageOutputLengthError":
      return "输出超过 OpenCode 长度限制。";
    case "MessageAbortedError":
      return "会话已中断。";
    case "ProviderAuthError":
      return "模型服务认证失败，请检查 OpenCode 登录状态。";
    case "APIError":
      return "模型服务 API 调用失败。";
    case "BadRequest":
      return "OpenCode 请求参数无效。";
    case "NotFoundError":
      return "OpenCode 会话不存在。";
    default:
      return name;
  }
}

/** Reads a non-empty string from an unknown value. */
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Checks whether an unknown value is object-like. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
