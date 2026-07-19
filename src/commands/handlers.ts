/** Default slash command handlers and shared handler contracts. */

import type { IncomingMessage } from "../messages/types.js";
import { formatState } from "../output/formatState.js";
import type { ReplySink } from "../output/types.js";
import type { RuntimeTaskSummary, SessionManager } from "../session/SessionManager.js";
import type { FileService } from "../files/FileService.js";
import type { ScreenshotService } from "../files/ScreenshotService.js";
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
  fileService?: FileService;
  screenshotService?: ScreenshotService;
  stopCurrentTask?: StopCommandCallback;
}

const SUPPORTED_COMMANDS = "/cc、/close、/state、/stop、/new、/oc、/acp、/dl、/screenshot";
const CC_USAGE = '用法：/cc <dir>。如果路径包含空格，请使用引号，例如：/cc "/Users/me/My Repo"。';
const OC_USAGE = '用法：/oc <dir>。如果路径包含空格，请使用引号，例如：/oc "/Users/me/My Repo"。';
const ACP_USAGE_BASE =
  '用法：/acp [provider] [dir]。省略 provider 时使用默认 provider；路径包含空格时请使用引号，例如：/acp claude "/Users/me/My Repo"。';
const DL_USAGE = '用法：/dl <path>。相对路径基于当前环境目录；路径包含空格时请使用引号，例如：/dl "docs/report.pdf"。';
const NEW_USAGE = "用法：/new。结束当前环境的会话，下一条普通消息将开启新会话。";
const SCREENSHOT_USAGE = "用法：/screenshot。截取主屏幕并发送，无需参数。";

/** Creates the first-stage handler set used by CommandRouter by default. */
export function createDefaultCommandHandlers(): CommandHandlers {
  return {
    cc: handleSessionCommandPlaceholder,
    close: handleSessionCommandPlaceholder,
    state: handleStatePlaceholder,
    stop: handleSessionCommandPlaceholder,
    new: handleSessionCommandPlaceholder,
    oc: handleOpenCodePlaceholder,
    acp: handleSessionCommandPlaceholder,
    dl: handleFileDownloadPlaceholder,
    screenshot: handleScreenshotPlaceholder,
    invalid: handleInvalidCommand,
    unknown: handleUnknownCommand,
  };
}

