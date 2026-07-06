/** Coordinates Agent environment selection, project state, and runtime concurrency rules. */

import type { AppConfig, AgentEnvironmentConfig } from "../config/types.js";
import { PathPolicy } from "../security/PathPolicy.js";
import { StateStore } from "../state/StateStore.js";
import type {
  ActiveProjectState,
  AppState,
  KnownProjectState,
  RuntimeStatus,
  RuntimeTaskState,
} from "../state/types.js";
import { UserFacingError } from "../utils/errors.js";
import type { AgentEnvironment } from "./types.js";

const PROJECT_BUSY_MESSAGE =
  "当前有任务正在运行，不能切换项目。请先使用 /stop 或等待任务完成。";
const PROJECT_STOPPING_MESSAGE = "当前任务正在中断，暂时不能切换项目。";

/** Commands whose availability is decided by the session state machine. */
export type StatefulCommandName = "cc" | "close" | "state" | "stop";

/** User-safe session manager error categories. */
export type SessionManagerErrorCode =
  | "SESSION_PROJECT_BUSY"
  | "SESSION_PROJECT_STOPPING"
  | "SESSION_TASK_BUSY"
  | "SESSION_TASK_STOPPING"
  | "SESSION_NO_RUNNING_TASK";

/** User-facing error thrown when a state transition is rejected. */
export class SessionManagerError extends UserFacingError {
  public readonly code: SessionManagerErrorCode;

  public constructor(code: SessionManagerErrorCode, message: string) {
    super(code, message);
    this.name = "SessionManagerError";
    this.code = code;
  }
}

/** Options required to construct the session manager directly. */
export interface SessionManagerOptions {
  config: AppConfig;
  stateStore: StateStore;
  pathPolicy: PathPolicy;
  pathBaseDir?: string;
  now?: () => Date;
}

/** Options for building a session manager and path policy from validated config. */
export interface CreateSessionManagerOptions extends Omit<SessionManagerOptions, "pathPolicy"> {
  pathPolicy?: PathPolicy;
}

/** Result returned after opening a Claude Code project directory. */
export interface OpenProjectResult {
  environment: AgentEnvironment;
  state: AppState;
}

/** Result returned after closing the active project. */
export interface CloseProjectResult {
  environment: AgentEnvironment;
  closedProject: SessionEnvironmentSummary | null;
  state: AppState;
}

/** Sanitized environment summary safe to render in `/state`. */
export interface SessionEnvironmentSummary {
  kind: AgentEnvironment["kind"];
  backend: AgentEnvironment["backend"];
  cwd: string;
  agent?: string;
  model?: string;
  sessionId: string | null;
}

/** Sanitized runtime task summary safe to render in `/state`. */
export interface RuntimeTaskSummary {
  backend: RuntimeTaskState["backend"];
  cwd: string;
  messageId?: string;
  startedAt?: string;
}

/** Sanitized runtime summary safe to render in `/state`. */
export interface RuntimeSummary {
  status: RuntimeStatus;
  currentTask: RuntimeTaskSummary | null;
}

/** Complete state summary for command handlers without secrets or raw configuration. */
export interface SessionStateSummary {
  runtime: RuntimeSummary;
  currentEnvironment: SessionEnvironmentSummary;
  defaultEnvironment: SessionEnvironmentSummary;
  activeProject: SessionEnvironmentSummary | null;
  knownProjects: SessionEnvironmentSummary[];
  canAcceptNormalMessage: boolean;
}

/** `/stop` state-layer decision before a backend stop callback is invoked. */
export type StopState =
  | {
      status: "idle";
      canRequestStop: false;
      message: string;
    }
  | {
      status: "running";
      canRequestStop: true;
      currentTask: RuntimeTaskSummary | null;
    }
  | {
      status: "stopping";
      canRequestStop: false;
      message: string;
    };

/** Runtime task metadata accepted when marking an Agent request as running. */
export interface StartTaskOptions {
  messageId?: string;
  startedAt?: Date | string;
}

