/** Coordinates Agent environment selection, project state, and runtime concurrency rules. */

import type { AgentBackend, AppConfig, AgentEnvironmentConfig } from "../config/types.js";
import type { BackendSession } from "../backend/types.js";
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
import { createLogger, type Logger } from "../utils/logger.js";
import type { AgentEnvironment } from "./types.js";

const PROJECT_BUSY_MESSAGE =
  "当前有任务正在运行，不能切换项目。请先使用 /stop 或等待任务完成。";
const PROJECT_STOPPING_MESSAGE = "当前任务正在中断，暂时不能切换项目。";

/** Commands whose availability is decided by the session state machine. */
export type StatefulCommandName = "cc" | "oc" | "close" | "state" | "stop" | "new" | "dl";

/** User-safe session manager error categories. */
export type SessionManagerErrorCode =
  | "SESSION_PROJECT_BUSY"
  | "SESSION_PROJECT_STOPPING"
  | "SESSION_TASK_BUSY"
  | "SESSION_TASK_STOPPING"
  | "SESSION_NO_RUNNING_TASK"
  | "SESSION_STOP_UNAVAILABLE"
  | "SESSION_STOP_FAILED";

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
  logger?: Logger;
}

/** Options for building a session manager and path policy from validated config. */
export interface CreateSessionManagerOptions extends Omit<SessionManagerOptions, "pathPolicy"> {
  pathPolicy?: PathPolicy;
}

/** Result returned after opening a project directory for a specific backend. */
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

/** Result returned after resetting the current backend session metadata. */
export interface NewSessionResult {
  environment: AgentEnvironment;
  hadPreviousSession: boolean;
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

/** In-memory backend control handle for the currently running task. */
export interface CurrentTaskControl {
  session: BackendSession;
  stop(): Promise<void> | void;
  close?(): Promise<void> | void;
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
  private readonly logger: Logger;
  private currentTaskControl: CurrentTaskControl | null = null;

  public constructor(options: SessionManagerOptions) {
    this.config = options.config;
    this.stateStore = options.stateStore;
    this.pathPolicy = options.pathPolicy;
    this.pathBaseDir = options.pathBaseDir;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? createLogger("session");
  }

  /** Returns the active project environment, or the configured default environment. */
  public async getCurrentEnvironment(): Promise<AgentEnvironment> {
    const state = await this.stateStore.read();
    return this.buildCurrentEnvironment(state);
  }

  /** Opens a Claude Code project directory after enforcing idle status and path allowlisting. */
  public async openClaudeProject(dir: string): Promise<OpenProjectResult> {
    return this.openProject(dir, "claude-code");
  }

  /** Opens an OpenCode project directory after enforcing idle status and path allowlisting. */
  public async openOpenCodeProject(dir: string): Promise<OpenProjectResult> {
    return this.openProject(dir, "opencode");
  }

