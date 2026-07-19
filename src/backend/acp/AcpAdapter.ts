/** BackendAdapter implementation backed by an Agent Client Protocol subprocess. */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import { Readable, Writable } from "node:stream";

import {
  AGENT_METHODS,
  client,
  type ClientConnection,
  CLIENT_METHODS,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

import type { AcpConfig } from "../../config/types.js";
import type { AgentEnvironment } from "../../session/types.js";
import { UserFacingError } from "../../utils/errors.js";
import { createLogger, redactLogString, type Logger } from "../../utils/logger.js";
import { formatAgentInputPrompt } from "../formatAgentInput.js";
import type {
  AgentEvent,
  AgentInput,
  AgentPermissionDecision,
  AgentPermissionHandler,
  BackendAdapter,
  BackendSession,
} from "../types.js";
import { AsyncEventQueue } from "./AsyncEventQueue.js";
import {
  type AcpUpdateMappingState,
  createAcpUpdateMappingState,
  drainUnfinishedToolCalls,
  mapAcpUpdate,
} from "./mapAcpUpdate.js";
import { ACP_BACKEND, type AcpBackendSession } from "./types.js";

/** Options accepted when constructing an ACP backend adapter. */
export interface AcpAdapterOptions {
  config?: AcpConfig;
  logger?: Logger;
}

/** User-facing error categories raised by the ACP adapter. */
export type AcpAdapterErrorCode =
  | "ACP_BACKEND_MISMATCH"
  | "ACP_NOT_CONFIGURED"
  | "ACP_SERVER_START_FAILED"
  | "ACP_SESSION_CREATE_FAILED"
  | "ACP_SESSION_NOT_OPEN"
  | "ACP_TASK_NOT_RUNNING";

/** Outcome of one `session/prompt` request pushed onto the send queue. */
interface PromptTurnOutcome {
  response?: PromptResponse;
  error?: unknown;
}

/** Item on the per-send queue: a mapped agent event or a turn-completion signal. */
type AcpQueueItem =
  | { kind: "event"; event: AgentEvent }
  | { kind: "turn_end"; outcome: PromptTurnOutcome };

/** Live state for the ACP task running across one `send` (may span several turns). */
interface ActiveAcpPrompt {
  stopRequested: boolean;
  queue: AsyncEventQueue<AcpQueueItem>;
  mappingState: AcpUpdateMappingState;
  pendingInterjections: AgentInput[];
  permissionHandler?: AgentPermissionHandler;
  permissionAbort: AbortController;
}

/** ACP agent subprocess with piped stdin/stdout and inherited stderr. */
type AcpChildProcess = ChildProcessByStdio<NodeWritable, NodeReadable, null>;

/** A long-lived ACP agent subprocess and its client connection for one provider+cwd. */
interface AcpConnectionContext {
  cacheKey: string;
  provider: string;
  cwd: string;
  child: AcpChildProcess;
  connection: ClientConnection;
  loadSessionSupported: boolean;
  activePrompts: Map<string, ActiveAcpPrompt>;
}

const STOPPED_MESSAGE = "当前 Agent 任务已中断。";
const NO_RESULT_MESSAGE = "ACP agent 未返回完成结果。";
const PIVOT_NOTICE = "↪️ 已根据新消息调整方向，以下是更新后的结果：";

/** Runs prompts through an ACP agent subprocess and maps updates to AgentEvent values. */
export class AcpAdapter implements BackendAdapter {
  private readonly config?: AcpConfig;
  private readonly logger: Logger;
  private readonly contexts = new Map<string, Promise<AcpConnectionContext>>();
  private readonly sessionContexts = new WeakMap<BackendSession, AcpConnectionContext>();
  private readonly activePrompts = new WeakMap<BackendSession, ActiveAcpPrompt>();

  public constructor(options: AcpAdapterOptions = {}) {
    this.config = options.config;
    this.logger = options.logger ?? createLogger("backend:acp");
  }

  /** Opens or reuses the ACP subprocess/connection/session for the selected environment. */
  public async open(environment: AgentEnvironment): Promise<AcpBackendSession> {
    assertAcpEnvironment(environment);

    const provider = environment.provider ?? this.config?.defaultProvider;
    if (provider === undefined) {
      throw new UserFacingError(
        "ACP_NOT_CONFIGURED",
        "未配置 ACP 后端，请在配置文件中提供 acp.providers。",
      );
    }

    const context = await this.getOrCreateConnectionContext(provider, environment.cwd);
    const sessionId = await this.resolveSessionId(context, environment.sessionId);

    const session: AcpBackendSession = {
      backend: ACP_BACKEND,
      cwd: environment.cwd,
      sessionId,
      raw: { environment },
    };

    this.sessionContexts.set(session, context);
    return session;
  }

  /**
   * Runs the ACP task for one inbound message and yields backend-neutral events.
   *
   * A single `send` may span several prompt turns: when the user interjects
   * mid-turn (see {@link interject}), the current turn is cancelled and a fresh
   * `session/prompt` is issued with the follow-up text on the same session, so
   * the agent changes direction with full history. When no interjection is
   * pending, the task ends after the first turn — matching the other backends.
   */
  public async *send(session: BackendSession, input: AgentInput): AsyncIterable<AgentEvent> {
    assertAcpSession(session);

    const context = this.getSessionContext(session);
    const sessionId = session.sessionId;

    if (sessionId === undefined) {
      yield { type: "error", message: "ACP 会话尚未创建。" };
      return;
    }

    const activePrompt: ActiveAcpPrompt = {
      stopRequested: false,
      queue: new AsyncEventQueue<AcpQueueItem>(),
      mappingState: createAcpUpdateMappingState(),
      pendingInterjections: [],
      permissionAbort: new AbortController(),
      ...(input.permissionHandler !== undefined
        ? { permissionHandler: input.permissionHandler }
        : {}),
    };
    context.activePrompts.set(sessionId, activePrompt);
    this.activePrompts.set(session, activePrompt);

    try {
      yield* this.runTurns(context, sessionId, input, activePrompt);
    } finally {
      activePrompt.permissionAbort.abort();
      context.activePrompts.delete(sessionId);
      this.activePrompts.delete(session);
    }
  }

  /** Drives one or more prompt turns, restarting on pending interjections. */
  private async *runTurns(
    context: AcpConnectionContext,
    sessionId: string,
    initialInput: AgentInput,
    activePrompt: ActiveAcpPrompt,
  ): AsyncGenerator<AgentEvent, void, void> {
    let input: AgentInput = initialInput;

    while (true) {
      void this.runPrompt(context, sessionId, input, activePrompt);

      let outcome: PromptTurnOutcome = {};
      for await (const item of activePrompt.queue.drain()) {
        if (item.kind === "event") {
          yield item.event;
          continue;
        }

        outcome = item.outcome;
        break;
      }

      const pivot = activePrompt.pendingInterjections.shift();

      // A cancelled turn caused by a pending pivot is expected: continue with the
      // follow-up prompt instead of reporting an interruption to the user.
      if (pivot !== undefined && !activePrompt.stopRequested) {
        yield* drainUnfinishedToolCalls(activePrompt.mappingState);
        yield { type: "notice", text: PIVOT_NOTICE };
        activePrompt.mappingState = createAcpUpdateMappingState();
        activePrompt.queue = new AsyncEventQueue<AcpQueueItem>();
        if (pivot.permissionHandler !== undefined) {
          activePrompt.permissionHandler = pivot.permissionHandler;
        }
        input = pivot;
        continue;
      }

      yield* this.finishPrompt(sessionId, activePrompt, outcome);
      return;
    }
  }

  /** Requests cancellation for the active ACP prompt turn. */
  public async stop(session: BackendSession): Promise<void> {
    assertAcpSession(session);

    const activePrompt = this.activePrompts.get(session);
    if (activePrompt === undefined || session.sessionId === undefined) {
      throw new UserFacingError("ACP_TASK_NOT_RUNNING", "当前 ACP 会话没有正在运行的任务。");
    }

    activePrompt.stopRequested = true;
    activePrompt.permissionAbort.abort();

    const context = this.getSessionContext(session);
    try {
      await context.connection.agent.notify(AGENT_METHODS.session_cancel, {
        sessionId: session.sessionId,
      });
    } catch (error: unknown) {
      this.logger.error("ACP session cancel failed.", {
        error,
        cwd: session.cwd,
        sessionId: session.sessionId,
      });
    }
  }

  /**
   * Queues a follow-up prompt and cancels the current turn so the agent changes
   * direction. Returns false when no turn is running (nothing to interject into).
   */
  public interject(session: BackendSession, input: AgentInput): boolean {
    assertAcpSession(session);

    const activePrompt = this.activePrompts.get(session);
    if (activePrompt === undefined || activePrompt.stopRequested || session.sessionId === undefined) {
      return false;
    }

    activePrompt.pendingInterjections.push(input);

    const context = this.sessionContexts.get(session);
    context?.connection.agent
      .notify(AGENT_METHODS.session_cancel, { sessionId: session.sessionId })
      .catch((error: unknown) => {
        this.logger.error("ACP interjection cancel failed.", {
          error,
          cwd: session.cwd,
          sessionId: session.sessionId,
        });
      });

    return true;
  }

  /** Releases prompt bookkeeping for a session handle without stopping the subprocess. */
  public close(session: BackendSession): void {
    assertAcpSession(session);

    const activePrompt = this.activePrompts.get(session);
    if (activePrompt !== undefined) {
      activePrompt.permissionAbort.abort();
      activePrompt.queue.close();
      this.activePrompts.delete(session);
    }

    this.sessionContexts.delete(session);
  }

  /** Terminates all ACP subprocesses created by this adapter. */
  public async dispose(): Promise<void> {
    const contextResults = await Promise.allSettled([...this.contexts.values()]);
    this.contexts.clear();

    for (const result of contextResults) {
      if (result.status === "rejected") {
        this.logger.error("ACP context failed before disposal.", { error: result.reason });
        continue;
      }

      this.terminateContext(result.value);
    }
  }

  /** Starts or reuses the ACP subprocess/connection tied to one provider + directory. */
  private getOrCreateConnectionContext(
    provider: string,
    cwd: string,
  ): Promise<AcpConnectionContext> {
    const cacheKey = `${provider}:${cwd}`;
    const existing = this.contexts.get(cacheKey);
    if (existing !== undefined) {
      return existing;
    }

    const contextPromise = this.createConnectionContext(cacheKey, provider, cwd).catch(
      (error: unknown) => {
        this.contexts.delete(cacheKey);
        throw error;
      },
    );
    this.contexts.set(cacheKey, contextPromise);
    return contextPromise;
  }

  /** Spawns the ACP agent subprocess and negotiates protocol capabilities. */
  private async createConnectionContext(
    cacheKey: string,
    provider: string,
    cwd: string,
  ): Promise<AcpConnectionContext> {
    const providerConfig = this.requireProviderConfig(provider);

    let child: AcpChildProcess;
    try {
      child = spawn(providerConfig.command, providerConfig.args, {
        cwd,
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, ...(providerConfig.env ?? {}) },
      });
    } catch (error: unknown) {
      throw new UserFacingError(
        "ACP_SERVER_START_FAILED",
        `ACP provider ${provider} 启动失败，请检查 acp.providers.${provider}.command 配置。`,
        { cause: error },
      );
    }

    const context: AcpConnectionContext = {
      cacheKey,
      provider,
      cwd,
      child,
      connection: undefined as unknown as ClientConnection,
      loadSessionSupported: false,
      activePrompts: new Map<string, ActiveAcpPrompt>(),
    };

    child.on("error", (error) => {
      this.logger.error("ACP agent subprocess error.", { error, cwd });
    });
    child.on("exit", (code, signal) => {
      this.logger.info("ACP agent subprocess exited.", { provider, cwd, code, signal });
      this.contexts.delete(cacheKey);
      for (const activePrompt of context.activePrompts.values()) {
        activePrompt.queue.close();
      }
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    context.connection = client({ name: "my-claw" })
      .onNotification(CLIENT_METHODS.session_update, ({ params }) =>
        this.handleSessionUpdate(context, params),
      )
      .onRequest(CLIENT_METHODS.session_request_permission, ({ params }) =>
        this.handlePermissionRequest(context, params),
      )
      .connect(stream);

    try {
      const initResult = await context.connection.agent.request(AGENT_METHODS.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      context.loadSessionSupported = initResult.agentCapabilities?.loadSession === true;
    } catch (error: unknown) {
      this.terminateContext(context);
      throw new UserFacingError(
        "ACP_SERVER_START_FAILED",
        "ACP agent 初始化失败，请确认该 agent 兼容 Agent Client Protocol。",
        { cause: error },
      );
    }

    this.logger.info("ACP agent connection established.", {
      cwd,
      loadSessionSupported: context.loadSessionSupported,
    });
    return context;
  }

  /** Creates a new ACP session, or loads a stored one when the agent supports it. */
  private async resolveSessionId(
    context: AcpConnectionContext,
    storedSessionId: string | undefined,
  ): Promise<string> {
    if (storedSessionId !== undefined && context.loadSessionSupported) {
      try {
        await context.connection.agent.request(AGENT_METHODS.session_load, {
          sessionId: storedSessionId,
          cwd: context.cwd,
          mcpServers: [],
        });
        return storedSessionId;
      } catch (error: unknown) {
        this.logger.warn("ACP session load failed; creating a new session.", {
          error,
          cwd: context.cwd,
          sessionId: storedSessionId,
        });
      }
    }

    try {
      const result = await context.connection.agent.request(AGENT_METHODS.session_new, {
        cwd: context.cwd,
        mcpServers: [],
      });
      return result.sessionId;
    } catch (error: unknown) {
      this.logger.error("ACP session creation failed.", { error, cwd: context.cwd });
      throw new UserFacingError(
        "ACP_SESSION_CREATE_FAILED",
        "ACP 会话创建失败，请检查 ACP agent 状态。",
        { cause: error },
      );
    }
  }

  /** Runs one `session/prompt` request and signals its outcome onto the send queue. */
  private async runPrompt(
    context: AcpConnectionContext,
    sessionId: string,
    input: AgentInput,
    activePrompt: ActiveAcpPrompt,
  ): Promise<void> {
    // Capture the queue for this turn so a follow-up turn's queue reassignment
    // never receives this turn's completion signal.
    const queue = activePrompt.queue;

    try {
      const response = await context.connection.agent.request(AGENT_METHODS.session_prompt, {
        sessionId,
        prompt: [{ type: "text", text: formatAgentInputPrompt(input) }],
      });
      queue.push({ kind: "turn_end", outcome: { response } });
    } catch (error: unknown) {
      queue.push({ kind: "turn_end", outcome: { error } });
    }
  }

  /** Emits the terminal AgentEvent for a completed, cancelled, or failed prompt turn. */
  private *finishPrompt(
    sessionId: string,
    activePrompt: ActiveAcpPrompt,
    outcome: { response?: PromptResponse; error?: unknown },
  ): Generator<AgentEvent, void, void> {
    yield* drainUnfinishedToolCalls(activePrompt.mappingState);

    if (outcome.error !== undefined) {
      if (activePrompt.stopRequested) {
        yield { type: "stopped", message: STOPPED_MESSAGE, sessionId };
        return;
      }

      this.logger.error("ACP prompt failed.", { error: outcome.error, sessionId });
      yield { type: "error", message: formatAcpError(outcome.error) };
      return;
    }

    const stopReason = outcome.response?.stopReason;

    if (stopReason === "cancelled" || activePrompt.stopRequested) {
      yield { type: "stopped", message: STOPPED_MESSAGE, sessionId };
      return;
    }

    if (stopReason === undefined) {
      yield { type: "error", message: NO_RESULT_MESSAGE };
      return;
    }

    yield { type: "done", sessionId };
  }

  /** Routes an incoming `session/update` notification to its active prompt queue. */
  private handleSessionUpdate(context: AcpConnectionContext, params: SessionNotification): void {
    const activePrompt = context.activePrompts.get(params.sessionId);
    if (activePrompt === undefined) {
      return;
    }

    const event = mapAcpUpdate(params.update, activePrompt.mappingState);
    if (event !== null) {
      activePrompt.queue.push({ kind: "event", event });
    }
  }

  /** Routes a `session/request_permission` request to the active prompt's chat handler. */
  private async handlePermissionRequest(
    context: AcpConnectionContext,
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const activePrompt = context.activePrompts.get(params.sessionId);
    if (activePrompt?.permissionHandler === undefined) {
      return { outcome: { outcome: "cancelled" } };
    }

    return this.handlePermission(params, activePrompt);
  }

  /** Bridges an ACP permission request through the chat permission handler. */
  private async handlePermission(
    params: RequestPermissionRequest,
    activePrompt: ActiveAcpPrompt,
  ): Promise<RequestPermissionResponse> {
    const handler = activePrompt.permissionHandler;
    if (handler === undefined) {
      return { outcome: { outcome: "cancelled" } };
    }

    const toolCall = params.toolCall;
    const toolName = toolCall.title ?? toolCall.kind ?? "tool";
    const toolCallId = toolCall.toolCallId;

    try {
      const decision = await handler({
        toolName,
        input: toRecord(toolCall.rawInput),
        requestId: toolCallId,
        toolUseId: toolCallId,
        signal: activePrompt.permissionAbort.signal,
        ...(typeof toolCall.title === "string" ? { title: toolCall.title } : {}),
      });
      return mapPermissionDecision(decision, params);
    } catch (error: unknown) {
      this.logger.error("ACP permission handling failed.", { error, toolCallId });
      return { outcome: { outcome: "cancelled" } };
    }
  }

  /** Resolves the connection context associated with a session handle. */
  private getSessionContext(session: BackendSession): AcpConnectionContext {
    const context = this.sessionContexts.get(session);
    if (context === undefined) {
      throw new UserFacingError(
        "ACP_SESSION_NOT_OPEN",
        "ACP 会话未打开或已关闭，请重新发送消息。",
      );
    }

    return context;
  }

  /** Terminates the subprocess and drops the cached connection context. */
  private terminateContext(context: AcpConnectionContext): void {
    this.contexts.delete(context.cacheKey);
    for (const activePrompt of context.activePrompts.values()) {
      activePrompt.queue.close();
    }

    try {
      context.child.kill();
    } catch (error: unknown) {
      this.logger.error("ACP subprocess kill failed.", {
        error,
        provider: context.provider,
        cwd: context.cwd,
      });
    }
  }

  /** Returns a provider's subprocess settings or throws a user-safe configuration error. */
  private requireProviderConfig(provider: string): AcpConfig["providers"][string] {
    const providerConfig = this.config?.providers[provider];
    if (providerConfig === undefined) {
      throw new UserFacingError(
        "ACP_NOT_CONFIGURED",
        `未配置 ACP provider：${provider}。请在配置文件的 acp.providers 中添加。`,
      );
    }

    return providerConfig;
  }
}

/** Coerces an ACP `rawInput` (typed `unknown`) into a record for the permission handler. */
function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** Maps an allow/deny decision back to an ACP permission outcome. */
function mapPermissionDecision(
  decision: AgentPermissionDecision,
  params: RequestPermissionRequest,
): RequestPermissionResponse {
  const wantAllow = decision.behavior === "allow";
  const preferredKinds = wantAllow
    ? (["allow_once", "allow_always"] as const)
    : (["reject_once", "reject_always"] as const);

  for (const kind of preferredKinds) {
    const option = params.options.find((candidate) => candidate.kind === kind);
    if (option !== undefined) {
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    }
  }

  return { outcome: { outcome: "cancelled" } };
}

/** Ensures only ACP environments are opened by this adapter. */
function assertAcpEnvironment(environment: AgentEnvironment): void {
  if (environment.backend !== ACP_BACKEND) {
    throw new UserFacingError(
      "ACP_BACKEND_MISMATCH",
      `ACP adapter cannot open backend: ${environment.backend}`,
    );
  }
}

/** Ensures only ACP backend sessions are sent through this adapter. */
function assertAcpSession(session: BackendSession): asserts session is AcpBackendSession {
  if (session.backend !== ACP_BACKEND) {
    throw new UserFacingError(
      "ACP_BACKEND_MISMATCH",
      `ACP adapter cannot handle backend session: ${session.backend}`,
    );
  }
}

/** Formats ACP protocol and runtime errors for safe user-visible AgentEvent values. */
function formatAcpError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return `ACP 执行失败：${redactLogString(error.message)}`;
  }

  return `ACP 执行失败：${redactLogString(String(error))}`;
}
