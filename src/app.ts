/** Application composition and shared incoming-message routing. */

import {
  BackendRegistry,
  ClaudeCodeAdapter,
  OpenCodeAdapter,
  type AgentEvent,
  type BackendAdapter,
  type BackendSession,
} from "./backend/index.js";
import { CommandRouter } from "./commands/index.js";
import { loadConfig, type LoadConfigOptions } from "./config/index.js";
import type { AppConfig } from "./config/types.js";
import {
  createDingTalkAttachmentResolver,
  DingTalkAdapter,
  DingTalkMediaClient,
  type DingTalkAttachmentResolver,
  type DingTalkStreamClientFactory,
} from "./dingtalk/index.js";
import { FileService, TempFileStore } from "./files/index.js";
import type { IncomingMessage } from "./messages/types.js";
import {
  extractLocalRefs,
  OutputRenderer,
  renderAgentEventMessages,
} from "./output/index.js";
import type { ReplySink } from "./output/types.js";
import { PermissionPromptManager } from "./permissions/index.js";
import { PathPolicy, SecurityGate, type SecurityGateDecision } from "./security/index.js";
import { createSessionManager, type SessionManager } from "./session/index.js";
import { StateStore } from "./state/index.js";
import { AppError, createLogger, UserFacingError, type Logger } from "./utils/index.js";

const logger = createLogger("app");
const NORMAL_MESSAGE_BUSY_MESSAGE = "Agent 正在运行，发送 /stop 可中断当前任务。";
const NORMAL_MESSAGE_STOPPING_MESSAGE = "当前任务正在中断，请稍候。";
const GENERIC_AGENT_ERROR_MESSAGE = "Agent 执行失败，请稍后重试或查看服务日志。";
const GENERIC_MESSAGE_ERROR_MESSAGE = "消息处理失败，请稍后重试或查看服务日志。";

/** Result returned after one incoming message has been routed. */
export interface HandleIncomingMessageResult {
  authorized: boolean;
  handledByCommand: boolean;
  backendEvents: readonly AgentEvent[];
}

/** Dependencies required by the shared incoming message handler. */
export interface HandleIncomingMessageOptions {
  commandRouter: CommandRouter;
  sessionManager: SessionManager;
  backendRegistry: BackendRegistry;
  outputRenderer: OutputRenderer;
  securityGate?: SecurityGate;
  attachmentResolver?: DingTalkAttachmentResolver;
  permissionPromptManager?: PermissionPromptManager;
  fileService?: FileService;
  logger?: Logger;
  genericErrorMessage?: string;
}

/** Callable message handler shape injected into local tests and DingTalk later. */
export type IncomingMessageHandler = (
  message: IncomingMessage,
  replySink: ReplySink,
) => Promise<HandleIncomingMessageResult>;

/** Runtime objects assembled by startApp for the current process. */
export interface AppRuntime {
  config: AppConfig;
  stateStore: StateStore;
  sessionManager: SessionManager;
  backendRegistry: BackendRegistry;
  outputRenderer: OutputRenderer;
  permissionPromptManager: PermissionPromptManager;
  fileService: FileService;
  tempFileStore: TempFileStore;
  commandRouter: CommandRouter;
  securityGate: SecurityGate;
  dingtalkAdapter: DingTalkAdapter;
  handleIncomingMessage: IncomingMessageHandler;
  close(): Promise<void>;
}

/** Optional startup overrides used by focused checks and embedders. */
export interface StartAppOptions extends LoadConfigOptions {
  statePath?: string;
  dingtalkClientFactory?: DingTalkStreamClientFactory;
}

