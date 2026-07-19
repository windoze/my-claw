/** Shared slash command parser contracts used by command routing and handlers. */

export const KNOWN_SLASH_COMMANDS = [
  "cc",
  "close",
  "state",
  "stop",
  "new",
  "oc",
  "acp",
  "dl",
  "screenshot",
] as const;

export type SlashCommandName = (typeof KNOWN_SLASH_COMMANDS)[number];

export type CommandParseErrorCode = "unterminated_quote";

/** Machine-readable argument parsing failure with a user-safe explanation. */
export interface CommandParseError {
  code: CommandParseErrorCode;
  message: string;
}

/** Result returned when an inbound message is not a slash command. */
export interface NonCommandParseResult {
  kind: "none";
}

/** Result returned for a supported first-stage slash command. */
export interface KnownCommandParseResult {
  kind: "command";
  name: SlashCommandName;
  rawName: string;
  argsText: string;
  args: string[];
}

/** Result returned for a slash command that is syntactically valid but unsupported. */
export interface UnknownCommandParseResult {
  kind: "unknown";
  name: "unknown";
  rawName: string;
  argsText: string;
  args: string[];
}

/** Result returned when a slash command cannot be parsed safely. */
export interface InvalidCommandParseResult {
  kind: "invalid";
  rawName: string;
  argsText: string;
  error: CommandParseError;
}

export type CommandParseResult =
  | NonCommandParseResult
  | KnownCommandParseResult
  | UnknownCommandParseResult
  | InvalidCommandParseResult;
