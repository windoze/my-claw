/** Persistent application state shared by session and backend runtime modules. */

import type { AgentBackend } from "../config/types.js";

/** Runtime task status persisted so restarts can recover safely. */
export type RuntimeStatus = "idle" | "running" | "stopping";

/** Stored backend session metadata for an environment. */
export interface SessionState {
  sessionId: string | null;
}

/** Project environment currently opened by a slash command. */
export interface ActiveProjectState {
  backend: AgentBackend;
  cwd: string;
  agent?: string;
  model?: string;
  /** ACP provider name; only set when backend is `acp`. */
  provider?: string;
}

/** Known project metadata retained after a project is closed. */
export interface KnownProjectState extends ActiveProjectState, SessionState {}

/** Persisted summary of the currently running task, if any. */
export interface RuntimeTaskState {
  backend: AgentBackend;
  cwd: string;
  provider?: string;
  messageId?: string;
  startedAt?: string;
}

/** Runtime state used to reject or interrupt concurrent work. */
export interface RuntimeState {
  status: RuntimeStatus;
  currentTask: RuntimeTaskState | null;
}

/** Complete JSON-serializable state written to the local state file. */
export interface AppState {
  activeProject: ActiveProjectState | null;
  defaultSession: SessionState;
  knownProjects: Record<string, KnownProjectState>;
  runtime: RuntimeState;
}