/** Starts the gateway after loading and validating runtime configuration. */
export async function startApp(options: StartAppOptions = {}): Promise<AppRuntime> {
  const config = await loadConfig(options);
  const stateStore = new StateStore({
    statePath: options.statePath,
    cwd: options.cwd,
    logger: createLogger("state"),
  });
  await stateStore.load();
  const sessionManager = await createSessionManager({ config, stateStore });
  const openCodeAdapter = new OpenCodeAdapter({
    logger: createLogger("backend:opencode"),
  });
  const backendRegistry = new BackendRegistry([
    [
      "claude-code",
      new ClaudeCodeAdapter({
        config: config.claudeCode,
        logger: createLogger("backend:claude-code"),
      }),
    ],
    ["opencode", openCodeAdapter],
  ]);
  const outputRenderer = new OutputRenderer({
    config: config.output,
    streaming: config.streaming,
    logger: createLogger("output"),
  });
  const permissionPromptManager = new PermissionPromptManager({
    logger: createLogger("permissions"),
  });
  const fileService = new FileService({
    pathPolicy: await PathPolicy.create(config.security.downloadAllowedDirs),
    maxFileBytes: config.security.maxDownloadFileBytes,
    logger: createLogger("files"),
  });
  const tempFileStore = new TempFileStore({
    rootDir: config.security.attachmentTempDir,
    maxFileBytes: config.security.maxAttachmentFileBytes,
    allowedMimeTypes: config.security.allowedAttachmentMimeTypes,
    logger: createLogger("files:temp"),
  });
  await tempFileStore.start();
  const commandRouter = new CommandRouter({
    sessionManager,
    fileService,
    logger: createLogger("commands"),
  });
  const attachmentResolver = createDingTalkAttachmentResolver({
    mediaClient: new DingTalkMediaClient({
      config: config.dingtalk,
      logger: createLogger("dingtalk:media"),
    }),
    tempFileStore,
    logger: createLogger("dingtalk:attachments"),
  });
  const securityGate = new SecurityGate({
    config: config.dingtalk,
    logger: createLogger("security"),
  });
  const handleIncomingMessage = createIncomingMessageHandler({
    commandRouter,
    sessionManager,
    backendRegistry,
    outputRenderer,
    securityGate,
    attachmentResolver,
    permissionPromptManager,
    fileService,
    logger: createLogger("messages"),
  });
  const dingtalkAdapter = new DingTalkAdapter({
    config: config.dingtalk,
    streaming: config.streaming,
    handler: handleIncomingMessage,
    clientFactory: options.dingtalkClientFactory,
    logger: createLogger("dingtalk"),
  });
  const close = createAppRuntimeClose({
    dingtalkAdapter,
    sessionManager,
    openCodeAdapter,
    tempFileStore,
    logger: createLogger("shutdown"),
  });

  logger.info(
    `DingTalk Agent gateway starting with ${config.defaultEnvironment.backend} backend.`,
  );

  const runtime: AppRuntime = {
    config,
    stateStore,
    sessionManager,
    backendRegistry,
    outputRenderer,
    permissionPromptManager,
    fileService,
    tempFileStore,
    commandRouter,
    securityGate,
    dingtalkAdapter,
    handleIncomingMessage,
    close,
  };

  try {
    await dingtalkAdapter.start();
  } catch (error: unknown) {
    await close();
    throw error;
  }

  logger.info("DingTalk Agent gateway started.");

  return runtime;
}

interface AppRuntimeCloseOptions {
  dingtalkAdapter: DingTalkAdapter;
  sessionManager: SessionManager;
  openCodeAdapter: OpenCodeAdapter;
  tempFileStore: TempFileStore;
  logger: Logger;
}

/** Creates an idempotent shutdown hook for stream and active backend resources. */
function createAppRuntimeClose(options: AppRuntimeCloseOptions): () => Promise<void> {
  let closed = false;

  return async (): Promise<void> => {
    if (closed) {
      return;
    }

    closed = true;
    try {
      options.dingtalkAdapter.close();
    } catch (error: unknown) {
      options.logger.error("DingTalk Stream cleanup failed during shutdown.", { error });
    }

    try {
      await options.sessionManager.closeCurrentTaskControl();
    } catch (error: unknown) {
      options.logger.error("Active backend task cleanup failed during shutdown.", { error });
    }

    try {
      await options.openCodeAdapter.dispose();
    } catch (error: unknown) {
      options.logger.error("OpenCode backend cleanup failed during shutdown.", { error });
    }

    try {
      options.tempFileStore.close();
    } catch (error: unknown) {
      options.logger.error("Attachment temp store cleanup failed during shutdown.", { error });
    }
  };
}

