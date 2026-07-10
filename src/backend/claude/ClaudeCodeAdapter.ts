/** BackendAdapter implementation backed by the Claude Agent SDK query API. */

import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeCodeConfig } from "../../config/types.js";
import type { AgentEnvironment } from "../../session/types.js";
import { UserFacingError } from "../../utils/errors.js";
import { createLogger, redactLogString, type Logger } from "../../utils/logger.js";
import { formatAgentInputPrompt } from "../formatAgentInput.js";
import type {
  AgentEvent,
  AgentInput,
  AgentPermissionDecision,
  AgentPermissionHandler,
  BackendAdapter,
  BackendSession,
} from "../types.js";
import { selectClaudeCodeSettings } from "./settings.js";
import type { ClaudeCodeBackendSession } from "./types.js";

/** Injectable SDK query function used by production code and focused checks. */
export type ClaudeCodeQueryFunction = typeof query;

/** Options accepted when constructing a Claude Code backend adapter. */
export interface ClaudeCodeAdapterOptions {
  config: ClaudeCodeConfig;
  logger?: Logger;
  queryFn?: ClaudeCodeQueryFunction;
}

/** User-facing error categories raised by the Claude Code adapter. */
export type ClaudeCodeAdapterErrorCode = "CLAUDE_BACKEND_MISMATCH" | "CLAUDE_TASK_NOT_RUNNING";

interface ActiveClaudeQuery {
  abortController: AbortController;
  permissionAbortController: AbortController;
  query?: Query;
  stopRequested: boolean;
}

type QueryAttemptOutcome = "completed" | "resume_failed";

const CLAUDE_CODE_BACKEND = "claude-code";
const NO_RESULT_MESSAGE = "Claude Code 未返回完成结果。";

/**
 * Appended to the Claude Code preset so the Agent uses standard Markdown references
 * for files it wants delivered. The gateway scans the reply for these local paths and
 * sends each as a standalone DingTalk image/file message.
 */
const ATTACHMENT_SYSTEM_PROMPT = [
  "当你需要把图片展示给用户时，请在回复中用 Markdown 图片语法 `![描述](绝对路径)` 引用该本地图片文件；",
  "当你需要把生成或下载的文件发给用户时，请用 Markdown 链接语法 `[描述](绝对路径)` 引用该本地文件。",
  "请使用文件的绝对路径，且路径需位于当前允许访问的目录内。网关会自动把这些被引用的本地文件作为独立的图片/文件消息发送给用户。",
].join("");
const STOPPED_MESSAGE = "当前 Agent 任务已中断。";
const RESUME_FALLBACK_MESSAGE = "无法恢复上次 Claude Code 会话，已创建新会话。\n\n";

/** Runs prompts through Claude Code and maps SDK messages to AgentEvent values. */
export class ClaudeCodeAdapter implements BackendAdapter {
  private readonly config: ClaudeCodeConfig;
  private readonly logger: Logger;
  private readonly queryFn: ClaudeCodeQueryFunction;
  private readonly sessionEnvironments = new WeakMap<BackendSession, AgentEnvironment>();
  private readonly activeQueries = new WeakMap<BackendSession, ActiveClaudeQuery>();

  public constructor(options: ClaudeCodeAdapterOptions) {
    this.config = options.config;
    this.logger = options.logger ?? createLogger("backend:claude-code");
    this.queryFn = options.queryFn ?? query;
  }

  /** Opens a lightweight Claude Code session handle for the selected environment. */
  public open(environment: AgentEnvironment): ClaudeCodeBackendSession {
    assertClaudeEnvironment(environment);

    const session: ClaudeCodeBackendSession = {
      backend: CLAUDE_CODE_BACKEND,
      cwd: environment.cwd,
      ...(environment.sessionId ? { sessionId: environment.sessionId } : {}),
      raw: { environment },
    };

    this.sessionEnvironments.set(session, environment);
    return session;
  }