/** Builds a SessionManager, creating the path policy from validated config when omitted. */
export async function createSessionManager(
  options: CreateSessionManagerOptions,
): Promise<SessionManager> {
  const pathPolicy =
    options.pathPolicy ??
    (await PathPolicy.create(options.config.security.allowedRootDirs, {
      baseDir: options.pathBaseDir,
    }));

  return new SessionManager({
    ...options,
    pathPolicy,
  });
}

/** Manages persisted project selection and runtime status transitions. */
export class SessionManager {
  private readonly config: AppConfig;
  private readonly stateStore: StateStore;
  private readonly pathPolicy: PathPolicy;
  private readonly pathBaseDir?: string;
  private readonly now: () => Date;

  public constructor(options: SessionManagerOptions) {
    this.config = options.config;
    this.stateStore = options.stateStore;
    this.pathPolicy = options.pathPolicy;
    this.pathBaseDir = options.pathBaseDir;
    this.now = options.now ?? (() => new Date());
  }

  /** Returns the active project environment, or the configured default environment. */
  public async getCurrentEnvironment(): Promise<AgentEnvironment> {
    const state = await this.stateStore.read();
    return this.buildCurrentEnvironment(state);
  }

  /** Opens a Claude Code project directory after enforcing idle status and path allowlisting. */
  public async openClaudeProject(dir: string): Promise<OpenProjectResult> {
    const existingState = await this.stateStore.read();
    assertProjectMutationAllowed(existingState.runtime.status);

    const realDir = await this.pathPolicy.assertAllowedDir(dir, { baseDir: this.pathBaseDir });
    const state = await this.stateStore.update((currentState) => {
      assertProjectMutationAllowed(currentState.runtime.status);

      const knownProject = this.buildKnownProject(realDir, currentState);
      return {
        ...currentState,
        activeProject: toActiveProjectState(knownProject),
        knownProjects: {
          ...currentState.knownProjects,
          [realDir]: knownProject,
        },
      };
    });

    return {
      environment: this.buildCurrentEnvironment(state),
      state,
    };
  }

  /** Closes the active project while preserving its known project session metadata. */
  public async closeProject(): Promise<CloseProjectResult> {
    let closedProject: SessionEnvironmentSummary | null = null;
    const state = await this.stateStore.update((currentState) => {
      assertProjectMutationAllowed(currentState.runtime.status);

      closedProject = currentState.activeProject
        ? summarizeProjectEnvironment(currentState.activeProject, currentState.knownProjects)
        : null;

      if (currentState.activeProject === null) {
        return currentState;
      }

      return {
        ...currentState,
        activeProject: null,
      };
    });

    return {
      environment: this.buildCurrentEnvironment(state),
      closedProject,
      state,
    };
  }

  /** Returns a sanitized snapshot suitable for `/state` replies. */
  public async getStateSummary(): Promise<SessionStateSummary> {
    const state = await this.stateStore.read();
    return this.buildStateSummary(state);
  }

  /** Returns true only when ordinary non-command messages may start backend work. */
  public async canAcceptNormalMessage(): Promise<boolean> {
    const state = await this.stateStore.read();
    return state.runtime.status === "idle";
  }

  /** Returns whether a stateful slash command may proceed under the current runtime status. */
  public async canAcceptCommand(commandName: StatefulCommandName): Promise<boolean> {
    if (commandName === "state" || commandName === "stop") {
      return true;
    }

    const state = await this.stateStore.read();
    return state.runtime.status === "idle";
  }

  /** Reports the `/stop` decision without mutating state. */
  public async getStopState(): Promise<StopState> {
    const state = await this.stateStore.read();

    switch (state.runtime.status) {
      case "idle":
        return {
          status: "idle",
          canRequestStop: false,
          message: "当前没有正在运行的任务。",
        };
      case "running":
        return {
          status: "running",
          canRequestStop: true,
          currentTask: summarizeRuntimeTask(state.runtime.currentTask),
        };
      case "stopping":
        return {
          status: "stopping",
          canRequestStop: false,
          message: "任务正在中断，请稍候。",
        };
    }
  }

