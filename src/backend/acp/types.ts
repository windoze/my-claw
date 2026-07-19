/** ACP backend-specific session and connection lifecycle metadata. */

import type { AgentEnvironment } from "../../session/types.js";
import type { AgentInput, BackendSession } from "../types.js";

/** Stable backend name used by ACP environments and sessions. */
export const ACP_BACKEND = "acp" as const;

/** Metadata retained for ACP sessions opened by the adapter. */
export interface AcpSessionMetadata {
  environment: AgentEnvironment;
}

/** Backend session returned by AcpAdapter.open(). */
export interface AcpBackendSession extends BackendSession {
  backend: typeof ACP_BACKEND;
  raw: AcpSessionMetadata;
}

/**
 * Pushes a follow-up prompt into a live ACP task so the agent can change
 * direction mid-turn. Returns true when the running task accepted the input.
 */
export type AcpInterjector = (input: AgentInput) => boolean;
