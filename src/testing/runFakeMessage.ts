/** Local fake-message runner that exercises command routing and normal backend routing. */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BackendRegistry } from "../backend/BackendRegistry.js";
import type { AgentEvent, BackendSession } from "../backend/types.js";
import { CommandRouter } from "../commands/CommandRouter.js";
import type { AppConfig } from "../config/types.js";
import type { ConversationType, IncomingMessage } from "../messages/types.js";
import type { ReplySink } from "../output/types.js";
import { PathPolicy } from "../security/PathPolicy.js";
import { SessionManager } from "../session/SessionManager.js";
import { StateStore } from "../state/StateStore.js";
import { FakeBackendAdapter } from "./FakeBackendAdapter.js";
import { FakeReplySink, type FakeReplyCall } from "./FakeReplySink.js";

const DEFAULT_FAKE_MESSAGES = ["/state", "/cc .", "hello fake backend", "/close"];
const DEFAULT_SENDER_ID = "fake-user";
const DEFAULT_OUTPUT_MAX_MESSAGE_CHARS = 18_000;
const FAKE_STATE_FILE_NAME = ".agent-dingtalk-state.fake.json";

/** Options used to create a reusable fake-message runtime. */
export interface CreateFakeMessageRuntimeOptions {
  cwd?: string;
  allowedRootDirs?: readonly string[];
  statePath?: string;
  replySink?: FakeReplySink;
  backend?: FakeBackendAdapter;
  now?: () => Date;
}

/** Reusable local runtime for sending multiple fake messages through one state store. */
export interface FakeMessageRuntime {
  config: AppConfig;
  commandRouter: CommandRouter;
  sessionManager: SessionManager;
  stateStore: StateStore;
  replySink: FakeReplySink;
  backendRegistry: BackendRegistry;
  backend: FakeBackendAdapter;
  dispose(): Promise<void>;
}

/** Options for one fake incoming message. */
export interface RunFakeMessageOptions {
  runtime?: FakeMessageRuntime;
  messageId?: string;
  senderId?: string;
  conversationType?: ConversationType;
}

/** Result of routing one fake message. */
export interface RunFakeMessageResult {
  message: IncomingMessage;
  handledByCommand: boolean;
  replyCalls: readonly FakeReplyCall[];
  backendEvents: readonly AgentEvent[];
}

interface TempStateLocation {
  dir: string;
  statePath: string;
}

interface ParsedCliOptions {
  cwd: string;
  allowedRootDirs: string[];
  statePath?: string;
  senderId: string;
  conversationType: ConversationType;
  messages: string[];
  showHelp: boolean;
}

/** Creates the fake runtime with real session state and an allowlisted local cwd. */
export async function createFakeMessageRuntime(
  options: CreateFakeMessageRuntimeOptions = {},
): Promise<FakeMessageRuntime> {
  const configuredCwd = path.resolve(options.cwd ?? process.cwd());
  const configuredAllowedRootDirs =
    options.allowedRootDirs !== undefined && options.allowedRootDirs.length > 0
      ? [...options.allowedRootDirs]
      : [configuredCwd];
  const pathPolicy = await PathPolicy.create(configuredAllowedRootDirs, {
    baseDir: configuredCwd,
  });
  const realCwd = await pathPolicy.assertAllowedDir(configuredCwd, { baseDir: configuredCwd });
  const config = createFakeConfig(realCwd, pathPolicy.allowedRootDirs);
  const tempState = options.statePath === undefined ? await createTempStateLocation() : null;
  const stateStore = new StateStore({
    statePath: options.statePath ?? tempState?.statePath,
    cwd: realCwd,
  });
  await stateStore.load();

  const sessionManager = new SessionManager({
    config,
    stateStore,
    pathPolicy,
    pathBaseDir: realCwd,
    now: options.now,
  });
  const replySink = options.replySink ?? new FakeReplySink();
  const backend = options.backend ?? new FakeBackendAdapter();
  const backendRegistry = new BackendRegistry([["claude-code", backend]]);

  return {
    config,
    commandRouter: new CommandRouter({ sessionManager }),
    sessionManager,
    stateStore,
    replySink,
    backendRegistry,
    backend,
    dispose: async () => {
      if (tempState !== null) {
        await rm(tempState.dir, { recursive: true, force: true });
      }
    },
  };
}

