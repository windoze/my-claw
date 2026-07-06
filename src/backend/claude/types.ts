/** Claude Code backend-specific session metadata. */

import type { BackendSession } from "../types.js";
import type { AgentEnvironment } from "../../session/types.js";

/** Metadata retained so a backend session can be translated back to SDK options. */
export interface ClaudeCodeSessionMetadata {
  environment: AgentEnvironment;
}

/** Backend session returned by ClaudeCodeAdapter.open(). */
export interface ClaudeCodeBackendSession extends BackendSession {
  backend: "claude-code";
  raw: ClaudeCodeSessionMetadata;
}
