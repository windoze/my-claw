/** Default slash command handlers and shared handler contracts. */

import type { IncomingMessage } from "../messages/types.js";
import type { ReplySink } from "../output/types.js";
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

const SUPPORTED_COMMANDS = "/cc、/close、/state、/stop、/oc";

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

/** Handles `/state` until SessionManager state summaries are wired in T10/T11. */
export async function handleStatePlaceholder({
  replySink,
}: CommandHandlerContext<KnownCommandParseResult>): Promise<void> {
  await replySink.sendMarkdown("### 当前状态\n\n状态查询将在 SessionManager 接入后启用。");
}

/** Handles `/oc` while OpenCode support is intentionally deferred to phase two. */
export async function handleOpenCodePlaceholder({
  replySink,
}: CommandHandlerContext<KnownCommandParseResult>): Promise<void> {
  await replySink.sendText("OpenCode 尚未启用，将在第二阶段支持。");
}

/** Acknowledges commands whose real behavior depends on the future SessionManager. */
export async function handleSessionCommandPlaceholder({
  command,
  replySink,
}: CommandHandlerContext<KnownCommandParseResult>): Promise<void> {
  await replySink.sendText(
    `命令 /${command.name} 已识别，具体执行逻辑将在 SessionManager 接入后启用。`,
  );
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