  /** Marks the current environment as running a backend task and persists the transition. */
  public async startTask(options: StartTaskOptions = {}): Promise<AppState> {
    return this.stateStore.update((currentState) => {
      if (currentState.runtime.status === "running") {
        throw new SessionManagerError(
          "SESSION_TASK_BUSY",
          "当前已有任务正在运行，请等待完成后再发送新消息。",
        );
      }

      if (currentState.runtime.status === "stopping") {
        throw new SessionManagerError(
          "SESSION_TASK_STOPPING",
          "当前任务正在中断，请稍候再发送新消息。",
        );
      }

      const environment = this.buildCurrentEnvironment(currentState);
      const startedAt = normalizeStartedAt(options.startedAt, this.now);

      return {
        ...currentState,
        runtime: {
          status: "running",
          currentTask: {
            backend: environment.backend,
            cwd: environment.cwd,
            ...(options.messageId ? { messageId: options.messageId } : {}),
            startedAt,
          },
        },
      };
    });
  }

  /** Marks a running task as stopping so new work remains rejected while interruption completes. */
  public async markStopping(): Promise<AppState> {
    return this.stateStore.update((currentState) => {
      if (currentState.runtime.status === "idle") {
        throw new SessionManagerError("SESSION_NO_RUNNING_TASK", "当前没有正在运行的任务。");
      }

      if (currentState.runtime.status === "stopping") {
        return currentState;
      }

      return {
        ...currentState,
        runtime: {
          status: "stopping",
          currentTask: currentState.runtime.currentTask,
        },
      };
    });
  }

  /** Resets runtime status to idle after a backend task finishes, fails, or is interrupted. */
  public async markIdle(): Promise<AppState> {
    return this.stateStore.update((currentState) => ({
      ...currentState,
      runtime: {
        status: "idle",
        currentTask: null,
      },
    }));
  }

  /** Saves a backend session id for the specified environment and persists it atomically. */
  public async saveSessionId(
    environment: AgentEnvironment,
    sessionId: string | null,
  ): Promise<AppState> {
    return this.stateStore.update((currentState) => {
      if (environment.kind === "default") {
        return {
          ...currentState,
          defaultSession: { sessionId },
        };
      }

      const existingProject = currentState.knownProjects[environment.cwd];
      const knownProject: KnownProjectState = {
        backend: environment.backend,
        cwd: environment.cwd,
        ...(environment.agent ? { agent: environment.agent } : {}),
        ...(environment.model ? { model: environment.model } : {}),
        sessionId,
      };

      return {
        ...currentState,
        knownProjects: {
          ...currentState.knownProjects,
          [environment.cwd]: {
            ...existingProject,
            ...knownProject,
          },
        },
      };
    });
  }

  /** Builds the currently selected execution environment from persisted state. */
  private buildCurrentEnvironment(state: AppState): AgentEnvironment {
    if (state.activeProject !== null) {
      const knownProject = state.knownProjects[state.activeProject.cwd];
      return toAgentEnvironment(
        "project",
        state.activeProject,
        knownProject?.sessionId ?? null,
      );
    }

    return toAgentEnvironment(
      "default",
      this.config.defaultEnvironment,
      state.defaultSession.sessionId,
    );
  }

  /** Builds a new or existing known project record for an allowlisted real directory. */
  private buildKnownProject(realDir: string, state: AppState): KnownProjectState {
    const existingProject = state.knownProjects[realDir];

    if (existingProject !== undefined) {
      return existingProject;
    }

    return {
      backend: this.config.defaultEnvironment.backend,
      cwd: realDir,
      ...(this.config.defaultEnvironment.agent
        ? { agent: this.config.defaultEnvironment.agent }
        : {}),
      ...(this.config.defaultEnvironment.model
        ? { model: this.config.defaultEnvironment.model }
        : {}),
      sessionId: null,
    };
  }