/** Routes a single fake message through CommandRouter or the fake backend path. */
export async function runFakeMessage(
  text: string,
  options: RunFakeMessageOptions = {},
): Promise<RunFakeMessageResult> {
  const createdRuntime = options.runtime === undefined;
  const runtime = options.runtime ?? (await createFakeMessageRuntime());

  try {
    const firstReplyIndex = runtime.replySink.calls.length;
    const message = createIncomingMessage(text, options);
    const handledByCommand = await runtime.commandRouter.handle(message, runtime.replySink);
    const backendEvents = handledByCommand
      ? []
      : await routeToFakeBackend(message, runtime);
    const replyCalls = runtime.replySink.calls.slice(firstReplyIndex);

    return {
      message,
      handledByCommand,
      replyCalls,
      backendEvents,
    };
  } finally {
    if (createdRuntime) {
      await runtime.dispose();
    }
  }
}

/** Sends backend events to a reply sink using the first-stage text-only fake renderer. */
export async function renderFakeBackendEvents(
  events: readonly AgentEvent[],
  replySink: ReplySink,
): Promise<void> {
  for (const event of events) {
    switch (event.type) {
      case "text":
        await replySink.sendText(event.text);
        break;
      case "done":
        if (event.result !== undefined) {
          await replySink.sendText(event.result);
        }
        break;
      case "error":
        await replySink.sendText(`Fake backend error: ${event.message}`);
        break;
      case "stopped":
        await replySink.sendText(event.message ?? "Fake backend stopped.");
        break;
      case "tool_start":
      case "tool_finish":
        break;
    }
  }
}

/** Builds the minimal validated-looking config needed by SessionManager. */
function createFakeConfig(cwd: string, allowedRootDirs: readonly string[]): AppConfig {
  return {
    dingtalk: {
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      allowedUserIds: [DEFAULT_SENDER_ID],
      rejectGroupMessages: true,
    },
    defaultEnvironment: {
      backend: "claude-code",
      cwd,
    },
    security: {
      allowedRootDirs: [...allowedRootDirs],
    },
    claudeCode: {
      maxTurns: 1,
    },
    output: {
      mode: "markdown",
      maxMessageChars: DEFAULT_OUTPUT_MAX_MESSAGE_CHARS,
    },
  };
}

/** Creates a normalized fake incoming message for router tests. */
function createIncomingMessage(
  text: string,
  options: RunFakeMessageOptions,
): IncomingMessage {
  return {
    id: options.messageId ?? randomUUID(),
    text,
    senderId: options.senderId ?? DEFAULT_SENDER_ID,
    conversationType: options.conversationType ?? "private",
  };
}

/** Runs a normal non-command message through the fake backend and updates session state. */
async function routeToFakeBackend(
  message: IncomingMessage,
  runtime: FakeMessageRuntime,
): Promise<AgentEvent[]> {
  if (!(await runtime.sessionManager.canAcceptNormalMessage())) {
    await runtime.replySink.sendText("当前已有任务正在运行，请等待完成后再发送新消息。");
    return [];
  }

  const environment = await runtime.sessionManager.getCurrentEnvironment();
  const backend = runtime.backendRegistry.get(environment);
  await runtime.sessionManager.startTask({ messageId: message.id });
  let session: BackendSession | null = null;

  try {
    session = await backend.open(environment);
    const events = await collectAgentEvents(
      backend.send(session, { text: message.text, messageId: message.id }),
    );
    await renderFakeBackendEvents(events, runtime.replySink);
    await saveDoneSessionId(events, environment, runtime.sessionManager);

    return events;
  } finally {
    try {
      if (session !== null) {
        await backend.close(session);
      }
    } finally {
      await runtime.sessionManager.markIdle();
    }
  }
}

/** Collects an Agent event stream for the first-stage fake renderer. */
async function collectAgentEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collectedEvents: AgentEvent[] = [];

  for await (const event of events) {
    collectedEvents.push(event);
  }

  return collectedEvents;
}

/** Persists the fake session id emitted by a done event. */
async function saveDoneSessionId(
  events: readonly AgentEvent[],
  environment: Awaited<ReturnType<SessionManager["getCurrentEnvironment"]>>,
  sessionManager: SessionManager,
): Promise<void> {
  const doneWithSession = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> & { sessionId: string } =>
      event.type === "done" && event.sessionId !== undefined,
  );

  if (doneWithSession !== undefined) {
    await sessionManager.saveSessionId(environment, doneWithSession.sessionId);
  }
}

