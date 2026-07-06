/** Default slash command handlers and shared handler contracts. */

import type { IncomingMessage } from "../messages/types.js";
import { formatState } from "../output/formatState.js";
import type { ReplySink } from "../output/types.js";
import type { RuntimeTaskSummary, SessionManager } from "../session/SessionManager.js";
import { UserFacingError } from "../utils/errors.js";
import type {
  InvalidCommandParseResult,
  KnownCommandParseResult,
  SlashCommandName,
  UnknownCommandParseResult,
} from "./types.js";

export type HandledCommandParseResult =
  | KnownCommandParseResult
  | UnknownCommandParseResult
  | InvalidCommandParseResult;

export interface CommandHandlerContext<
  TCommand extends HandledCommandParseResult = KnownCommandParseResult,
> {
  message: IncomingMessage;
  replySink: ReplySink;
  command: TCommand;
}

export type CommandHandler<
  TCommand extends HandledCommandParseResult = KnownCommandParseResult,
> = (context: CommandHandlerContext<TCommand>) => Promise<void> | void;

export type CommandHandlers = Record<SlashCommandName, CommandHandler<KnownCommandParseResult>> & {
  invalid: CommandHandler<InvalidCommandParseResult>;
  unknown: CommandHandler<UnknownCommandParseResult>;
};

export interface StopCommandCallbackContext {
  message: IncomingMessage;
  currentTask: RuntimeTaskSummary | null;
}

export type StopCommandCallback = (
  context: StopCommandCallbackContext,
) => Promise<void> | void;

export interface SessionCommandHandlersOptions {
  sessionManager: SessionManager;
  stopCurrentTask?: StopCommandCallback;
}

const SUPPORTED_COMMANDS = "/cc、/close、/state、/stop、/oc";
const CC_USAGE = '用法：/cc <dir>。如果路径包含空格，请使用引号，例如：/cc "/Users/me/My Repo"。';
const OC_USAGE = '用法：/oc <dir>。如果路径包含空格，请使用引号，例如：/oc "/Users/me/My Repo"。';

/** Creates the first-stage handler set used by CommandRouter by default. */
export function createDefaultCommandHandlers(): CommandHandlers {
  return {
    cc: handleSessionCommandPlaceholder,
    close: handleSessionCommandPlaceholder,
    state: handleStatePlaceholder,
    stop: handleSessionCommandPlaceholder,
    oc: handleOpenCodePlaceholder,
    invalid: handleInvalidCommand,
    unknown: handleUnknownCommand,
  };
}

/** Creates command handlers backed by the first-stage SessionManager state machine. */
export function createSessionCommandHandlers(
  options: SessionCommandHandlersOptions,
): CommandHandlers {
  return {
    cc: (context) => handleClaudeProjectCommand(context, options.sessionManager),
    close: (context) => handleCloseProjectCommand(context, options.sessionManager),
    state: (context) => handleStateCommand(context, options.sessionManager),
    stop: (context) =>
      handleStopCommand(context, options.sessionManager, options.stopCurrentTask),
    oc: (context) => handleOpenCodeProjectCommand(context, options.sessionManager),
    invalid: handleInvalidCommand,
    unknown: handleUnknownCommand,
  };
}

/** Handles `/state` by rendering a sanitized SessionManager summary as Markdown. */
export async function handleStateCommand(
  { replySink }: CommandHandlerContext<KnownCommandParseResult>,
  sessionManager: SessionManager,
): Promise<void> {
  const summary = await sessionManager.getStateSummary();
  await replySink.sendMarkdown(formatState(summary));
}

/** Handles `/state` until a SessionManager is supplied to CommandRouter. */
export async function handleStatePlaceholder({
  replySink,
}: CommandHandlerContext<KnownCommandParseResult>): Promise<void> {
  await replySink.sendMarkdown("### 当前状态\n\n状态查询需要先接入 SessionManager。");
}

/** Handles `/oc` until a SessionManager is supplied to CommandRouter. */
export async function handleOpenCodePlaceholder({
  replySink,
}: CommandHandlerContext<KnownCommandParseResult>): Promise<void> {
  await replySink.sendText(
    "命令 /oc 已识别，但当前 CommandRouter 尚未接入 SessionManager。",
  );
}