/** Creates a two-argument handler suitable for adapter injection. */
export function createIncomingMessageHandler(
  options: HandleIncomingMessageOptions,
): IncomingMessageHandler {
  return (message, replySink) => safelyHandleIncomingMessage(message, replySink, options);
}

/** Wraps every inbound message entrypoint so callback failures never exit the process. */
async function safelyHandleIncomingMessage(
  message: IncomingMessage,
  replySink: ReplySink,
  options: HandleIncomingMessageOptions,
): Promise<HandleIncomingMessageResult> {
  try {
    return await handleIncomingMessage(message, replySink, options);
  } catch (error: unknown) {
    return handleIncomingMessageFailure(error, message, replySink, options);
  }
}

/** Converts top-level routing failures into safe replies and detailed logs. */
async function handleIncomingMessageFailure(
  error: unknown,
  message: IncomingMessage,
  replySink: ReplySink,
  options: HandleIncomingMessageOptions,
): Promise<HandleIncomingMessageResult> {
  const handlerLogger = options.logger ?? createLogger("messages");

  if (isReplySinkError(error)) {
    handlerLogger.error("Incoming message reply failed.", {
      error,
      messageId: message.id,
      senderId: message.senderId,
    });
    return createFailedHandleResult();
  }

  if (error instanceof UserFacingError) {
    await sendFailureReply(replySink, error.safeMessage ?? error.message, handlerLogger, message);
    return createFailedHandleResult();
  }

  handlerLogger.error("Incoming message handling failed.", {
    error,
    messageId: message.id,
    senderId: message.senderId,
  });
  await sendFailureReply(
    replySink,
    options.genericErrorMessage ?? GENERIC_MESSAGE_ERROR_MESSAGE,
    handlerLogger,
    message,
  );

  return createFailedHandleResult();
}

/** Sends an error reply without allowing a failed fallback reply to escape the entrypoint. */
async function sendFailureReply(
  replySink: ReplySink,
  text: string,
  handlerLogger: Logger,
  message: IncomingMessage,
): Promise<void> {
  try {
    await replySink.sendText(text);
  } catch (replyError: unknown) {
    handlerLogger.error("Failed to send incoming message error reply.", {
      error: replyError,
      messageId: message.id,
      senderId: message.senderId,
    });
  }
}

/** Identifies failures from the DingTalk reply sink so the same failing sink is not retried. */
function isReplySinkError(error: unknown): boolean {
  return error instanceof AppError && error.code.startsWith("DINGTALK_REPLY_");
}

/** Returns the conservative result shape used when routing failed before completion. */
function createFailedHandleResult(): HandleIncomingMessageResult {
  return {
    authorized: true,
    handledByCommand: false,
    backendEvents: [],
  };
}

/** Routes slash commands or ordinary messages through the current Agent backend. */
export async function handleIncomingMessage(
  message: IncomingMessage,
  replySink: ReplySink,
  options: HandleIncomingMessageOptions,
): Promise<HandleIncomingMessageResult> {
  const authorization = await authorizeIncomingMessage(message, replySink, options);

  if (!authorization.allowed) {
    return { authorized: false, handledByCommand: false, backendEvents: [] };
  }

  if (await handlePendingPermissionResponse(message, replySink, options)) {
    return { authorized: true, handledByCommand: true, backendEvents: [] };
  }

  const handledByCommand = await options.commandRouter.handle(message, replySink);

  if (handledByCommand) {
    return { authorized: true, handledByCommand: true, backendEvents: [] };
  }

  const resolvedMessage = await resolveIncomingAttachments(message, options);
  return handleNormalMessage(resolvedMessage, replySink, options);
}

