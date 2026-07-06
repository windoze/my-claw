/** Application composition and shared incoming-message routing. */

import {
  BackendRegistry,
  ClaudeCodeAdapter,
  type AgentEvent,
  type BackendAdapter,
  type BackendSession,
} from "./backend/index.js";
import { CommandRouter } from "./commands/index.js";
import { loadConfig } from "./config/index.js";
import type { AppConfig } from "./config/types.js";
import type { IncomingMessage } from "./messages/types.js";
import { OutputRenderer } from "./output/index.js";
import type { ReplySink } from "./output/types.js";
import { createSessionManager, type SessionManager } from "./session/index.js";
import { StateStore } from "./state/index.js";
import { createLogger, UserFacingError, type Logger } from "./utils/index.js";

const logger = createLogger("app");
const NORMAL_MESSAGE_BUSY_MESSAGE = "Agent 正在运行，发送 /stop 可中断当前任务。";
const NORMAL_MESSAGE_STOPPING_MESSAGE = "当前任务正在中断，请稍候。";
const GENERIC_AGENT_ERROR_MESSAGE = "Agent 执行失败，请稍后重试或查看服务日志。";

/** Result returned after one incoming message has been routed. */
export interface HandleIncomingMessageResult {
  handledByCommand: boolean;
  backendEvents: readonly AgentEvent[];
}

/** Dependencies required by the shared incoming message handler. */
export interface HandleIncomingMessageOptions {
  commandRouter: CommandRouter;
  sessionManager: SessionManager;
  backendRegistry: BackendRegistry;
  outputRenderer: OutputRenderer;
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
  commandRouter: CommandRouter;
  handleIncomingMessage: IncomingMessageHandler;
}

/** Starts the gateway after loading and validating runtime configuration. */
export async function startApp(): Promise<AppRuntime> {
  const config = await loadConfig();
  const stateStore = new StateStore({ logger: createLogger("state") });
  await stateStore.load();
  const sessionManager = await createSessionManager({ config, stateStore });
  const backendRegistry = new BackendRegistry([
    [
      "claude-code",
      new ClaudeCodeAdapter({
        config: config.claudeCode,
        logger: createLogger("backend:claude-code"),
      }),
    ],
  ]);
  const outputRenderer = new OutputRenderer({
    config: config.output,
    logger: createLogger("output"),
  });
  const commandRouter = new CommandRouter({
    sessionManager,
    logger: createLogger("commands"),
  });
  const handleIncomingMessage = createIncomingMessageHandler({
    commandRouter,
    sessionManager,
    backendRegistry,
    outputRenderer,
    logger: createLogger("messages"),
  });

  logger.info(
    `DingTalk Agent gateway starting with ${config.defaultEnvironment.backend} backend.`,
  );

  return {
    config,
    stateStore,
    sessionManager,
    backendRegistry,
    outputRenderer,
    commandRouter,
    handleIncomingMessage,
  };
}

/** Creates a two-argument handler suitable for adapter injection. */
export function createIncomingMessageHandler(
  options: HandleIncomingMessageOptions,
): IncomingMessageHandler {
  return (message, replySink) => handleIncomingMessage(message, replySink, options);
}

/** Routes slash commands or ordinary messages through the current Agent backend. */
export async function handleIncomingMessage(
  message: IncomingMessage,
  replySink: ReplySink,
  options: HandleIncomingMessageOptions,
): Promise<HandleIncomingMessageResult> {
  const handledByCommand = await options.commandRouter.handle(message, replySink);

  if (handledByCommand) {
    return { handledByCommand: true, backendEvents: [] };
  }

  return handleNormalMessage(message, replySink, options);
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
    return { handledByCommand: false, backendEvents: [] };
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
    events = await collectAgentEvents(
      backend.send(session, { text: message.text, messageId: message.id }),
    );
    await saveDoneSessionId(events, environment, options.sessionManager);
    await options.outputRenderer.render(events, replySink);
  } catch (error: unknown) {
    await replyNormalMessageError(error, message, replySink, handlerLogger, options);
  } finally {
    if (backend !== null && session !== null) {
      await closeBackendSession(backend, session, handlerLogger);
    }

    if (taskStarted) {
      await options.sessionManager.markIdle();
    }
  }

  return { handledByCommand: false, backendEvents: events };
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

/** Collects a backend event stream before the renderer sends user-visible output. */
async function collectAgentEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collectedEvents: AgentEvent[] = [];

  for await (const event of events) {
    collectedEvents.push(event);
  }

  return collectedEvents;
}

/** Persists the latest backend session id emitted by a completion event. */
async function saveDoneSessionId(
  events: readonly AgentEvent[],
  environment: Awaited<ReturnType<SessionManager["getCurrentEnvironment"]>>,
  sessionManager: SessionManager,
): Promise<void> {
  const doneWithSession = findLastDoneSessionEvent(events);

  if (doneWithSession !== undefined) {
    await sessionManager.saveSessionId(environment, doneWithSession.sessionId);
  }
}

/** Finds the newest completion event that carries durable backend session metadata. */
function findLastDoneSessionEvent(
  events: readonly AgentEvent[],
): (Extract<AgentEvent, { type: "done" }> & { sessionId: string }) | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event !== undefined && isDoneSessionEvent(event)) {
      return event;
    }
  }

  return undefined;
}

/** Narrows backend events to completion events that contain a concrete session id. */
function isDoneSessionEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: "done" }> & { sessionId: string } {
  return event.type === "done" && event.sessionId !== undefined;
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
