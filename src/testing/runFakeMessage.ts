/** Local fake-message runner that exercises command routing and normal backend routing. */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createIncomingMessageHandler, type IncomingMessageHandler } from "../app.js";
import { BackendRegistry } from "../backend/BackendRegistry.js";
import type { AgentEvent } from "../backend/types.js";
import { CommandRouter } from "../commands/CommandRouter.js";
import {
  DEFAULT_ALLOWED_ATTACHMENT_MIME_TYPES,
  DEFAULT_ATTACHMENT_TEMP_DIR,
  DEFAULT_MAX_ATTACHMENT_FILE_BYTES,
  DEFAULT_MAX_DOWNLOAD_FILE_BYTES,
  type AppConfig,
} from "../config/types.js";
import type {
  ConversationType,
  IncomingMessage,
  IncomingMessageAttachment,
} from "../messages/types.js";
import { OutputRenderer } from "../output/OutputRenderer.js";
import type { ReplySink } from "../output/types.js";
import { FileService } from "../files/FileService.js";
import { PathPolicy } from "../security/PathPolicy.js";
import { SecurityGate } from "../security/SecurityGate.js";
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
  allowedUserIds?: readonly string[];
  rejectGroupMessages?: boolean;
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
  outputRenderer: OutputRenderer;
  fileService: FileService;
  securityGate: SecurityGate;
  handleIncomingMessage: IncomingMessageHandler;
  backend: FakeBackendAdapter;
  dispose(): Promise<void>;
}

/** Options for one fake incoming message. */
export interface RunFakeMessageOptions {
  runtime?: FakeMessageRuntime;
  messageId?: string;
  senderId?: string;
  conversationType?: ConversationType;
  attachments?: readonly IncomingMessageAttachment[];
}

/** Result of routing one fake message. */
export interface RunFakeMessageResult {
  message: IncomingMessage;
  authorized: boolean;
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
  const config = createFakeConfig(realCwd, pathPolicy.allowedRootDirs, {
    allowedUserIds: options.allowedUserIds,
    rejectGroupMessages: options.rejectGroupMessages,
  });
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
  const backendRegistry = new BackendRegistry([
    ["claude-code", backend],
    ["opencode", backend],
  ]);
  const outputRenderer = new OutputRenderer({ config: config.output });
  const fileService = new FileService({
    pathPolicy,
    maxFileBytes: config.security.maxDownloadFileBytes,
  });
  const commandRouter = new CommandRouter({ sessionManager, fileService });
  const securityGate = new SecurityGate({ config: config.dingtalk });
  const handleIncomingMessage = createIncomingMessageHandler({
    commandRouter,
    sessionManager,
    backendRegistry,
    outputRenderer,
    securityGate,
  });

  return {
    config,
    commandRouter,
    sessionManager,
    stateStore,
    replySink,
    backendRegistry,
    outputRenderer,
    fileService,
    securityGate,
    handleIncomingMessage,
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
    const handleResult = await runtime.handleIncomingMessage(message, runtime.replySink);
    const replyCalls = runtime.replySink.calls.slice(firstReplyIndex);

    return {
      message,
      authorized: handleResult.authorized,
      handledByCommand: handleResult.handledByCommand,
      replyCalls,
      backendEvents: handleResult.backendEvents,
    };
  } finally {
    if (createdRuntime) {
      await runtime.dispose();
    }
  }
}

/** Sends backend events to a reply sink using the shared output renderer. */
export async function renderFakeBackendEvents(
  events: readonly AgentEvent[],
  replySink: ReplySink,
): Promise<void> {
  const renderer = new OutputRenderer({
    config: {
      mode: "markdown",
      maxMessageChars: DEFAULT_OUTPUT_MAX_MESSAGE_CHARS,
    },
  });
  await renderer.render(events, replySink);
}

/** Builds the minimal validated-looking config needed by SessionManager. */
function createFakeConfig(
  cwd: string,
  allowedRootDirs: readonly string[],
  options: {
    allowedUserIds?: readonly string[];
    rejectGroupMessages?: boolean;
  },
): AppConfig {
  return {
    dingtalk: {
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      allowedUserIds:
        options.allowedUserIds !== undefined ? [...options.allowedUserIds] : [DEFAULT_SENDER_ID],
      rejectGroupMessages: options.rejectGroupMessages ?? true,
    },
    defaultEnvironment: {
      backend: "claude-code",
      cwd,
    },
    security: {
      allowedRootDirs: [...allowedRootDirs],
      downloadAllowedDirs: [...allowedRootDirs],
      maxDownloadFileBytes: DEFAULT_MAX_DOWNLOAD_FILE_BYTES,
      attachmentTempDir: path.join(cwd, DEFAULT_ATTACHMENT_TEMP_DIR),
      maxAttachmentFileBytes: DEFAULT_MAX_ATTACHMENT_FILE_BYTES,
      allowedAttachmentMimeTypes: [...DEFAULT_ALLOWED_ATTACHMENT_MIME_TYPES],
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
    ...(options.attachments !== undefined ? { attachments: [...options.attachments] } : {}),
  };
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
    `handled: ${formatHandledBy(result)}`,
  ];

  if (result.replyCalls.length === 0) {
    lines.push("[reply] <none>");
  } else {
    lines.push(...result.replyCalls.map(formatReplyCall));
  }

  process.stdout.write(`${lines.join("\n")}\n\n`);
}

/** Names the code path taken by the fake runner for quick manual inspection. */
function formatHandledBy(result: RunFakeMessageResult): string {
  if (!result.authorized) {
    return "security-gate";
  }

  return result.handledByCommand ? "command" : "fake-backend";
}

/** Formats recorded fake reply calls for CLI output. */
function formatReplyCall(call: FakeReplyCall): string {
  if (call.type === "text") {
    return `[text] ${call.text}`;
  }

  if (call.type === "file") {
    return `[file] ${call.file.name} (${call.file.sizeBytes} bytes) ${call.file.path}`;
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