/** Acknowledges commands whose real behavior requires a supplied SessionManager. */
export async function handleSessionCommandPlaceholder({
  command,
  replySink,
}: CommandHandlerContext<KnownCommandParseResult>): Promise<void> {
  await replySink.sendText(
    `命令 /${command.name} 已识别，但当前 CommandRouter 尚未接入 SessionManager。`,
  );
}

/** Handles `/cc <dir>` by opening an allowlisted Claude Code project directory. */
export async function handleClaudeProjectCommand(
  { command, replySink }: CommandHandlerContext<KnownCommandParseResult>,
  sessionManager: SessionManager,
): Promise<void> {
  await sessionManager.assertCanAcceptCommand("cc");
  const dir = readSingleDirectoryArgument(command, CC_USAGE);

  if (dir === null) {
    await replySink.sendText(CC_USAGE);
    return;
  }

  const result = await sessionManager.openClaudeProject(dir);
  await replySink.sendText(`已切换到 Claude Code 项目：${result.environment.cwd}`);
}

/** Handles `/oc <dir>` by opening an allowlisted OpenCode project directory. */
export async function handleOpenCodeProjectCommand(
  { command, replySink }: CommandHandlerContext<KnownCommandParseResult>,
  sessionManager: SessionManager,
): Promise<void> {
  await sessionManager.assertCanAcceptCommand("oc");
  const dir = readSingleDirectoryArgument(command, OC_USAGE);

  if (dir === null) {
    await replySink.sendText(OC_USAGE);
    return;
  }

  const result = await sessionManager.openOpenCodeProject(dir);
  await replySink.sendText(`已切换到 OpenCode 项目：${result.environment.cwd}`);
}

/** Handles `/close` by returning command routing to the configured default environment. */
export async function handleCloseProjectCommand(
  { replySink }: CommandHandlerContext<KnownCommandParseResult>,
  sessionManager: SessionManager,
): Promise<void> {
  await sessionManager.assertCanAcceptCommand("close");
  const result = await sessionManager.closeProject();

  if (result.closedProject === null) {
    await replySink.sendText(`当前没有打开的项目，继续使用默认环境：${result.environment.cwd}`);
    return;
  }

  await replySink.sendText(
    `已关闭项目：${result.closedProject.cwd}\n当前使用默认环境：${result.environment.cwd}`,
  );
}

/** Handles `/stop` state decisions and invokes the injected backend stop callback when available. */
export async function handleStopCommand(
  context: CommandHandlerContext<KnownCommandParseResult>,
  sessionManager: SessionManager,
  stopCurrentTask?: StopCommandCallback,
): Promise<void> {
  const stopState = await sessionManager.getStopState();

  if (!stopState.canRequestStop) {
    await context.replySink.sendText(stopState.message);
    return;
  }

  const requestStop = stopCurrentTask ?? (() => sessionManager.requestStopCurrentTask());
  await context.replySink.sendText("已请求中断当前 Agent 任务。");
  await requestStop({
    message: context.message,
    currentTask: stopState.currentTask,
  });
}

/** Reports command syntax errors without letting malformed slash commands reach Agent backends. */
export async function handleInvalidCommand({
  command,
  replySink,
}: CommandHandlerContext<InvalidCommandParseResult>): Promise<void> {
  await replySink.sendText(`命令格式错误：${command.error.message}`);
}

/** Reports unsupported slash commands and lists commands known in the first stage. */
export async function handleUnknownCommand({
  command,
  replySink,
}: CommandHandlerContext<UnknownCommandParseResult>): Promise<void> {
  const displayName = command.rawName.length > 0 ? `/${command.rawName}` : "/";
  await replySink.sendText(`不支持的命令：${displayName}。当前支持：${SUPPORTED_COMMANDS}。`);
}

/** Reads the single directory argument expected by project-switching commands. */
function readSingleDirectoryArgument(
  command: KnownCommandParseResult,
  usage: string,
): string | null {
  if (command.args.length === 0) {
    return null;
  }

  if (command.args.length > 1) {
    throw new UserFacingError("COMMAND_USAGE_INVALID", usage);
  }

  return command.args[0] ?? null;
}
