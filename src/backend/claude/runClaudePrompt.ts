/** Local CLI for exercising ClaudeCodeAdapter without DingTalk. */

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentEvent } from "../types.js";
import { loadConfig } from "../../config/loadConfig.js";
import {
  CLAUDE_CODE_PERMISSION_MODES,
  type AppConfig,
  type ClaudeCodeConfig,
  type ClaudeCodePermissionMode,
} from "../../config/types.js";
import type { AgentEnvironment } from "../../session/types.js";
import { ClaudeCodeAdapter } from "./ClaudeCodeAdapter.js";

const DEFAULT_PROMPT = "请用一句话回复：Claude Code Adapter 正常工作。";
const DEFAULT_MAX_TURNS = 1;
const LOCAL_MESSAGE_ID = "local-claude-code-prompt";

interface ParsedCliOptions {
  configPath?: string;
  cwd?: string;
  agent?: string;
  model?: string;
  resumeSessionId?: string;
  permissionMode?: ClaudeCodePermissionMode;
  allowedTools: string[];
  maxTurns?: number;
  promptParts: string[];
  showHelp: boolean;
}

/** CLI entrypoint that opens a Claude backend session and prints emitted events. */
async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(args);

  if (options.showHelp) {
    writeUsage();
    return;
  }

  const appConfig = await loadOptionalConfig(options.configPath);
  const adapterConfig = buildAdapterConfig(options, appConfig);
  const environment = buildEnvironment(options, appConfig);
  const adapter = new ClaudeCodeAdapter({ config: adapterConfig });
  const session = adapter.open(environment);
  const prompt = buildPrompt(options.promptParts);

  try {
    let failed = false;

    for await (const event of adapter.send(session, { text: prompt, messageId: LOCAL_MESSAGE_ID })) {
      failed = writeEvent(event) || failed;
    }

    if (failed) {
      process.exitCode = 1;
    }
  } finally {
    adapter.close(session);
  }
}

/** Loads the full app config only when a config path was explicitly requested. */
async function loadOptionalConfig(configPath: string | undefined): Promise<AppConfig | null> {
  if (configPath === undefined) {
    return null;
  }

  return loadConfig({ configPath });
}

/** Builds the Claude adapter config from app config plus CLI overrides. */
function buildAdapterConfig(
  options: ParsedCliOptions,
  appConfig: AppConfig | null,
): ClaudeCodeConfig {
  const baseConfig = appConfig?.claudeCode ?? { maxTurns: DEFAULT_MAX_TURNS };

  return {
    ...baseConfig,
    ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
    ...(options.allowedTools.length > 0 ? { allowedTools: options.allowedTools } : {}),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
  };
}

/** Builds the Claude execution environment used for the local prompt. */
function buildEnvironment(
  options: ParsedCliOptions,
  appConfig: AppConfig | null,
): AgentEnvironment {
  const configEnvironment = appConfig?.defaultEnvironment;
  const cwd = path.resolve(options.cwd ?? configEnvironment?.cwd ?? process.cwd());
  const agent = options.agent ?? configEnvironment?.agent;
  const model = options.model ?? configEnvironment?.model;

  return {
    backend: "claude-code",
    kind: "default",
    cwd,
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(options.resumeSessionId !== undefined ? { sessionId: options.resumeSessionId } : {}),
  };
}

/** Joins positional prompt parts while preserving a useful default. */
function buildPrompt(promptParts: readonly string[]): string {
  const prompt = promptParts.join(" ").trim();
  return prompt.length > 0 ? prompt : DEFAULT_PROMPT;
}

/** Writes one Agent event and returns whether it represents a failure. */
function writeEvent(event: AgentEvent): boolean {
  switch (event.type) {
    case "text":
      process.stdout.write(event.text);
      return false;
    case "done":
      if (event.result !== undefined && event.result.length > 0) {
        process.stdout.write(`${event.result}\n`);
      }
      process.stdout.write(`[done] sessionId=${event.sessionId ?? "<none>"}\n`);
      return false;
    case "error":
      process.stderr.write(`[error] ${event.message}\n`);
      return true;
    case "stopped":
      process.stderr.write(`[stopped] ${event.message ?? "stopped"}\n`);
      return true;
    case "tool_start":
      process.stderr.write(`[tool_start] ${event.name}\n`);
      return false;
    case "tool_finish":
      process.stderr.write(`[tool_finish] ${event.name}\n`);
      return false;
  }
}