  /** Sends one prompt to Claude Code and yields backend-neutral Agent events. */
  public async *send(session: BackendSession, input: AgentInput): AsyncIterable<AgentEvent> {
    assertClaudeSession(session);

    const abortController = new AbortController();
    const activeQuery: ActiveClaudeQuery = {
      abortController,
      permissionAbortController: new AbortController(),
      stopRequested: false,
    };
    this.activeQueries.set(session, activeQuery);

    try {
      const resumeSessionId = session.sessionId;

      if (resumeSessionId !== undefined) {
        const resumeOutcome = yield* this.sendQueryAttempt(
          session,
          input,
          activeQuery,
          resumeSessionId,
        );

        if (
          resumeOutcome !== "resume_failed" ||
          abortController.signal.aborted ||
          activeQuery.stopRequested
        ) {
          return;
        }

        this.logger.warn("Claude Code session resume failed; starting a new session.", {
          cwd: session.cwd,
          sessionId: resumeSessionId,
        });
        delete session.sessionId;
        yield { type: "text", text: RESUME_FALLBACK_MESSAGE };
      }

      yield* this.sendQueryAttempt(session, input, activeQuery);
    } finally {
      activeQuery.permissionAbortController.abort();
      this.activeQueries.delete(session);
    }
  }

  /** Runs one SDK query attempt, optionally resuming a stored Claude Code session. */
  private async *sendQueryAttempt(
    session: BackendSession,
    input: AgentInput,
    activeQuery: ActiveClaudeQuery,
    resumeSessionId?: string,
  ): AsyncGenerator<AgentEvent, QueryAttemptOutcome, void> {
    let streamedText = false;
    let terminalEventEmitted = false;
    let sdkQuery: Query | null = null;
    const startedToolNames = new Map<string, string>();

    try {
      sdkQuery = this.queryFn({
        prompt: formatAgentInputPrompt(input),
        options: this.buildQueryOptions(session, input, activeQuery, resumeSessionId),
      });
      activeQuery.query = sdkQuery;

      for await (const sdkMessage of sdkQuery) {
        if (activeQuery.stopRequested && sdkMessage.type === "result") {
          terminalEventEmitted = true;
          session.sessionId = sdkMessage.session_id;
          yield {
            type: "stopped",
            message: STOPPED_MESSAGE,
            sessionId: sdkMessage.session_id,
          };
          return "completed";
        }

        if (activeQuery.stopRequested) {
          continue;
        }

        const text = extractTextDelta(sdkMessage);
        if (text !== null) {
          streamedText = true;
          yield { type: "text", text };
          continue;
        }

        yield* emitToolEvents(sdkMessage, startedToolNames);

        if (sdkMessage.type === "result") {
          terminalEventEmitted = true;

          if (isResumeFailureResult(sdkMessage, streamedText, resumeSessionId)) {
            return "resume_failed";
          }

          if (sdkMessage.subtype === "success") {
            session.sessionId = sdkMessage.session_id;
          }

          yield mapResultMessage(sdkMessage, streamedText);
        }
      }

      if (!terminalEventEmitted) {
        yield buildMissingResultEvent(
          activeQuery.abortController.signal.aborted || activeQuery.stopRequested,
          session.sessionId,
        );
      }
    } catch (error: unknown) {
      if (activeQuery.abortController.signal.aborted || activeQuery.stopRequested) {
        yield {
          type: "stopped",
          message: STOPPED_MESSAGE,
          ...(session.sessionId ? { sessionId: session.sessionId } : {}),
        };
        return "completed";
      }

      if (
        resumeSessionId !== undefined &&
        !streamedText &&
        isResumeFailureMessage(formatUnknownErrorMessage(error))
      ) {
        return "resume_failed";
      }

      this.logger.error("Claude Code SDK query failed.", { error });
      yield { type: "error", message: formatThrownError(error) };
    } finally {
      if (sdkQuery !== null && activeQuery.query === sdkQuery) {
        delete activeQuery.query;
      }
    }

    return "completed";
  }

