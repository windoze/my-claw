/** BackendAdapter implementation backed by the OpenCode SDK server/client API. */

import {
  createOpencode,
  type Event,
  type OpencodeClient,
  type ServerOptions,
  type SessionPromptAsyncData,
} from "@opencode-ai/sdk";

import type { AgentEnvironment } from "../../session/types.js";
import { UserFacingError } from "../../utils/errors.js";
import { createLogger, type Logger } from "../../utils/logger.js";
import type { AgentEvent, AgentInput, BackendAdapter, BackendSession } from "../types.js";
import {
  createOpenCodeEventMappingState,
  formatOpenCodeError,
  mapOpenCodeEvent,
} from "./mapOpenCodeEvent.js";
import {
  OPEN_CODE_BACKEND,
  type CreateOpenCodeFunction,
  type OpenCodeBackendSession,
  type OpenCodeRuntime,
  type OpenCodeServerHandle,
} from "./types.js";

/** Options accepted when constructing an OpenCode backend adapter. */
export interface OpenCodeAdapterOptions {
  logger?: Logger;
  createOpenCode?: CreateOpenCodeFunction;
  serverOptions?: ServerOptions;
}

/** User-facing error categories raised by the OpenCode adapter. */
export type OpenCodeAdapterErrorCode =
  | "OPENCODE_BACKEND_MISMATCH"
  | "OPENCODE_MODEL_INVALID"
  | "OPENCODE_SERVER_START_FAILED"
  | "OPENCODE_SESSION_CREATE_FAILED"
  | "OPENCODE_SESSION_NOT_OPEN"
  | "OPENCODE_TASK_NOT_RUNNING"
  | "OPENCODE_STOP_FAILED";

interface OpenCodeProjectContext {
  cwd: string;
  client: OpencodeClient;
  server: OpenCodeServerHandle;
  serverUrl: string;
  sessionId?: string;
}

interface ActiveOpenCodePrompt {
  abortController: AbortController;
  stopRequested: boolean;
  eventStream?: AsyncGenerator<Event, unknown, unknown>;
}

type OpenCodeModelSelection = NonNullable<NonNullable<SessionPromptAsyncData["body"]>["model"]>;

const DEFAULT_SERVER_OPTIONS: ServerOptions = { port: 0 };
const DEFAULT_SESSION_TITLE = "DingTalk Agent";
const STOPPED_MESSAGE = "当前 Agent 任务已中断。";
const NO_TERMINAL_EVENT_MESSAGE = "OpenCode 未返回任务完成事件。";

/** Runs prompts through OpenCode and maps SDK events to AgentEvent values. */
export class OpenCodeAdapter implements BackendAdapter {
  private readonly logger: Logger;
  private readonly createOpenCode: CreateOpenCodeFunction;
  private readonly serverOptions: ServerOptions;
  private runtimePromise: Promise<OpenCodeRuntime> | null = null;
  private readonly contexts = new Map<string, Promise<OpenCodeProjectContext>>();
  private readonly sessionContexts = new WeakMap<BackendSession, OpenCodeProjectContext>();
  private readonly sessionEnvironments = new WeakMap<BackendSession, AgentEnvironment>();
  private readonly activePrompts = new Map<BackendSession, ActiveOpenCodePrompt>();

  public constructor(options: OpenCodeAdapterOptions = {}) {
    this.logger = options.logger ?? createLogger("backend:opencode");
    this.createOpenCode = options.createOpenCode ?? createOpencode;
    this.serverOptions = { ...DEFAULT_SERVER_OPTIONS, ...(options.serverOptions ?? {}) };
  }

  /** Opens or reuses the OpenCode server/client/session for the selected environment. */
  public async open(environment: AgentEnvironment): Promise<OpenCodeBackendSession> {
    assertOpenCodeEnvironment(environment);

    const context = await this.getOrCreateProjectContext(environment.cwd);
    const sessionId = environment.sessionId ?? context.sessionId ?? (await this.createSession(context));
    context.sessionId = sessionId;

    const session: OpenCodeBackendSession = {
      backend: OPEN_CODE_BACKEND,
      cwd: environment.cwd,
      sessionId,
      raw: {
        environment,
        serverUrl: context.serverUrl,
      },
    };

    this.sessionContexts.set(session, context);
    this.sessionEnvironments.set(session, environment);
    return session;
  }

