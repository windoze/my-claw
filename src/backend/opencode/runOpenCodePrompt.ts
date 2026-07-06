/** Local CLI for exercising OpenCodeAdapter without DingTalk. */

import path from "node:path";

import type { AgentEvent } from "../types.js";
import type { AgentEnvironment } from "../../session/types.js";
import { OpenCodeAdapter } from "./OpenCodeAdapter.js";

const DEFAULT_PROMPT = "请用一句话回复：OpenCode Adapter 正常工作。";
const LOCAL_MESSAGE_ID = "local-opencode-prompt";

interface ParsedCliOptions {
  cwd: string;
  agent?: string;
  model?: string;
  resumeSessionId?: string;
  serverTimeoutMs?: number;
  promptParts: string[];
  showHelp: boolean;
}

/** CLI entrypoint that opens an OpenCode backend session and prints emitted events. */
async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(args);

  if (options.showHelp) {
    writeUsage();
    return;
  }

  const adapter = new OpenCodeAdapter({
    serverOptions:
      options.serverTimeoutMs === undefined ? undefined : { timeout: options.serverTimeoutMs },
  });
  const session = await adapter.open(buildEnvironment(options));
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
    await adapter.close(session);
    await adapter.dispose();
  }
}

/** Builds the OpenCode execution environment used for the local prompt. */
function buildEnvironment(options: ParsedCliOptions): AgentEnvironment {
  return {
    backend: "opencode",
    kind: "default",
    cwd: path.resolve(options.cwd),
    ...(options.agent !== undefined ? { agent: options.agent } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
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
    cwd: process.cwd(),
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
      case "--server-timeout-ms":
        options.serverTimeoutMs = parsePositiveInteger(readCliValue(args, index, arg), arg);
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

/** Writes a concise usage guide for local OpenCode adapter checks. */
function writeUsage(): void {
  process.stdout.write(
    [
      "Usage: npm run opencode:prompt -- [options] [prompt ...]",
      "",
      "Options:",
      "  --cwd <dir>                 Working directory for OpenCode. Defaults to current directory.",
      "  --agent <name>              Optional OpenCode agent name.",
      "  --model <provider/model>    Optional OpenCode model selection.",
      "  --resume <session-id>       Optional existing OpenCode session ID to reuse.",
      "  --server-timeout-ms <ms>    Timeout while waiting for `opencode serve`.",
      "  -h, --help                  Show this help text.",
      "",
    ].join("\n"),
  );
}

runCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
