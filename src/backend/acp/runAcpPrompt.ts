/** Local CLI for exercising AcpAdapter without DingTalk. */

import path from "node:path";

import type { AcpConfig } from "../../config/types.js";
import type { AgentEnvironment } from "../../session/types.js";
import type { AgentEvent } from "../types.js";
import { AcpAdapter } from "./AcpAdapter.js";

const DEFAULT_PROMPT = "请用一句话回复：ACP Adapter 正常工作。";
const DEFAULT_COMMAND = "claude-agent-acp";
const DEFAULT_PROVIDER = "claude";
const LOCAL_MESSAGE_ID = "local-acp-prompt";

interface ParsedCliOptions {
  cwd: string;
  provider: string;
  command: string;
  commandArgs: string[];
  agent?: string;
  model?: string;
  resumeSessionId?: string;
  promptParts: string[];
  showHelp: boolean;
}

/** CLI entrypoint that opens an ACP backend session and prints emitted events. */
async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(args);

  if (options.showHelp) {
    writeUsage();
    return;
  }

  const config: AcpConfig = {
    defaultProvider: options.provider,
    providers: {
      [options.provider]: { command: options.command, args: options.commandArgs },
    },
  };
  const adapter = new AcpAdapter({ config });
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
    adapter.close(session);
    await adapter.dispose();
  }
}

/** Builds the ACP execution environment used for the local prompt. */
function buildEnvironment(options: ParsedCliOptions): AgentEnvironment {
  return {
    backend: "acp",
    kind: "default",
    cwd: path.resolve(options.cwd),
    provider: options.provider,
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
      process.stderr.write(`[tool_finish] ${event.name} status=${event.status ?? "<none>"}\n`);
      return false;
    case "thought":
      process.stderr.write(`[thought] ${event.text}\n`);
      return false;
    case "plan":
      process.stderr.write(`[plan] ${event.entries.length} entries\n`);
      return false;
    case "notice":
      process.stderr.write(`[notice] ${event.text}\n`);
      return false;
  }
}

/** Parses the small CLI surface without adding another dependency. */
function parseCliArgs(args: readonly string[]): ParsedCliOptions {
  const options: ParsedCliOptions = {
    cwd: process.cwd(),
    provider: DEFAULT_PROVIDER,
    command: DEFAULT_COMMAND,
    commandArgs: [],
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
      case "--provider":
        options.provider = readCliValue(args, index, arg);
        index += 2;
        break;
      case "--command":
        options.command = readCliValue(args, index, arg);
        index += 2;
        break;
      case "--command-arg":
        options.commandArgs.push(readCliValue(args, index, arg));
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

/** Writes a concise usage guide for local ACP adapter checks. */
function writeUsage(): void {
  process.stdout.write(
    [
      "Usage: npm run acp:prompt -- [options] [prompt ...]",
      "",
      "Options:",
      "  --cwd <dir>            Working directory for the ACP agent. Defaults to current directory.",
      "  --provider <name>      Provider name recorded on the environment. Defaults to claude.",
      "  --command <bin>        ACP agent command. Defaults to claude-agent-acp.",
      "  --command-arg <arg>    Add one argument passed to the ACP agent command. Repeatable.",
      "  --agent <name>         Optional agent name (currently informational).",
      "  --model <name>         Optional model selection (currently informational).",
      "  --resume <session-id>  Optional existing ACP session ID to load.",
      "  -h, --help             Show this help text.",
      "",
    ].join("\n"),
  );
}

runCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