/** Parses the small CLI surface without adding another dependency. */
function parseCliArgs(args: readonly string[]): ParsedCliOptions {
  const options: ParsedCliOptions = {
    allowedTools: [],
    promptParts: [],
    showHelp: false,
  };

  for (let index = 0; index < args.length; ) {
    const arg = args[index];

    if (arg === undefined) {
      break;
    }

    switch (arg) {
      case "--help":
      case "-h":
        options.showHelp = true;
        index += 1;
        break;
      case "--config":
        options.configPath = readCliValue(args, index, arg);
        index += 2;
        break;
      case "--cwd":
        options.cwd = readCliValue(args, index, arg);
        index += 2;
        break;
      case "--agent":
        options.agent = readCliValue(args, index, arg);
        index += 2;
        break;
      case "--model":
        options.model = readCliValue(args, index, arg);
        index += 2;
        break;
      case "--resume":
        options.resumeSessionId = readCliValue(args, index, arg);
        index += 2;
        break;
      case "--permission-mode":
        options.permissionMode = parsePermissionMode(readCliValue(args, index, arg));
        index += 2;
        break;
      case "--tool":
        options.allowedTools.push(readCliValue(args, index, arg));
        index += 2;
        break;
      case "--max-turns":
        options.maxTurns = parsePositiveInteger(readCliValue(args, index, arg), arg);
        index += 2;
        break;
      case "--":
        options.promptParts.push(...args.slice(index + 1));
        index = args.length;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }

        options.promptParts.push(arg);
        index += 1;
        break;
    }
  }

  return options;
}

/** Reads the value following a CLI option and reports missing values clearly. */
function readCliValue(args: readonly string[], index: number, optionName: string): string {
  const value = args[index + 1];

  if (value === undefined) {
    throw new Error(`Missing value for ${optionName}`);
  }

  return value;
}

/** Parses and validates a positive integer CLI value. */
function parsePositiveInteger(value: string, optionName: string): number {
  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return parsedValue;
}

/** Parses a CLI permission mode and keeps it aligned with config validation. */
function parsePermissionMode(value: string): ClaudeCodePermissionMode {
  if (isClaudeCodePermissionMode(value)) {
    return value;
  }

  throw new Error(
    `Invalid --permission-mode: ${value}. Expected one of: ${CLAUDE_CODE_PERMISSION_MODES.join(", ")}`,
  );
}

/** Checks a string against the supported Claude Code permission modes. */
function isClaudeCodePermissionMode(value: string): value is ClaudeCodePermissionMode {
  return CLAUDE_CODE_PERMISSION_MODES.some((mode) => mode === value);
}

/** Writes a concise usage guide for local Claude Code adapter checks. */
function writeUsage(): void {
  process.stdout.write(
    [
      "Usage: npm run claude:prompt -- [options] [prompt ...]",
      "",
      "Options:",
      "  --config <file>             Optional app config to read claudeCode defaults from.",
      "  --cwd <dir>                 Working directory for Claude Code. Defaults to config cwd or process cwd.",
      "  --agent <name>              Optional Claude Code agent name.",
      "  --model <model>             Optional Claude model name.",
      "  --resume <session-id>       Resume a previous Claude Code session id.",
      "  --permission-mode <mode>    default, acceptEdits, bypassPermissions, plan, dontAsk, or auto.",
      "  --tool <name>               Auto-allowed Claude Code tool. Repeatable.",
      "  --max-turns <n>             Maximum Claude Code turns. Defaults to 1 without config.",
      "",
      "When no prompt is supplied, the script sends a one-sentence adapter smoke prompt.",
      "",
    ].join("\n"),
  );
}

/** Detects whether this module is being run directly rather than imported. */
function isCliEntrypoint(): boolean {
  const entrypoint = process.argv[1];

  if (entrypoint === undefined) {
    return false;
  }

  return fileURLToPath(import.meta.url) === path.resolve(entrypoint);
}

if (isCliEntrypoint()) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Claude prompt runner failed: ${message}\n`);
    process.exitCode = 1;
  });
}