  /** Builds a sanitized state snapshot from config and persisted state. */
  private buildStateSummary(state: AppState): SessionStateSummary {
    return {
      runtime: {
        status: state.runtime.status,
        currentTask:
          state.runtime.currentTask === null
            ? null
            : summarizeRuntimeTask(state.runtime.currentTask),
      },
      currentEnvironment: summarizeAgentEnvironment(this.buildCurrentEnvironment(state)),
      defaultEnvironment: summarizeAgentEnvironment(
        toAgentEnvironment(
          "default",
          this.config.defaultEnvironment,
          state.defaultSession.sessionId,
        ),
      ),
      activeProject:
        state.activeProject === null
          ? null
          : summarizeProjectEnvironment(state.activeProject, state.knownProjects),
      knownProjects: Object.values(state.knownProjects)
        .map((project) => summarizeKnownProject(project))
        .sort((left, right) => left.cwd.localeCompare(right.cwd)),
      canAcceptNormalMessage: state.runtime.status === "idle",
    };
  }
}

/** Rejects project switching while backend work is running or being stopped. */
function assertProjectMutationAllowed(status: RuntimeStatus): void {
  if (status === "running") {
    throw new SessionManagerError("SESSION_PROJECT_BUSY", PROJECT_BUSY_MESSAGE);
  }

  if (status === "stopping") {
    throw new SessionManagerError("SESSION_PROJECT_STOPPING", PROJECT_STOPPING_MESSAGE);
  }
}

/** Converts a known project record into the active-project state shape. */
function toActiveProjectState(project: KnownProjectState): ActiveProjectState {
  return {
    backend: project.backend,
    cwd: project.cwd,
    ...(project.agent ? { agent: project.agent } : {}),
    ...(project.model ? { model: project.model } : {}),
  };
}

/** Converts config or persisted environment data into backend execution input. */
function toAgentEnvironment(
  kind: AgentEnvironment["kind"],
  environment: AgentEnvironmentConfig,
  sessionId: string | null,
): AgentEnvironment {
  return {
    kind,
    backend: environment.backend,
    cwd: environment.cwd,
    ...(environment.agent ? { agent: environment.agent } : {}),
    ...(environment.model ? { model: environment.model } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

/** Produces a summary from a current Agent environment. */
function summarizeAgentEnvironment(environment: AgentEnvironment): SessionEnvironmentSummary {
  return {
    kind: environment.kind,
    backend: environment.backend,
    cwd: environment.cwd,
    ...(environment.agent ? { agent: environment.agent } : {}),
    ...(environment.model ? { model: environment.model } : {}),
    sessionId: maskSessionId(environment.sessionId),
  };
}

/** Produces a summary from active project state and its retained session metadata. */
function summarizeProjectEnvironment(
  activeProject: ActiveProjectState,
  knownProjects: AppState["knownProjects"],
): SessionEnvironmentSummary {
  return summarizeAgentEnvironment(
    toAgentEnvironment(
      "project",
      activeProject,
      knownProjects[activeProject.cwd]?.sessionId ?? null,
    ),
  );
}

/** Produces a summary from a known project record. */
function summarizeKnownProject(project: KnownProjectState): SessionEnvironmentSummary {
  return summarizeAgentEnvironment(toAgentEnvironment("project", project, project.sessionId));
}

/** Produces a runtime task summary without exposing raw backend/session internals. */
function summarizeRuntimeTask(task: RuntimeTaskState | null): RuntimeTaskSummary | null {
  if (task === null) {
    return null;
  }

  return {
    backend: task.backend,
    cwd: task.cwd,
    ...(task.messageId ? { messageId: task.messageId } : {}),
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
  };
}

/** Normalizes caller-provided task start times to ISO strings. */
function normalizeStartedAt(startedAt: Date | string | undefined, now: () => Date): string {
  if (startedAt instanceof Date) {
    return startedAt.toISOString();
  }

  return startedAt ?? now().toISOString();
}

/** Masks persisted backend session ids before rendering them in user-visible state. */
function maskSessionId(sessionId: string | null | undefined): string | null {
  if (!sessionId) {
    return null;
  }

  if (sessionId.length <= 12) {
    return `${sessionId.slice(0, 4)}...`;
  }

  return `${sessionId.slice(0, 8)}...${sessionId.slice(-4)}`;
}