  /** Requests cancellation for an active Claude Code query. */
  public async stop(session: BackendSession): Promise<void> {
    assertClaudeSession(session);

    const activeQuery = this.activeQueries.get(session);
    if (activeQuery === undefined) {
      throw new UserFacingError("CLAUDE_TASK_NOT_RUNNING", "当前 Claude Code 会话没有正在运行的任务。");
    }

    activeQuery.stopRequested = true;
    activeQuery.permissionAbortController.abort();

    if (activeQuery.query === undefined) {
      activeQuery.abortController.abort();
      return;
    }

    try {
      await activeQuery.query.interrupt();
    } catch (error: unknown) {
      this.logger.error("Claude Code SDK interrupt failed; force-closing query.", {
        error,
        cwd: session.cwd,
      });
      activeQuery.abortController.abort();
      activeQuery.query.close();
      throw new UserFacingError(
        "CLAUDE_STOP_FAILED",
        "中断当前 Agent 任务失败，请稍后重试。",
        { cause: error },
      );
    }
  }

  /** Releases adapter bookkeeping for a Claude Code session handle. */
  public close(session: BackendSession): void {
    assertClaudeSession(session);

    const activeQuery = this.activeQueries.get(session);
    if (activeQuery !== undefined) {
      activeQuery.abortController.abort();
      activeQuery.permissionAbortController.abort();
      activeQuery.query?.close();
      this.activeQueries.delete(session);
    }

    this.sessionEnvironments.delete(session);
  }

  /** Converts app config and environment selection into Claude Agent SDK options. */
  private buildQueryOptions(
    session: BackendSession,
    input: AgentInput,
    activeQuery: ActiveClaudeQuery,
    resumeSessionId?: string,
  ): Options {
    const environment = this.sessionEnvironments.get(session);
    const options: Options = {
      abortController: activeQuery.abortController,
      cwd: session.cwd,
      includePartialMessages: true,
      maxTurns: this.config.maxTurns,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: ATTACHMENT_SYSTEM_PROMPT,
      },
    };

    if (input.permissionHandler !== undefined) {
      options.canUseTool = createCanUseTool(input.permissionHandler, activeQuery);
    }

    if (this.config.allowedTools !== undefined) {
      options.allowedTools = [...this.config.allowedTools];
    }

    if (this.config.permissionMode !== undefined) {
      options.permissionMode = this.config.permissionMode;

      if (this.config.permissionMode === "bypassPermissions") {
        options.allowDangerouslySkipPermissions = true;
      }
    }

    if (environment?.agent !== undefined) {
      options.agent = environment.agent;
    }

    if (environment?.model !== undefined) {
      options.model = environment.model;
    }

    if (environment?.kind === "project") {
      const settingsSelection = selectClaudeCodeSettings(session.cwd);
      if (settingsSelection.settingsPath !== undefined) {
        options.settings = settingsSelection.settingsPath;
      }
    }

    if (resumeSessionId !== undefined) {
      options.resume = resumeSessionId;
    }

    return options;
  }
}

/** Bridges Claude SDK tool-permission callbacks to the active chat handler. */
function createCanUseTool(
  permissionHandler: AgentPermissionHandler,
  activeQuery: ActiveClaudeQuery,
): CanUseTool {
  return async (toolName, input, options): Promise<PermissionResult> => {
    const permissionSignal = createCombinedAbortSignal(
      options.signal,
      activeQuery.permissionAbortController.signal,
    );

    try {
      const decision = await permissionHandler({
        toolName,
        input,
        requestId: options.requestId,
        toolUseId: options.toolUseID,
        signal: permissionSignal.signal,
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
        ...(options.description !== undefined ? { description: options.description } : {}),
        ...(options.decisionReason !== undefined
          ? { decisionReason: options.decisionReason }
          : {}),
        ...(options.blockedPath !== undefined ? { blockedPath: options.blockedPath } : {}),
      });
      return mapPermissionDecision(decision, options.toolUseID);
    } finally {
      permissionSignal.cleanup();
    }
  };
}

function mapPermissionDecision(
  decision: AgentPermissionDecision,
  toolUseId: string,
): PermissionResult {
  if (decision.behavior === "allow") {
    return {
      behavior: "allow",
      ...(decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : {}),
      toolUseID: toolUseId,
      decisionClassification: "user_temporary",
    };
  }

  return {
    behavior: "deny",
    message: decision.message ?? "用户拒绝了本次 Claude Code 工具授权。",
    ...(decision.interrupt === true ? { interrupt: true } : {}),
    toolUseID: toolUseId,
    decisionClassification: "user_reject",
  };
}