  /** Opens a project directory for the requested backend and persists per-backend metadata. */
  private async openProject(dir: string, backend: AgentBackend): Promise<OpenProjectResult> {
    const existingState = await this.stateStore.read();
    assertProjectMutationAllowed(existingState.runtime.status);

    const realDir = await this.pathPolicy.assertAllowedDir(dir, { baseDir: this.pathBaseDir });
    const state = await this.stateStore.update((currentState) => {
      assertProjectMutationAllowed(currentState.runtime.status);

      const knownProject = this.buildKnownProject(realDir, backend, currentState);
      return {
        ...currentState,
        activeProject: toActiveProjectState(knownProject),
        knownProjects: setKnownProject(currentState.knownProjects, knownProject),
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

  /** Clears the current environment's saved session id so the next prompt starts fresh. */
  public async startNewSession(): Promise<NewSessionResult> {
    let hadPreviousSession = false;
    const state = await this.stateStore.update((currentState) => {
      assertProjectMutationAllowed(currentState.runtime.status);

      const environment = this.buildCurrentEnvironment(currentState);
      hadPreviousSession = environment.sessionId !== undefined;

      if (environment.kind === "default") {
        return {
          ...currentState,
          defaultSession: { sessionId: null },
        };
      }

      const existingProject = getKnownProject(currentState, environment);
      const knownProject: KnownProjectState = {
        ...existingProject,
        backend: environment.backend,
        cwd: environment.cwd,
        ...(environment.agent ? { agent: environment.agent } : {}),
        ...(environment.model ? { model: environment.model } : {}),
        sessionId: null,
      };

      return {
        ...currentState,
        knownProjects: setKnownProject(currentState.knownProjects, knownProject),
      };
    });

    return {
      environment: this.buildCurrentEnvironment(state),
      hadPreviousSession,
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

  /** Throws the state-machine rejection that applies to a stateful slash command. */
  public async assertCanAcceptCommand(commandName: StatefulCommandName): Promise<void> {
    if (commandName === "state" || commandName === "stop") {
      return;
    }

    const state = await this.stateStore.read();
    assertProjectMutationAllowed(state.runtime.status);
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
          message: "正在中断，请稍等。",
        };
    }
  }

  /** Stores the backend stop handle for the task that is currently running. */
  public setCurrentTaskControl(control: CurrentTaskControl): void {
    this.currentTaskControl = control;
  }

  /** Clears the backend stop handle after the owning task finishes or is closed. */
  public clearCurrentTaskControl(session?: BackendSession): void {
    if (session !== undefined && this.currentTaskControl?.session !== session) {
      return;
    }

    this.currentTaskControl = null;
  }

  /** Best-effort cleanup for the active backend task during process shutdown. */
  public async closeCurrentTaskControl(): Promise<void> {
    const control = this.currentTaskControl;

    try {
      await control?.close?.();
    } finally {
      if (control !== null) {
        this.clearCurrentTaskControl(control.session);
      }

      await this.markIdle();
    }
  }

  /** Requests interruption of the active backend task and moves runtime state to stopping. */
  public async requestStopCurrentTask(): Promise<void> {
    const stopState = await this.getStopState();

    if (!stopState.canRequestStop) {
      throw new SessionManagerError("SESSION_NO_RUNNING_TASK", stopState.message);
    }

    const control = this.currentTaskControl;
    if (control === null) {
      throw new SessionManagerError(
        "SESSION_STOP_UNAVAILABLE",
        "当前 Agent 任务还未准备好中断，请稍后重试。",
      );
    }

    await this.markStopping();

    try {
      await control.stop();
    } catch (error: unknown) {
      this.logger.error("Stopping current Agent task failed.", {
        error,
        backend: control.session.backend,
        cwd: control.session.cwd,
      });
      this.clearCurrentTaskControl(control.session);
      await this.markIdle();

      if (error instanceof UserFacingError) {
        throw error;
      }

      throw new SessionManagerError(
        "SESSION_STOP_FAILED",
        "中断当前 Agent 任务失败，请稍后重试。",
      );
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

      const existingProject = getKnownProject(currentState, environment);
      const knownProject: KnownProjectState = {
        backend: environment.backend,
        cwd: environment.cwd,
        ...(environment.agent ? { agent: environment.agent } : {}),
        ...(environment.model ? { model: environment.model } : {}),
        sessionId,
      };

      return {
        ...currentState,
        knownProjects: setKnownProject(currentState.knownProjects, {
          ...existingProject,
          ...knownProject,
        }),
      };
    });
  }

  /** Builds the currently selected execution environment from persisted state. */
  private buildCurrentEnvironment(state: AppState): AgentEnvironment {
    if (state.activeProject !== null) {
      const knownProject = getKnownProject(state, state.activeProject);
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
  private buildKnownProject(
    realDir: string,
    backend: AgentBackend,
    state: AppState,
  ): KnownProjectState {
    const existingProject = getKnownProject(state, { backend, cwd: realDir });

    if (existingProject !== undefined) {
      return existingProject;
    }

    const inheritedEnvironment = this.findConfiguredEnvironment(realDir, backend);
    return {
      backend,
      cwd: realDir,
      ...(inheritedEnvironment?.agent ? { agent: inheritedEnvironment.agent } : {}),
      ...(inheritedEnvironment?.model ? { model: inheritedEnvironment.model } : {}),
      sessionId: null,
    };
  }

  /** Finds backend-compatible configured settings that can be inherited by slash-opened projects. */
  private findConfiguredEnvironment(
    realDir: string,
    backend: AgentBackend,
  ): AgentEnvironmentConfig | undefined {
    const configuredProject = this.config.projects?.find(
      (project) => project.backend === backend && project.cwd === realDir,
    );

    if (configuredProject !== undefined) {
      return configuredProject;
    }

    if (this.config.defaultEnvironment.backend === backend) {
      return this.config.defaultEnvironment;
    }

    return undefined;
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
      knownProjects: getUniqueKnownProjects(state.knownProjects)
        .map((project) => summarizeKnownProject(project))
        .sort((left, right) => {
          const cwdOrder = left.cwd.localeCompare(right.cwd);
          return cwdOrder === 0 ? left.backend.localeCompare(right.backend) : cwdOrder;
        }),
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

/** Opaque record key that keeps sessions distinct for the same directory across backends. */
function getKnownProjectKey(project: Pick<AgentEnvironmentConfig, "backend" | "cwd">): string {
  return `${project.backend}:${project.cwd}`;
}

/** Returns a known project using the per-backend key, with legacy cwd-key fallback for old state. */
function getKnownProject(
  state: AppState,
  project: Pick<AgentEnvironmentConfig, "backend" | "cwd">,
): KnownProjectState | undefined {
  return getKnownProjectFromRecord(state.knownProjects, project);
}

/** Looks up retained project metadata in a known-project record. */
function getKnownProjectFromRecord(
  knownProjects: AppState["knownProjects"],
  project: Pick<AgentEnvironmentConfig, "backend" | "cwd">,
): KnownProjectState | undefined {
  const keyedProject = knownProjects[getKnownProjectKey(project)];

  if (keyedProject !== undefined) {
    return keyedProject;
  }

  const legacyProject = knownProjects[project.cwd];
  if (
    legacyProject !== undefined &&
    legacyProject.backend === project.backend &&
    legacyProject.cwd === project.cwd
  ) {
    return legacyProject;
  }

  return undefined;
}

/** Adds or replaces a known project while removing the matching pre-T27 cwd-only key. */
function setKnownProject(
  knownProjects: AppState["knownProjects"],
  project: KnownProjectState,
): AppState["knownProjects"] {
  const nextKnownProjects = {
    ...knownProjects,
    [getKnownProjectKey(project)]: project,
  };
  const legacyProject = nextKnownProjects[project.cwd];

  if (
    legacyProject !== undefined &&
    legacyProject.backend === project.backend &&
    legacyProject.cwd === project.cwd
  ) {
    delete nextKnownProjects[project.cwd];
  }

  return nextKnownProjects;
}

/** Deduplicates legacy and per-backend project records before rendering state summaries. */
function getUniqueKnownProjects(
  knownProjects: AppState["knownProjects"],
): readonly KnownProjectState[] {
  return [
    ...new Map(
      Object.values(knownProjects).map((project) => [getKnownProjectKey(project), project]),
    ).values(),
  ];
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
  const knownProject = getKnownProjectFromRecord(knownProjects, activeProject);

  return summarizeAgentEnvironment(
    toAgentEnvironment(
      "project",
      activeProject,
      knownProject?.sessionId ?? null,
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
