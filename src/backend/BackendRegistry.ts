/** Registry that resolves the configured Agent backend to its adapter. */

import type { AgentBackend } from "../config/types.js";
import { UserFacingError } from "../utils/errors.js";
import type { BackendAdapter } from "./types.js";

/** Initial adapter entries accepted by BackendRegistry. */
export type BackendRegistryEntries = Iterable<readonly [AgentBackend, BackendAdapter]>;

/** Minimal environment shape needed for adapter lookup. */
export interface BackendSelection {
  backend: string;
}

/** User-facing error categories raised by backend selection. */
export type BackendRegistryErrorCode = "BACKEND_UNSUPPORTED";

/** Maps backend names from the active environment to concrete adapters. */
export class BackendRegistry {
  private readonly adapters = new Map<string, BackendAdapter>();

  public constructor(entries: BackendRegistryEntries = []) {
    for (const [backend, adapter] of entries) {
      this.register(backend, adapter);
    }
  }

  /** Registers or replaces the adapter for one backend name. */
  public register(backend: AgentBackend, adapter: BackendAdapter): this {
    this.adapters.set(backend, adapter);
    return this;
  }

  /** Returns true when an adapter is registered for the backend name. */
  public has(backend: AgentBackend): boolean {
    return this.adapters.has(backend);
  }

  /** Resolves the adapter for an environment or throws a user-safe unsupported-backend error. */
  public get(environment: BackendSelection): BackendAdapter {
    const adapter = this.adapters.get(environment.backend);

    if (adapter === undefined) {
      throw new UserFacingError(
        "BACKEND_UNSUPPORTED",
        `当前不支持 Agent 后端：${environment.backend}。请检查配置或后端注册状态。`,
      );
    }

    return adapter;
  }
}