function createCombinedAbortSignal(
  first: AbortSignal,
  second: AbortSignal,
): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();

  if (first.aborted || second.aborted) {
    controller.abort();
    return { signal: controller.signal, cleanup: () => undefined };
  }

  const abort = (): void => {
    controller.abort();
  };
  first.addEventListener("abort", abort, { once: true });
  second.addEventListener("abort", abort, { once: true });

  return {
    signal: controller.signal,
    cleanup(): void {
      first.removeEventListener("abort", abort);
      second.removeEventListener("abort", abort);
    },
  };
}

/** Ensures only Claude Code environments are opened by this adapter. */
function assertClaudeEnvironment(environment: AgentEnvironment): void {
  if (environment.backend !== CLAUDE_CODE_BACKEND) {
    throw new UserFacingError(
      "CLAUDE_BACKEND_MISMATCH",
      `Claude Code adapter cannot open backend: ${environment.backend}`,
    );
  }
}

/** Ensures only Claude Code backend sessions are sent through this adapter. */
function assertClaudeSession(session: BackendSession): void {
  if (session.backend !== CLAUDE_CODE_BACKEND) {
    throw new UserFacingError(
      "CLAUDE_BACKEND_MISMATCH",
      `Claude Code adapter cannot handle backend session: ${session.backend}`,
    );
  }
}

/** Converts SDK result messages to the backend-neutral terminal event shape. */
function mapResultMessage(message: SDKResultMessage, streamedText: boolean): AgentEvent {
  if (message.subtype === "success") {
    return {
      type: "done",
      ...(streamedText ? {} : { result: message.result }),
      sessionId: message.session_id,
    };
  }

  return { type: "error", message: formatSdkErrorResult(message) };
}

/** Detects SDK result errors that specifically mean a stored session could not resume. */
function isResumeFailureResult(
  message: SDKResultMessage,
  streamedText: boolean,
  resumeSessionId: string | undefined,
): boolean {
  if (resumeSessionId === undefined || streamedText || message.subtype === "success") {
    return false;
  }

  return isResumeFailureMessage(formatSdkErrorResult(message));
}

/** Reports an interrupted or malformed SDK stream without pretending it succeeded. */
function buildMissingResultEvent(wasStopped: boolean, sessionId?: string): AgentEvent {
  if (wasStopped) {
    return {
      type: "stopped",
      message: STOPPED_MESSAGE,
      ...(sessionId ? { sessionId } : {}),
    };
  }

  return { type: "error", message: NO_RESULT_MESSAGE };
}

/**
 * Emits tool lifecycle events derived from full assistant/user SDK messages.
 * Assistant `tool_use` blocks become `tool_start`; matching user `tool_result`
 * blocks become `tool_finish`. Tool-use ids are deduped so repeated partial
 * assistant messages do not double-emit, and finishes only fire for started tools.
 */
function* emitToolEvents(
  message: SDKMessage,
  startedToolNames: Map<string, string>,
): Generator<AgentEvent, void, void> {
  if (message.type === "assistant") {
    for (const block of extractToolUseBlocks(message)) {
      if (startedToolNames.has(block.id)) {
        continue;
      }

      startedToolNames.set(block.id, block.name);
      yield {
        type: "tool_start",
        name: block.name,
        ...(block.input !== undefined ? { input: block.input } : {}),
      };
    }
    return;
  }

  if (message.type === "user") {
    for (const toolUseId of extractToolResultIds(message)) {
      const name = startedToolNames.get(toolUseId);

      if (name === undefined) {
        continue;
      }

      startedToolNames.delete(toolUseId);
      yield { type: "tool_finish", name };
    }
  }
}

interface ToolUseBlock {
  id: string;
  name: string;
  input?: unknown;
}

