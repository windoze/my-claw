/** Slash command router that dispatches parsed commands to handler functions. */

import type { IncomingMessage } from "../messages/types.js";
import type { ReplySink } from "../output/types.js";
import { UserFacingError } from "../utils/errors.js";
import { createLogger, type Logger } from "../utils/logger.js";
import type { FileService } from "../files/FileService.js";
import {
  createDefaultCommandHandlers,
  createSessionCommandHandlers,
  type CommandHandlers,
  type HandledCommandParseResult,
  type StopCommandCallback,
} from "./handlers.js";
import { parseCommand } from "./parseCommand.js";
import type { CommandParseResult } from "./types.js";
import type { SessionManager } from "../session/SessionManager.js";

const GENERIC_COMMAND_ERROR_MESSAGE = "命令处理失败，请稍后重试或查看服务日志。";

export interface CommandRouterOptions {
  handlers?: Partial<CommandHandlers>;
  sessionManager?: SessionManager;
  fileService?: FileService;
  stopCurrentTask?: StopCommandCallback;
  logger?: Logger;
  genericErrorMessage?: string;
}

/** Routes incoming slash commands and keeps non-command messages available for Agent handling. */
export class CommandRouter {
  private readonly handlers: CommandHandlers;
  private readonly logger: Logger;
  private readonly genericErrorMessage: string;

  public constructor(options: CommandRouterOptions = {}) {
    this.handlers = mergeHandlers(options.handlers, createBaseHandlers(options));
    this.logger = options.logger ?? createLogger("commands");
    this.genericErrorMessage = options.genericErrorMessage ?? GENERIC_COMMAND_ERROR_MESSAGE;
  }

  /** Returns true when a slash command was handled, or false for normal Agent messages. */
  public async handle(message: IncomingMessage, replySink: ReplySink): Promise<boolean> {
    const command = parseCommand(message.text);

    if (command.kind === "none") {
      return false;
    }

    try {
      await this.dispatch(command, message, replySink);
    } catch (error: unknown) {
      await this.handleError(error, command, message, replySink);
    }

    return true;
  }

  private async dispatch(
    command: HandledCommandParseResult,
    message: IncomingMessage,
    replySink: ReplySink,
  ): Promise<void> {
    switch (command.kind) {
      case "invalid":
        await this.handlers.invalid({ command, message, replySink });
        return;
      case "unknown":
        await this.handlers.unknown({ command, message, replySink });
        return;
      case "command":
        await this.handlers[command.name]({ command, message, replySink });
        return;
    }
  }

  private async handleError(
    error: unknown,
    command: HandledCommandParseResult,
    message: IncomingMessage,
    replySink: ReplySink,
  ): Promise<void> {
    if (error instanceof UserFacingError) {
      await replySink.sendText(error.safeMessage ?? error.message);
      return;
    }

    this.logger.error("Slash command handler failed.", {
      error,
      command: describeCommand(command),
      messageId: message.id,
      senderId: message.senderId,
    });
    await replySink.sendText(this.genericErrorMessage);
  }
}

function mergeHandlers(
  overrides: Partial<CommandHandlers> | undefined,
  defaults: CommandHandlers,
): CommandHandlers {
  if (overrides === undefined) {
    return defaults;
  }

  return {
    cc: overrides.cc ?? defaults.cc,
    close: overrides.close ?? defaults.close,
    state: overrides.state ?? defaults.state,
    stop: overrides.stop ?? defaults.stop,
    new: overrides.new ?? defaults.new,
    oc: overrides.oc ?? defaults.oc,
    dl: overrides.dl ?? defaults.dl,
    invalid: overrides.invalid ?? defaults.invalid,
    unknown: overrides.unknown ?? defaults.unknown,
  };
}

function createBaseHandlers(options: CommandRouterOptions): CommandHandlers {
  if (options.sessionManager !== undefined) {
    return createSessionCommandHandlers({
      sessionManager: options.sessionManager,
      fileService: options.fileService,
      stopCurrentTask: options.stopCurrentTask,
    });
  }

  return createDefaultCommandHandlers();
}

function describeCommand(command: CommandParseResult): Record<string, string> {
  switch (command.kind) {
    case "none":
      return { kind: command.kind };
    case "command":
      return { kind: command.kind, name: command.name, rawName: command.rawName };
    case "unknown":
    case "invalid":
      return { kind: command.kind, rawName: command.rawName };
  }
}
