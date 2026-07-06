/** Local JSON state store with atomic writes and safe startup recovery. */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { AppError } from "../utils/errors.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { resolveUserPath } from "../utils/path.js";
import type { AppState, RuntimeState } from "./types.js";

export const DEFAULT_STATE_FILE_NAME = ".agent-dingtalk-state.json";

/** Minimal logger surface needed for recoverable state warnings. */
export type StateStoreLogger = Pick<Logger, "warn">;

/** Options for choosing the state location and warning destination. */
export interface StateStoreOptions {
  statePath?: string;
  cwd?: string;
  logger?: StateStoreLogger;
}

/** Error categories produced by state-file persistence. */
export type StateStoreErrorCode =
  | "STATE_READ_FAILED"
  | "STATE_WRITE_FAILED"
  | "STATE_BACKUP_FAILED";

/** Error raised when state cannot be read, written, or backed up. */
export class StateStoreError extends AppError {
  public readonly code: StateStoreErrorCode;
  public readonly statePath: string;

  public constructor(
    code: StateStoreErrorCode,
    message: string,
    statePath: string,
    cause?: unknown,
  ) {
    super(code, message, { cause });
    this.name = "StateStoreError";
    this.code = code;
    this.statePath = statePath;
  }
}

const nonEmptyStringSchema = z.string().min(1);
const agentBackendSchema = z.literal("claude-code");

const sessionStateSchema = z
  .object({
    sessionId: nonEmptyStringSchema.nullable().default(null),
  })
  .strict();

const activeProjectStateSchema = z
  .object({
    backend: agentBackendSchema,
    cwd: nonEmptyStringSchema,
    agent: nonEmptyStringSchema.optional(),
    model: nonEmptyStringSchema.optional(),
  })
  .strict();

const knownProjectStateSchema = activeProjectStateSchema
  .extend({
    sessionId: nonEmptyStringSchema.nullable().default(null),
  })
  .strict();

const runtimeTaskStateSchema = z
  .object({
    backend: agentBackendSchema,
    cwd: nonEmptyStringSchema,
    messageId: nonEmptyStringSchema.optional(),
    startedAt: nonEmptyStringSchema.optional(),
  })
  .strict();

const runtimeStateSchema = z
  .object({
    status: z.enum(["idle", "running", "stopping"]).default("idle"),
    currentTask: runtimeTaskStateSchema.nullable().default(null),
  })
  .strict();

const appStateSchema = z
  .object({
    activeProject: activeProjectStateSchema.nullable().default(null),
    defaultSession: sessionStateSchema.default({ sessionId: null }),
    knownProjects: z.record(z.string(), knownProjectStateSchema).default({}),
    runtime: runtimeStateSchema.default({ status: "idle", currentTask: null }),
  })
  .strict();

/** Creates a fresh empty state object for first run or corrupt-state recovery. */
export function createDefaultAppState(): AppState {
  return {
    activeProject: null,
    defaultSession: { sessionId: null },
    knownProjects: {},
    runtime: createIdleRuntimeState(),
  };
}

/** Returns a runtime state that is safe immediately after process startup. */
export function createIdleRuntimeState(): RuntimeState {
  return {
    status: "idle",
    currentTask: null,
  };
}

/** Resets volatile runtime fields while preserving durable project and session data. */
export function resetRuntimeForStartup(state: AppState): AppState {
  return {
    ...state,
    runtime: createIdleRuntimeState(),
  };
}

/** Persists and recovers the gateway state file under the project root by default. */
export class StateStore {
  public readonly statePath: string;

  private readonly tmpPath: string;
  private readonly logger: StateStoreLogger;

  public constructor(options: StateStoreOptions = {}) {
    this.statePath = resolveStatePath(options);
    this.tmpPath = `${this.statePath}.tmp`;
    this.logger = options.logger ?? createLogger("state");
  }

  /** Reads state for process startup and persists an idle runtime recovery if needed. */
  public async load(): Promise<AppState> {
    const state = await this.read();
    const recoveredState = resetRuntimeForStartup(state);

    if (!isSameRuntime(state.runtime, recoveredState.runtime)) {
      await this.save(recoveredState);
    }

    return recoveredState;
  }