/** Allocates an isolated temp state file for one fake CLI/function run. */
async function createTempStateLocation(): Promise<TempStateLocation> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dingtalk-fake-"));

  return {
    dir,
    statePath: path.join(dir, FAKE_STATE_FILE_NAME),
  };
}

/** CLI entrypoint for manually exercising fake message routing. */
async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(args);

  if (options.showHelp) {
    writeUsage();
    return;
  }

  const runtime = await createFakeMessageRuntime({
    cwd: options.cwd,
    allowedRootDirs: options.allowedRootDirs,
    statePath: options.statePath,
  });

  try {
    for (const [index, text] of options.messages.entries()) {
      const result = await runFakeMessage(text, {
        runtime,
        messageId: `fake-message-${index + 1}`,
        senderId: options.senderId,
        conversationType: options.conversationType,
      });
      writeResult(result);
    }
  } finally {
    await runtime.dispose();
  }
}

/** Parses the small CLI surface without introducing a test-only dependency. */
function parseCliArgs(args: readonly string[]): ParsedCliOptions {
  const options: ParsedCliOptions = {
    cwd: process.cwd(),
    allowedRootDirs: [],
    senderId: DEFAULT_SENDER_ID,
    conversationType: "private",
    messages: [],
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
      case "--allowed-root":
        options.allowedRootDirs.push(readCliValue(args, index, arg));
        index += 2;
        break;
      case "--state-path":
        options.statePath = readCliValue(args, index, arg);
        index += 2;
        break;
      case "--sender":
        options.senderId = readCliValue(args, index, arg);
        index += 2;
        break;
      case "--conversation-type":
        options.conversationType = parseConversationType(readCliValue(args, index, arg));
        index += 2;
        break;
      case "--message":
        options.messages.push(readCliValue(args, index, arg));
        index += 2;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        options.messages.push(arg);
        index += 1;
        break;
    }
  }

  if (options.allowedRootDirs.length === 0) {
    options.allowedRootDirs.push(options.cwd);
  }

  if (options.messages.length === 0 && !options.showHelp) {
    options.messages.push(...DEFAULT_FAKE_MESSAGES);
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

/** Converts a CLI string into the normalized conversation type. */
function parseConversationType(value: string): ConversationType {
  if (value === "private" || value === "group" || value === "unknown") {
    return value;
  }

  throw new Error(`Invalid --conversation-type: ${value}`);
}

/** Writes a concise usage guide for the manual fake-message script. */
function writeUsage(): void {
  process.stdout.write(
    [
      "Usage: npm run fake:message -- [options] [message ...]",
      "",
      "Options:",
      "  --cwd <dir>                 Default fake environment cwd. Defaults to process cwd.",
      "  --allowed-root <dir>        Allowed project root. Repeatable. Defaults to cwd.",
      "  --state-path <file>         Optional persistent fake state file.",
      "  --sender <id>               Fake DingTalk sender id.",
      "  --conversation-type <type>  private, group, or unknown.",
      "  --message <text>            Add one message. Positional messages are also accepted.",
      "",
      "When no message is supplied, the script runs /state, /cc ., a normal message, and /close.",
      "",
    ].join("\n"),
  );
}

/** Prints one routed fake message result in a stable, human-readable form. */
function writeResult(result: RunFakeMessageResult): void {
  const lines = [
    `> ${result.message.text}`,
    `handled: ${result.handledByCommand ? "command" : "fake-backend"}`,
  ];

  if (result.replyCalls.length === 0) {
    lines.push("[reply] <none>");
  } else {
    lines.push(...result.replyCalls.map(formatReplyCall));
  }

  process.stdout.write(`${lines.join("\n")}\n\n`);
}

/** Formats recorded fake reply calls for CLI output. */
function formatReplyCall(call: FakeReplyCall): string {
  if (call.type === "text") {
    return `[text] ${call.text}`;
  }

  return `[markdown]\n${call.markdown}`;
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
    process.stderr.write(`Fake message runner failed: ${message}\n`);
    process.exitCode = 1;
  });
}