  /** Sends one prompt to OpenCode and yields backend-neutral Agent events. */
  public async *send(session: BackendSession, input: AgentInput): AsyncIterable<AgentEvent> {
    assertOpenCodeSession(session);

    const context = this.getSessionContext(session);
    const sessionId = session.sessionId ?? context.sessionId;

    if (sessionId === undefined) {
      yield { type: "error", message: "OpenCode 会话尚未创建。" };
      return;
    }

    const activePrompt: ActiveOpenCodePrompt = {
      abortController: new AbortController(),
      stopRequested: false,
    };
    this.activePrompts.set(session, activePrompt);

    try {
      const subscription = await context.client.event.subscribe({
        query: { directory: session.cwd },
        signal: activePrompt.abortController.signal,
      });
      activePrompt.eventStream = subscription.stream;

      const promptResult = await context.client.session.promptAsync({
        path: { id: sessionId },
        query: { directory: session.cwd },
        body: this.buildPromptBody(session, input),
      });

      if (promptResult.error !== undefined) {
        yield { type: "error", message: formatOpenCodeError(promptResult.error) };
        return;
      }

      yield* this.mapEventStream(sessionId, activePrompt);
    } catch (error: unknown) {
      if (activePrompt.stopRequested || activePrompt.abortController.signal.aborted) {
        yield {
          type: "stopped",
          message: STOPPED_MESSAGE,
          sessionId,
        };
        return;
      }

      this.logger.error("OpenCode SDK prompt failed.", {
        error,
        cwd: session.cwd,
        sessionId,
      });
      yield { type: "error", message: formatOpenCodeError(error) };
    } finally {
      this.activePrompts.delete(session);
      await closeEventStream(activePrompt.eventStream);
    }
  }

  /** Requests cancellation for an active OpenCode prompt. */
  public async stop(session: BackendSession): Promise<void> {
    assertOpenCodeSession(session);

    const activePrompt = this.activePrompts.get(session);
    if (activePrompt === undefined) {
      throw new UserFacingError(
        "OPENCODE_TASK_NOT_RUNNING",
        "当前 OpenCode 会话没有正在运行的任务。",
      );
    }

    activePrompt.stopRequested = true;

    if (session.sessionId === undefined) {
      activePrompt.abortController.abort();
      return;
    }

    const context = this.getSessionContext(session);

    try {
      const abortResult = await context.client.session.abort({
        path: { id: session.sessionId },
        query: { directory: session.cwd },
      });

      if (abortResult.error !== undefined) {
        throw new Error(formatOpenCodeError(abortResult.error));
      }
    } catch (error: unknown) {
      this.logger.error("OpenCode session abort failed; closing event stream.", {
        error,
        cwd: session.cwd,
        sessionId: session.sessionId,
      });
      activePrompt.abortController.abort();
      await closeEventStream(activePrompt.eventStream);
      throw new UserFacingError("OPENCODE_STOP_FAILED", "中断当前 OpenCode 任务失败，请稍后重试。", {
        cause: error,
      });
    }
  }

  /** Releases prompt bookkeeping for a session handle without deleting OpenCode user data. */
  public async close(session: BackendSession): Promise<void> {
    assertOpenCodeSession(session);

    const activePrompt = this.activePrompts.get(session);
    if (activePrompt !== undefined) {
      activePrompt.abortController.abort();
      await closeEventStream(activePrompt.eventStream);
      this.activePrompts.delete(session);
    }

    this.sessionContexts.delete(session);
    this.sessionEnvironments.delete(session);
  }

