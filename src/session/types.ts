/** Runtime Agent environment contracts shared by session and backend modules. */

import type { AgentBackend } from "../config/types.js";

/** Distinguishes the configured default environment from a slash-command project. */
export type AgentEnvironmentKind = "default" | "project";

/** Fully resolved Agent execution environment selected for a user message. */
export interface AgentEnvironment {
  backend: AgentBackend;
  cwd: string;
  agent?: string;
  model?: string;
  sessionId?: string;
  kind: AgentEnvironmentKind;
}
