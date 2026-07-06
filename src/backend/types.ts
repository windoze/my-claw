/** Backend-facing Agent input and event contracts. */

/** Prompt input sent to an Agent backend for one inbound message. */
export interface AgentInput {
  text: string;
  messageId: string;
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
}

/** Tool invocation start event reserved for logging and future progress output. */
export interface AgentToolStartEvent {
  type: "tool_start";
  name: string;
  input?: unknown;
}

/** Tool invocation completion event reserved for logging and future progress output. */
export interface AgentToolFinishEvent {
  type: "tool_finish";
  name: string;
  output?: string;
}

/** Events emitted by Agent backends and consumed by output renderers. */
export type AgentEvent =
  | AgentTextEvent
  | AgentDoneEvent
  | AgentErrorEvent
  | AgentStoppedEvent
  | AgentToolStartEvent
  | AgentToolFinishEvent;