  /** Reads the current persisted state, creating or repairing the file when necessary. */
  public async read(): Promise<AppState> {
    let source: string;

    try {
      source = await readFile(this.statePath, "utf8");
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        const defaultState = createDefaultAppState();
        await this.save(defaultState);
        return defaultState;
      }

      throw new StateStoreError(
        "STATE_READ_FAILED",
        `Unable to read state file: ${this.statePath}`,
        this.statePath,
        error,
      );
    }

    const parsedState = parseStateSource(source);

    if (!parsedState.ok) {
      await this.backupInvalidState(parsedState.reason);
      const defaultState = createDefaultAppState();
      await this.save(defaultState);
      return defaultState;
    }

    return parsedState.state;
  }

  /** Writes a complete state snapshot through a temporary file followed by rename. */
  public async save(state: AppState): Promise<void> {
    const validatedState = validateStateForWrite(state, this.statePath);
    const serializedState = `${JSON.stringify(validatedState, null, 2)}\n`;

    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await writeFile(this.tmpPath, serializedState, { encoding: "utf8", mode: 0o600 });
      await rename(this.tmpPath, this.statePath);
    } catch (error: unknown) {
      throw new StateStoreError(
        "STATE_WRITE_FAILED",
        `Unable to write state file atomically: ${this.statePath}`,
        this.statePath,
        error,
      );
    }
  }

  /** Applies a state mutation and persists the resulting snapshot atomically. */
  public async update(updater: (state: AppState) => AppState | Promise<AppState>): Promise<AppState> {
    const currentState = await this.read();
    const nextState = await updater(currentState);
    await this.save(nextState);

    return nextState;
  }

  /** Moves an unreadable state file aside and records a warning with the backup path. */
  private async backupInvalidState(reason: string): Promise<void> {
    const backupPath = createBackupPath(this.statePath);

    try {
      await rename(this.statePath, backupPath);
    } catch (error: unknown) {
      throw new StateStoreError(
        "STATE_BACKUP_FAILED",
        `Unable to back up invalid state file: ${this.statePath}`,
        this.statePath,
        error,
      );
    }

    this.logger.warn(
      `State file was invalid and has been backed up to ${backupPath}. A default state file was created. Reason: ${reason}`,
    );
  }
}

interface ParsedStateResult {
  ok: true;
  state: AppState;
}

interface InvalidStateResult {
  ok: false;
  reason: string;
}

/** Resolves the state file path from options or the default project-root location. */
function resolveStatePath(options: StateStoreOptions): string {
  const cwd = options.cwd ?? process.cwd();
  const configuredPath = options.statePath ?? DEFAULT_STATE_FILE_NAME;

  return resolveUserPath(configuredPath, cwd);
}

/** Parses and validates the JSON state source without throwing for data problems. */
function parseStateSource(source: string): ParsedStateResult | InvalidStateResult {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(source);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `JSON parse error: ${reason}` };
  }

  const result = appStateSchema.safeParse(parsedJson);

  if (!result.success) {
    return {
      ok: false,
      reason: `State validation error: ${formatValidationIssues(result.error).join("; ")}`,
    };
  }

  return { ok: true, state: result.data };
}

/** Validates outbound state so only supported, JSON-safe shapes are persisted. */
function validateStateForWrite(state: AppState, statePath: string): AppState {
  const result = appStateSchema.safeParse(state);

  if (!result.success) {
    throw new StateStoreError(
      "STATE_WRITE_FAILED",
      `Refusing to write invalid state: ${formatValidationIssues(result.error).join("; ")}`,
      statePath,
      result.error,
    );
  }

  return result.data;
}

/** Formats Zod issues with stable field paths for diagnostics. */
function formatValidationIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const pathText = issue.path.length === 0 ? "<root>" : issue.path.join(".");
    return `${pathText}: ${issue.message}`;
  });
}

/** Builds a timestamped backup path next to the original state file. */
function createBackupPath(statePath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${statePath}.bak.${timestamp}`;
}

/** Compares runtime snapshots to avoid unnecessary startup rewrites. */
function isSameRuntime(left: RuntimeState, right: RuntimeState): boolean {
  return left.status === right.status && left.currentTask === right.currentTask;
}

/** Checks Node filesystem errors without assuming every thrown value is an Error. */
function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
