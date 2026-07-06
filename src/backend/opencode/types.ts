/** OpenCode backend-specific session and SDK lifecycle metadata. */

import type { OpencodeClient, ServerOptions } from "@opencode-ai/sdk";

import type { AgentEnvironment } from "../../session/types.js";
import type { BackendSession } from "../types.js";

/** Stable backend name used by OpenCode environments and sessions. */
export const OPEN_CODE_BACKEND = "opencode" as const;

/** Handle returned by the OpenCode SDK for a process-local server. */
export interface OpenCodeServerHandle {
  url: string;
  close(): void;
}

/** Minimal runtime returned by `createOpencode()` and accepted by focused checks. */
export interface OpenCodeRuntime {
  client: OpencodeClient;
  server: OpenCodeServerHandle;
}

/** Injectable factory used by production code and focused adapter checks. */
export type CreateOpenCodeFunction = (options?: ServerOptions) => Promise<OpenCodeRuntime>;

/** Metadata retained for OpenCode sessions opened by the adapter. */
export interface OpenCodeSessionMetadata {
  environment: AgentEnvironment;
  serverUrl: string;
}

/** Backend session returned by OpenCodeAdapter.open(). */
export interface OpenCodeBackendSession extends BackendSession {
  backend: typeof OPEN_CODE_BACKEND;
  raw: OpenCodeSessionMetadata;
}