/** Extracts well-formed tool_use blocks from an assistant SDK message. */
function extractToolUseBlocks(message: SDKMessage): ToolUseBlock[] {
  if (message.type !== "assistant") {
    return [];
  }

  const content = message.message.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: ToolUseBlock[] = [];
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      blocks.push({ id: block.id, name: block.name, input: block.input });
    }
  }

  return blocks;
}

/** Extracts tool_use ids referenced by tool_result blocks in a user SDK message. */
function extractToolResultIds(message: SDKMessage): string[] {
  if (message.type !== "user") {
    return [];
  }

  const content = message.message.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const ids: string[] = [];
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "tool_result" &&
      typeof block.tool_use_id === "string"
    ) {
      ids.push(block.tool_use_id);
    }
  }

  return ids;
}

/** Extracts streaming assistant text deltas from partial SDK events. */
function extractTextDelta(message: SDKMessage): string | null {
  if (message.type !== "stream_event") {
    return null;
  }

  const event = message.event;
  if (!isRecord(event) || event.type !== "content_block_delta") {
    return null;
  }

  const delta = event.delta;
  if (!isRecord(delta) || delta.type !== "text_delta") {
    return null;
  }

  const text = delta.text;
  return typeof text === "string" && text.length > 0 ? text : null;
}

/** Formats SDK error results for user-visible backend error events. */
function formatSdkErrorResult(message: Exclude<SDKResultMessage, { subtype: "success" }>): string {
  const firstError = message.errors.map((error) => error.trim()).find((error) => error.length > 0);
  const reason = firstError ?? describeSdkErrorSubtype(message.subtype);
  return `Claude Code 执行失败：${redactLogString(reason)}`;
}

/** Converts SDK result subtypes into concise fallback failure descriptions. */
function describeSdkErrorSubtype(subtype: Exclude<SDKResultMessage["subtype"], "success">): string {
  switch (subtype) {
    case "error_during_execution":
      return "执行过程中发生错误。";
    case "error_max_turns":
      return "已达到 Claude Code 最大轮数限制。";
    case "error_max_budget_usd":
      return "已达到 Claude Code 预算限制。";
    case "error_max_structured_output_retries":
      return "结构化输出重试次数已用尽。";
  }
}

/** Formats thrown SDK/runtime errors without exposing sensitive token-like values. */
function formatThrownError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return `Claude Code 调用失败：${redactLogString(error.message)}`;
  }

  return `Claude Code 调用失败：${redactLogString(String(error))}`;
}

/** Extracts thrown-error text for classification without exposing it directly to users. */
function formatUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const causeText =
      error.cause === undefined ? "" : ` ${formatUnknownErrorMessage(error.cause)}`;
    return `${error.name} ${error.message}${causeText}`;
  }

  if (typeof error === "string") {
    return error;
  }

  return String(error);
}

/** Returns true for common Claude SDK failures caused by an unavailable resume target. */
function isResumeFailureMessage(message: string): boolean {
  const normalizedMessage = message.toLowerCase();
  const mentionsResume =
    normalizedMessage.includes("resume") ||
    normalizedMessage.includes("resuming") ||
    normalizedMessage.includes("resumed");
  const mentionsSession =
    normalizedMessage.includes("session") ||
    normalizedMessage.includes("conversation") ||
    normalizedMessage.includes("transcript");
  const describesUnavailableTarget =
    normalizedMessage.includes("not found") ||
    normalizedMessage.includes("not exist") ||
    normalizedMessage.includes("does not exist") ||
    normalizedMessage.includes("missing") ||
    normalizedMessage.includes("invalid") ||
    normalizedMessage.includes("expired") ||
    normalizedMessage.includes("unable to load") ||
    normalizedMessage.includes("unable to resume") ||
    normalizedMessage.includes("could not load") ||
    normalizedMessage.includes("could not resume") ||
    normalizedMessage.includes("failed to load") ||
    normalizedMessage.includes("failed to resume") ||
    normalizedMessage.includes("no session") ||
    normalizedMessage.includes("no conversation") ||
    normalizedMessage.includes("no transcript");

  return describesUnavailableTarget && (mentionsResume || mentionsSession);
}

/** Checks whether an unknown value is a plain object-like record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
