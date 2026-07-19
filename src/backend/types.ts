/** Backend-facing Agent input, session, adapter, and event contracts. */

import type { AgentBackend } from "../config/types.js";
import type { IncomingMessageAttachment } from "../messages/types.js";
import type { AgentEnvironment } from "../session/types.js";

/** Prompt input sent to an Agent backend for one inbound message. */
export interface AgentInput {
  text: string;
  messageId?: string;
  attachments?: IncomingMessageAttachment[];
  permissionHandler?: AgentPermissionHandler;
}

/** Backend-neutral request shown to a user before a tool is allowed to run. */
export interface AgentPermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  requestId: string;
  toolUseId: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  signal: AbortSignal;
}

/** User decision returned to a backend permission callback. */
export type AgentPermissionDecision =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
    }
  | {
      behavior: "deny";
      message?: string;
      interrupt?: boolean;
    };

/** Handles a backend tool-permission request through the active chat. */
export type AgentPermissionHandler = (
  request: AgentPermissionRequest,
) => Promise<AgentPermissionDecision>;

/** Runtime handle returned by a backend after opening an Agent environment. */
export interface BackendSession {
  backend: AgentBackend;
  cwd: string;
  sessionId?: string;
  raw?: unknown;
}

/** Common interface implemented by Claude Code and future Agent backends. */
export interface BackendAdapter {
  open(environment: AgentEnvironment): BackendSession | Promise<BackendSession>;
  send(session: BackendSession, input: AgentInput): AsyncIterable<AgentEvent>;
  stop(session: BackendSession): void | Promise<void>;
  close(session: BackendSession): void | Promise<void>;
  /**
   * Pushes a follow-up prompt into a running task so the agent can change
   * direction mid-turn ("pivot"). Returns true when the live task accepted the
   * input. Backends that cannot interject leave this undefined.
   */
  interject?(session: BackendSession, input: AgentInput): boolean;
}

/** Incremental text produced by a backend before final completion. */
export interface AgentTextEvent {
  type: "text";
  text: string;
}

/** Backend completion event, optionally carrying final output and session state. */
export interface AgentDoneEvent {
  type: "done";
  result?: string;
  sessionId?: string;
}

/** User-safe backend failure summary for rendering and routing decisions. */
export interface AgentErrorEvent {
  type: "error";
  message: string;
}

/** Backend interruption result after a user requested `/stop`. */
export interface AgentStoppedEvent {
  type: "stopped";
  message?: string;
  sessionId?: string;
}

/** Tool invocation start event reserved for logging and progress output. */
export interface AgentToolStartEvent {
  type: "tool_start";
  name: string;
  input?: unknown;
  title?: string;
  kind?: string;
  status?: AgentToolStatus;
}

/** Tool invocation completion event reserved for logging and progress output. */
export interface AgentToolFinishEvent {
  type: "tool_finish";
  name: string;
  output?: string;
  status?: AgentToolStatus;
}

/** Execution status reported by a backend for a tool call. */
export type AgentToolStatus = "pending" | "in_progress" | "completed" | "failed";

/** Incremental reasoning ("thinking") text produced by a backend. */
export interface AgentThoughtEvent {
  type: "thought";
  text: string;
}

/** Status of a single plan entry, mirroring the ACP plan entry statuses. */
export type AgentPlanEntryStatus = "pending" | "in_progress" | "completed";

/** One task in a backend-reported execution plan. */
export interface AgentPlanEntry {
  content: string;
  status: AgentPlanEntryStatus;
  priority?: string;
}

/** A full execution-plan snapshot; each event replaces the previous plan. */
export interface AgentPlanEvent {
  type: "plan";
  entries: AgentPlanEntry[];
}

/** Gateway-injected informational note shown inline between agent output. */
export interface AgentNoticeEvent {
  type: "notice";
  text: string;
}

/** Events emitted by Agent backends and consumed by output renderers. */
export type AgentEvent =
  | AgentTextEvent
  | AgentDoneEvent
  | AgentErrorEvent
  | AgentStoppedEvent
  | AgentToolStartEvent
  | AgentToolFinishEvent
  | AgentThoughtEvent
  | AgentPlanEvent
  | AgentNoticeEvent;
