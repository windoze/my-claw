/** BackendAdapter implementation backed by the Claude Agent SDK query API. */

import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeCodeConfig } from "../../config/types.js";
import type { AgentEnvironment } from "../../session/types.js";
import { UserFacingError } from "../../utils/errors.js";
import { createLogger, redactLogString, type Logger } from "../../utils/logger.js";
import type { AgentEvent, AgentInput, BackendAdapter, BackendSession } from "../types.js";
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
  query?: Query;
}

const CLAUDE_CODE_BACKEND = "claude-code";
const NO_RESULT_MESSAGE = "Claude Code 未返回完成结果。";
const STOPPED_MESSAGE = "当前 Agent 任务已中断。";

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
    const activeQuery: ActiveClaudeQuery = { abortController };
    this.activeQueries.set(session, activeQuery);

    let streamedText = false;
    let terminalEventEmitted = false;

    try {
      const sdkQuery = this.queryFn({
        prompt: input.text,
        options: this.buildQueryOptions(session, abortController),
      });
      activeQuery.query = sdkQuery;

      for await (const sdkMessage of sdkQuery) {
        const text = extractTextDelta(sdkMessage);
        if (text !== null) {
          streamedText = true;
          yield { type: "text", text };
          continue;
        }

        if (sdkMessage.type === "result") {
          terminalEventEmitted = true;
          yield mapResultMessage(sdkMessage, streamedText);
        }
      }

      if (!terminalEventEmitted) {
        yield buildMissingResultEvent(abortController.signal.aborted);
      }
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        yield { type: "stopped", message: STOPPED_MESSAGE };
        return;
      }

      this.logger.error("Claude Code SDK query failed.", { error });
      yield { type: "error", message: formatThrownError(error) };
    } finally {
      this.activeQueries.delete(session);
    }
  }

  /** Requests cancellation for an active Claude Code query. */
  public stop(session: BackendSession): void {
    assertClaudeSession(session);

    const activeQuery = this.activeQueries.get(session);
    if (activeQuery === undefined) {
      throw new UserFacingError("CLAUDE_TASK_NOT_RUNNING", "当前 Claude Code 会话没有正在运行的任务。");
    }

    activeQuery.abortController.abort();
    activeQuery.query?.close();
  }

  /** Releases adapter bookkeeping for a Claude Code session handle. */
  public close(session: BackendSession): void {
    assertClaudeSession(session);

    const activeQuery = this.activeQueries.get(session);
    if (activeQuery !== undefined) {
      activeQuery.abortController.abort();
      activeQuery.query?.close();
      this.activeQueries.delete(session);
    }

    this.sessionEnvironments.delete(session);
  }

  /** Converts app config and environment selection into Claude Agent SDK options. */
  private buildQueryOptions(session: BackendSession, abortController: AbortController): Options {
    const environment = this.sessionEnvironments.get(session);
    const options: Options = {
      abortController,
      cwd: session.cwd,
      includePartialMessages: true,
      maxTurns: this.config.maxTurns,
    };

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

    return options;
  }
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

/** Reports an interrupted or malformed SDK stream without pretending it succeeded. */
function buildMissingResultEvent(wasAborted: boolean): AgentEvent {
  if (wasAborted) {
    return { type: "stopped", message: STOPPED_MESSAGE };
  }

  return { type: "error", message: NO_RESULT_MESSAGE };
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

/** Checks whether an unknown value is a plain object-like record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