/** Creates command handlers backed by the first-stage SessionManager state machine. */
export function createSessionCommandHandlers(
  options: SessionCommandHandlersOptions,
): CommandHandlers {
  const fileService = options.fileService;
  const screenshotService = options.screenshotService;

  return {
    cc: (context) => handleClaudeProjectCommand(context, options.sessionManager),
    close: (context) => handleCloseProjectCommand(context, options.sessionManager),
    state: (context) => handleStateCommand(context, options.sessionManager),
    stop: (context) =>
      handleStopCommand(context, options.sessionManager, options.stopCurrentTask),
    new: (context) => handleNewSessionCommand(context, options.sessionManager),
    oc: (context) => handleOpenCodeProjectCommand(context, options.sessionManager),
    acp: (context) => handleAcpProjectCommand(context, options.sessionManager),
    dl:
      fileService === undefined
        ? handleFileDownloadPlaceholder
        : (context) =>
            handleFileDownloadCommand(
              context,
              options.sessionManager,
              fileService,
            ),
    screenshot:
      screenshotService === undefined
        ? handleScreenshotPlaceholder
        : (context) =>
            handleScreenshotCommand(context, options.sessionManager, screenshotService),
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

/** Handles `/dl` until a FileService is supplied to CommandRouter. */
export async function handleFileDownloadPlaceholder({
  replySink,
}: CommandHandlerContext<KnownCommandParseResult>): Promise<void> {
  await replySink.sendText(
    "命令 /dl 已识别，但当前 CommandRouter 尚未接入 FileService。",
  );
}

/** Handles `/screenshot` until a ScreenshotService is supplied to CommandRouter. */
export async function handleScreenshotPlaceholder({
  replySink,
}: CommandHandlerContext<KnownCommandParseResult>): Promise<void> {
  await replySink.sendText(
    "命令 /screenshot 已识别，但当前 CommandRouter 尚未接入 ScreenshotService。",
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

/**
 * Handles `/acp [provider] [dir]` by opening an allowlisted ACP project.
 *
 * Argument forms:
 * - `/acp` — default provider, default working directory.
 * - `/acp <provider>` — a configured provider name; default working directory.
 * - `/acp <dir>` — a single argument that is NOT a known provider is treated as
 *   the directory, with the default provider.
 * - `/acp <provider> <dir>` — both explicit.
 */
export async function handleAcpProjectCommand(
  { command, replySink }: CommandHandlerContext<KnownCommandParseResult>,
  sessionManager: SessionManager,
): Promise<void> {
  await sessionManager.assertCanAcceptCommand("acp");

  const selection = resolveAcpSelection(command, sessionManager);

  if (selection === null) {
    await replySink.sendText(acpUsage(sessionManager));
    return;
  }

  const result = await sessionManager.openAcpProject(selection.dir, selection.provider);
  const providerNote = result.environment.provider ?? selection.provider;
  await replySink.sendText(`已切换到 ACP 项目（${providerNote}）：${result.environment.cwd}`);
}

/** Resolves the provider + directory for `/acp` arguments, or null when usage is invalid. */
function resolveAcpSelection(
  command: KnownCommandParseResult,
  sessionManager: SessionManager,
): { provider: string; dir: string } | null {
  const defaultProvider = sessionManager.getDefaultAcpProvider();

  if (defaultProvider === undefined) {
    // ACP is unconfigured; defer the clear error to openAcpProject via a
    // placeholder provider so the handler reports available providers.
    return { provider: "", dir: "." };
  }

  const providerNames = new Set(sessionManager.getAcpProviderNames());

  if (command.args.length === 0) {
    return { provider: defaultProvider, dir: "." };
  }

  if (command.args.length === 1) {
    const arg = command.args[0] ?? "";
    return providerNames.has(arg)
      ? { provider: arg, dir: "." }
      : { provider: defaultProvider, dir: arg };
  }

  if (command.args.length === 2) {
    return { provider: command.args[0] ?? "", dir: command.args[1] ?? "." };
  }

  return null;
}

/** Builds the `/acp` usage text, appending configured provider names when available. */
function acpUsage(sessionManager: SessionManager): string {
  const providers = sessionManager.getAcpProviderNames();
  return providers.length > 0
    ? `${ACP_USAGE_BASE}\n可用 provider：${providers.join("、")}。`
    : ACP_USAGE_BASE;
}

/** Handles `/dl <path>` by sending an allowlisted local file through the reply sink. */
export async function handleFileDownloadCommand(
  { command, message, replySink }: CommandHandlerContext<KnownCommandParseResult>,
  sessionManager: SessionManager,
  fileService: FileService,
): Promise<void> {
  await sessionManager.assertCanAcceptCommand("dl");
  const filePath = readSinglePathArgument(command, DL_USAGE);

  if (filePath === null) {
    await replySink.sendText(DL_USAGE);
    return;
  }

  const environment = await sessionManager.getCurrentEnvironment();
  const result = await fileService.sendLocalFile({
    inputPath: filePath,
    baseDir: environment.cwd,
    senderId: message.senderId,
    replySink,
  });
  const kind = result.sentAsImage ? "图片" : "文件";
  await replySink.sendText(`已发送${kind}：${result.file.name}`);
}

/** Handles `/screenshot` by capturing the primary display and sending it as an image. */
export async function handleScreenshotCommand(
  { command, replySink }: CommandHandlerContext<KnownCommandParseResult>,
  sessionManager: SessionManager,
  screenshotService: ScreenshotService,
): Promise<void> {
  await sessionManager.assertCanAcceptCommand("screenshot");

  if (command.args.length > 0) {
    throw new UserFacingError("COMMAND_USAGE_INVALID", SCREENSHOT_USAGE);
  }

  const file = await screenshotService.capture();

  try {
    await replySink.sendImage(file);
    await replySink.sendText("已发送截屏。");
  } finally {
    await screenshotService.cleanup(file.path);
  }
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

/** Handles `/new` by clearing the current environment's saved backend session id. */
export async function handleNewSessionCommand(
  { command, replySink }: CommandHandlerContext<KnownCommandParseResult>,
  sessionManager: SessionManager,
): Promise<void> {
  await sessionManager.assertCanAcceptCommand("new");

  if (command.args.length > 0) {
    throw new UserFacingError("COMMAND_USAGE_INVALID", NEW_USAGE);
  }

  const result = await sessionManager.startNewSession();
  const backendName = formatBackendName(result.environment.backend);
  const prefix = result.hadPreviousSession
    ? "已结束当前会话"
    : "当前没有已保存的会话";
  await replySink.sendText(
    `${prefix}；下一条普通消息将开启新的 ${backendName} 会话：${result.environment.cwd}`,
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

/** Reads the single path argument expected by local file commands. */
function readSinglePathArgument(
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

function formatBackendName(backend: string): string {
  switch (backend) {
    case "claude-code":
      return "Claude Code";
    case "opencode":
      return "OpenCode";
    case "acp":
      return "ACP";
    default:
      return backend;
  }
}