  /** Closes all process-local OpenCode servers created by this adapter. */
  public async dispose(): Promise<void> {
    for (const activePrompt of this.activePrompts.values()) {
      activePrompt.abortController.abort();
      await closeEventStream(activePrompt.eventStream);
    }
    this.activePrompts.clear();

    const runtimePromise = this.runtimePromise;
    this.runtimePromise = null;
    const contextResults = await Promise.allSettled([...this.contexts.values()]);
    this.contexts.clear();
    const servers = new Set<OpenCodeServerHandle>();

    for (const result of contextResults) {
      if (result.status === "rejected") {
        this.logger.error("OpenCode context failed before disposal.", { error: result.reason });
        continue;
      }

      servers.add(result.value.server);
    }

    if (runtimePromise !== null) {
      const runtimeResult = await Promise.allSettled([runtimePromise]);
      const [runtime] = runtimeResult;

      if (runtime?.status === "fulfilled") {
        servers.add(runtime.value.server);
      } else if (runtime?.status === "rejected") {
        this.logger.error("OpenCode runtime failed before disposal.", { error: runtime.reason });
      }
    }

    for (const server of servers) {
      try {
        server.close();
      } catch (error: unknown) {
        this.logger.error("OpenCode server close failed during disposal.", {
          error,
          serverUrl: server.url,
        });
      }
    }
  }

  /** Starts or reuses the SDK runtime tied to one project directory. */
  private getOrCreateProjectContext(cwd: string): Promise<OpenCodeProjectContext> {
    const existingContext = this.contexts.get(cwd);

    if (existingContext !== undefined) {
      return existingContext;
    }

    const contextPromise = this.createProjectContext(cwd);
    this.contexts.set(cwd, contextPromise);
    return contextPromise;
  }

  /** Starts a local OpenCode server and client for one project directory. */
  private async createProjectContext(cwd: string): Promise<OpenCodeProjectContext> {
    try {
      const runtime = await this.getOrCreateRuntime(cwd);
      const context: OpenCodeProjectContext = {
        cwd,
        client: runtime.client,
        server: runtime.server,
        serverUrl: runtime.server.url,
      };

      return context;
    } catch (error: unknown) {
      this.contexts.delete(cwd);
      throw error;
    }
  }

  /** Starts or reuses the single process-local OpenCode server. */
  private getOrCreateRuntime(cwd: string): Promise<OpenCodeRuntime> {
    if (this.runtimePromise !== null) {
      return this.runtimePromise;
    }

    this.runtimePromise = this.createOpenCode(this.serverOptions)
      .then((runtime) => {
        this.logger.info("OpenCode server started.", {
          cwd,
          serverUrl: runtime.server.url,
        });
        return runtime;
      })
      .catch((error: unknown) => {
        this.runtimePromise = null;
        this.logger.error("OpenCode server startup failed.", { error, cwd });
        throw new UserFacingError(
          "OPENCODE_SERVER_START_FAILED",
          "OpenCode 服务启动失败，请确认已安装 opencode 并已完成认证。",
          { cause: error },
        );
      });

    return this.runtimePromise;
  }

  /** Creates a durable OpenCode session in the selected project directory. */
  private async createSession(context: OpenCodeProjectContext): Promise<string> {
    try {
      const result = await context.client.session.create({
        query: { directory: context.cwd },
        body: { title: DEFAULT_SESSION_TITLE },
      });

      if (result.error !== undefined) {
        throw new Error(formatOpenCodeError(result.error));
      }

      if (result.data === undefined) {
        throw new Error("OpenCode session.create returned no session data.");
      }

      return result.data.id;
    } catch (error: unknown) {
      this.logger.error("OpenCode session creation failed.", {
        error,
        cwd: context.cwd,
        serverUrl: context.serverUrl,
      });
      throw new UserFacingError(
        "OPENCODE_SESSION_CREATE_FAILED",
        "OpenCode 会话创建失败，请检查 OpenCode 服务状态。",
        { cause: error },
      );
    }
  }