/** Gives pending Claude Code permission replies priority over normal busy rejection. */
async function handlePendingPermissionResponse(
  message: IncomingMessage,
  replySink: ReplySink,
  options: HandleIncomingMessageOptions,
): Promise<boolean> {
  if (options.permissionPromptManager === undefined) {
    return false;
  }

  return options.permissionPromptManager.handleResponse(message, replySink);
}

/** Downloads authorized attachment metadata to local temp files before routing. */
async function resolveIncomingAttachments(
  message: IncomingMessage,
  options: HandleIncomingMessageOptions,
): Promise<IncomingMessage> {
  if (options.attachmentResolver === undefined) {
    return message;
  }

  return options.attachmentResolver(message);
}

/** Enforces optional security before any command or backend side effect can run. */
async function authorizeIncomingMessage(
  message: IncomingMessage,
  replySink: ReplySink,
  options: HandleIncomingMessageOptions,
): Promise<SecurityGateDecision> {
  const securityGate = options.securityGate;

  if (securityGate === undefined) {
    return { allowed: true };
  }

  const decision = securityGate.authorize(message);

  if (!decision.allowed && decision.replyText !== undefined) {
    await replySink.sendText(decision.replyText);
  }

  return decision;
}

/** Handles non-command text by enforcing runtime state and invoking the selected backend. */
async function handleNormalMessage(
  message: IncomingMessage,
  replySink: ReplySink,
  options: HandleIncomingMessageOptions,
): Promise<HandleIncomingMessageResult> {
  const handlerLogger = options.logger ?? createLogger("messages");

  if (!(await options.sessionManager.canAcceptNormalMessage())) {
    await replyNormalMessageRejected(options.sessionManager, replySink);
    return { authorized: true, handledByCommand: false, backendEvents: [] };
  }

  let taskStarted = false;
  let backend: BackendAdapter | null = null;
  let session: BackendSession | null = null;
  let events: AgentEvent[] = [];

  try {
    await options.sessionManager.startTask({ messageId: message.id });
    taskStarted = true;

    const environment = await options.sessionManager.getCurrentEnvironment();
    backend = options.backendRegistry.get(environment);
    session = await backend.open(environment);
    const activeBackend = backend;
    const activeSession = session;
    options.sessionManager.setCurrentTaskControl({
      session: activeSession,
      stop: () => activeBackend.stop(activeSession),
      close: () => activeBackend.close(activeSession),
    });
    events = await options.outputRenderer.renderStream(
      backend.send(session, {
        text: message.text,
        messageId: message.id,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(options.permissionPromptManager !== undefined
          ? {
              permissionHandler: options.permissionPromptManager.createHandler({
                message,
                replySink,
              }),
            }
          : {}),
      }),
      replySink,
      {
        taskId: message.id,
      },
    );
    await saveTerminalSessionId(events, environment, options.sessionManager);
    await emitReferencedAttachments(events, message, replySink, environment.cwd, options);
  } catch (error: unknown) {
    await replyNormalMessageError(error, message, replySink, handlerLogger, options);
  } finally {
    if (session !== null) {
      options.sessionManager.clearCurrentTaskControl(session);
    }

    if (backend !== null && session !== null) {
      await closeBackendSession(backend, session, handlerLogger);
    }

    if (taskStarted) {
      await options.sessionManager.markIdle();
    }
  }

  return { authorized: true, handledByCommand: false, backendEvents: events };
}

/** Sends the state-specific rejection used when another normal message is already active. */
async function replyNormalMessageRejected(
  sessionManager: SessionManager,
  replySink: ReplySink,
): Promise<void> {
  const summary = await sessionManager.getStateSummary();

  if (summary.runtime.status === "stopping") {
    await replySink.sendText(NORMAL_MESSAGE_STOPPING_MESSAGE);
    return;
  }

  await replySink.sendText(NORMAL_MESSAGE_BUSY_MESSAGE);
}

