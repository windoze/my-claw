/** Slash command parsing helpers for DingTalk text messages. */

import {
  KNOWN_SLASH_COMMANDS,
  type CommandParseError,
  type CommandParseResult,
  type SlashCommandName,
} from "./types.js";

const COMMAND_PREFIX = "/";
const QUOTE_CHARS = new Set(['"', "'"]);
const KNOWN_COMMAND_SET = new Set<string>(KNOWN_SLASH_COMMANDS);

/** Parses text into a known command, unknown slash command, invalid command, or non-command. */
export function parseCommand(text: string): CommandParseResult {
  if (text.length === 0 || !text.startsWith(COMMAND_PREFIX)) {
    return { kind: "none" };
  }

  const commandTokenEnd = findCommandTokenEnd(text);
  const rawName = text.slice(1, commandTokenEnd).toLowerCase();
  const argsText = readArgsText(text, commandTokenEnd);
  const argsResult = parseCommandArgs(argsText);

  if (!argsResult.ok) {
    return {
      kind: "invalid",
      rawName,
      argsText,
      error: argsResult.error,
    };
  }

  if (isKnownSlashCommand(rawName)) {
    return {
      kind: "command",
      name: rawName,
      rawName,
      argsText,
      args: argsResult.args,
    };
  }

  return {
    kind: "unknown",
    name: "unknown",
    rawName,
    argsText,
    args: argsResult.args,
  };
}

/** Splits an argument string while preserving quoted paths that contain whitespace. */
export function parseCommandArgs(argsText: string): CommandArgsParseResult {
  const args: string[] = [];
  let currentArg = "";
  let quoteChar: string | null = null;
  let hasCurrentArg = false;

  for (let index = 0; index < argsText.length; index += 1) {
    const char = argsText[index] ?? "";

    if (quoteChar !== null) {
      if (char === quoteChar) {
        quoteChar = null;
        continue;
      }

      currentArg += char;
      hasCurrentArg = true;
      continue;
    }

    if (isWhitespace(char)) {
      if (hasCurrentArg) {
        args.push(currentArg);
        currentArg = "";
        hasCurrentArg = false;
      }
      continue;
    }

    if (QUOTE_CHARS.has(char)) {
      quoteChar = char;
      hasCurrentArg = true;
      continue;
    }

    currentArg += char;
    hasCurrentArg = true;
  }

  if (quoteChar !== null) {
    return {
      ok: false,
      error: {
        code: "unterminated_quote",
        message: "命令参数中的引号未闭合；如果路径包含空格，请用成对的引号包裹。",
      },
    };
  }

  if (hasCurrentArg) {
    args.push(currentArg);
  }

  return { ok: true, args };
}

export type CommandArgsParseResult =
  | {
      ok: true;
      args: string[];
    }
  | {
      ok: false;
      error: CommandParseError;
    };

function findCommandTokenEnd(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (isWhitespace(text[index] ?? "")) {
      return index;
    }
  }

  return text.length;
}

function readArgsText(text: string, commandTokenEnd: number): string {
  if (commandTokenEnd >= text.length) {
    return "";
  }

  return text.slice(commandTokenEnd).trimStart();
}

function isKnownSlashCommand(rawName: string): rawName is SlashCommandName {
  return KNOWN_COMMAND_SET.has(rawName);
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}