  /** Converts app environment and input into the OpenCode prompt request body. */
  private buildPromptBody(
    session: BackendSession,
    input: AgentInput,
  ): NonNullable<SessionPromptAsyncData["body"]> {
    const environment = this.sessionEnvironments.get(session);
    const body: NonNullable<SessionPromptAsyncData["body"]> = {
      parts: [{ type: "text", text: input.text }],
    };

    if (environment?.agent !== undefined) {
      body.agent = environment.agent;
    }

    if (environment?.model !== undefined) {
      body.model = parseOpenCodeModel(environment.model);
    }

    return body;
  }

  /** Streams SDK events until OpenCode reports completion, failure, or interruption. */
  private async *mapEventStream(
    sessionId: string,
    activePrompt: ActiveOpenCodePrompt,
  ): AsyncIterable<AgentEvent> {
    const stream = activePrompt.eventStream;

    if (stream === undefined) {
      yield { type: "error", message: NO_TERMINAL_EVENT_MESSAGE };
      return;
    }

    const mappingState = createOpenCodeEventMappingState(sessionId);

    for await (const event of stream) {
      const mappedEvent = mapOpenCodeEvent(event, mappingState);

      if (mappedEvent === null) {
        continue;
      }

      if (
        activePrompt.stopRequested &&
        (mappedEvent.type === "done" || mappedEvent.type === "error")
      ) {
        yield {
          type: "stopped",
          message: STOPPED_MESSAGE,
          sessionId,
        };
        return;
      }

      yield mappedEvent;

      if (mappedEvent.type === "done" || mappedEvent.type === "error") {
        return;
      }
    }

    yield activePrompt.stopRequested
      ? { type: "stopped", message: STOPPED_MESSAGE, sessionId }
      : { type: "error", message: NO_TERMINAL_EVENT_MESSAGE };
  }

  /** Resolves the SDK context associated with a session handle. */
  private getSessionContext(session: BackendSession): OpenCodeProjectContext {
    const context = this.sessionContexts.get(session);

    if (context === undefined) {
      throw new UserFacingError(
        "OPENCODE_SESSION_NOT_OPEN",
        "OpenCode 会话未打开或已关闭，请重新发送消息。",
      );
    }

    return context;
  }
}

/** Ensures only OpenCode environments are opened by this adapter. */
function assertOpenCodeEnvironment(environment: AgentEnvironment): void {
  if (environment.backend !== OPEN_CODE_BACKEND) {
    throw new UserFacingError(
      "OPENCODE_BACKEND_MISMATCH",
      `OpenCode adapter cannot open backend: ${environment.backend}`,
    );
  }
}

/** Ensures only OpenCode backend sessions are sent through this adapter. */
function assertOpenCodeSession(session: BackendSession): void {
  if (session.backend !== OPEN_CODE_BACKEND) {
    throw new UserFacingError(
      "OPENCODE_BACKEND_MISMATCH",
      `OpenCode adapter cannot handle backend session: ${session.backend}`,
    );
  }
}

/** Parses a compact OpenCode model string into the provider/model shape required by the SDK. */
function parseOpenCodeModel(model: string): OpenCodeModelSelection {
  const separatorIndex = findModelSeparator(model);

  if (separatorIndex === -1) {
    throw new UserFacingError(
      "OPENCODE_MODEL_INVALID",
      "OpenCode model 必须使用 provider/model 或 provider:model 格式。",
    );
  }

  const providerID = model.slice(0, separatorIndex).trim();
  const modelID = model.slice(separatorIndex + 1).trim();

  if (providerID.length === 0 || modelID.length === 0) {
    throw new UserFacingError(
      "OPENCODE_MODEL_INVALID",
      "OpenCode model 必须同时包含 provider 和 model。",
    );
  }

  return { providerID, modelID };
}

/** Finds the separator between provider and model identifiers. */
function findModelSeparator(model: string): number {
  const slashIndex = model.indexOf("/");

  if (slashIndex !== -1) {
    return slashIndex;
  }

  return model.indexOf(":");
}

/** Closes an async SDK stream if it has already been opened. */
async function closeEventStream(
  stream: AsyncGenerator<Event, unknown, unknown> | undefined,
): Promise<void> {
  if (stream === undefined) {
    return;
  }

  await stream.return(undefined);
}