/** Converts unexpected routing failures into safe replies and detailed logs. */
async function replyNormalMessageError(
  error: unknown,
  message: IncomingMessage,
  replySink: ReplySink,
  handlerLogger: Logger,
  options: HandleIncomingMessageOptions,
): Promise<void> {
  if (error instanceof UserFacingError) {
    await replySink.sendText(formatUserFacingNormalMessageError(error));
    return;
  }

  handlerLogger.error("Incoming normal message handling failed.", {
    error,
    messageId: message.id,
    senderId: message.senderId,
  });
  await replySink.sendText(options.genericErrorMessage ?? GENERIC_AGENT_ERROR_MESSAGE);
}

/** Uses the task-specific busy text for ordinary-message concurrency errors. */
function formatUserFacingNormalMessageError(error: UserFacingError): string {
  if (error.code === "SESSION_TASK_BUSY") {
    return NORMAL_MESSAGE_BUSY_MESSAGE;
  }

  if (error.code === "SESSION_TASK_STOPPING") {
    return NORMAL_MESSAGE_STOPPING_MESSAGE;
  }

  return error.safeMessage ?? error.message;
}

/**
 * Best-effort delivery of local files the Agent referenced in its Markdown reply.
 *
 * Rebuilds the reply text, extracts local image/file references, and sends each one
 * as a standalone DingTalk image/file message reusing FileService (PathPolicy bounds,
 * size limits, image/file routing). Every failure is swallowed and logged so a bad
 * reference never turns into a user-facing error or interrupts the reply flow.
 */
async function emitReferencedAttachments(
  events: readonly AgentEvent[],
  message: IncomingMessage,
  replySink: ReplySink,
  baseDir: string,
  options: HandleIncomingMessageOptions,
): Promise<void> {
  const fileService = options.fileService;

  if (fileService === undefined) {
    return;
  }

  const handlerLogger = options.logger ?? createLogger("messages");
  const markdown = renderAgentEventMessages(events, handlerLogger).join("\n\n");
  const { paths, dropped } = extractLocalRefs(markdown);

  if (dropped > 0) {
    handlerLogger.warn("Dropped referenced attachments over the per-reply limit.", {
      messageId: message.id,
      senderId: message.senderId,
      dropped,
    });
  }

  for (const inputPath of paths) {
    try {
      await fileService.sendLocalFile({
        inputPath,
        baseDir,
        senderId: message.senderId,
        replySink,
      });
    } catch (error: unknown) {
      handlerLogger.warn("Skipped referenced attachment delivery.", {
        error,
        messageId: message.id,
        senderId: message.senderId,
        inputPath,
      });
    }
  }
}

/** Persists the latest backend session id emitted by a terminal event. */
async function saveTerminalSessionId(
  events: readonly AgentEvent[],
  environment: Awaited<ReturnType<SessionManager["getCurrentEnvironment"]>>,
  sessionManager: SessionManager,
): Promise<void> {
  const terminalEvent = findLastTerminalSessionEvent(events);

  if (terminalEvent !== undefined) {
    await sessionManager.saveSessionId(environment, terminalEvent.sessionId);
  }
}

/** Finds the newest terminal event that carries durable backend session metadata. */
function findLastTerminalSessionEvent(
  events: readonly AgentEvent[],
): (Extract<AgentEvent, { type: "done" | "stopped" }> & { sessionId: string }) | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event !== undefined && isTerminalSessionEvent(event)) {
      return event;
    }
  }

  return undefined;
}

/** Narrows backend events to terminal events that contain a concrete session id. */
function isTerminalSessionEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: "done" | "stopped" }> & { sessionId: string } {
  return (event.type === "done" || event.type === "stopped") && event.sessionId !== undefined;
}

/** Closes backend resources while still allowing runtime state to be restored. */
async function closeBackendSession(
  backend: BackendAdapter,
  session: BackendSession,
  handlerLogger: Logger,
): Promise<void> {
  try {
    await backend.close(session);
  } catch (error: unknown) {
    handlerLogger.error("Backend session close failed.", {
      error,
      backend: session.backend,
      cwd: session.cwd,
    });
  }
}
