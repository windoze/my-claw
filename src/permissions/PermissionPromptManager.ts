/** Coordinates backend permission prompts through DingTalk replies. */

import type {
  AgentPermissionDecision,
  AgentPermissionHandler,
  AgentPermissionRequest,
} from "../backend/types.js";
import type { IncomingMessage } from "../messages/types.js";
import type { ReplySink } from "../output/types.js";
import { createLogger, type Logger } from "../utils/logger.js";

/** Dependencies accepted by the permission prompt manager. */
export interface PermissionPromptManagerOptions {
  logger?: Logger;
  now?: () => number;
}

/** Per-task chat context used to send permission prompts and await replies. */
export interface PermissionPromptContext {
  message: IncomingMessage;
  replySink: ReplySink;
}

type PermissionResponseBehavior = "allow" | "deny";

type ParsedPermissionResponse =
  | {
      kind: "decision";
      behavior: PermissionResponseBehavior;
      promptId?: number;
    }
  | {
      kind: "invalid";
      message: string;
    };

interface PendingPermissionPrompt {
  id: number;
  request: AgentPermissionRequest;
  createdAtMs: number;
  promise: Promise<AgentPermissionDecision>;
  resolve: (decision: AgentPermissionDecision) => void;
  cleanup?: () => void;
}

const MAX_TOOL_INPUT_CHARS = 4_000;
const MAX_FIELD_CHARS = 800;
const ALLOW_TOKENS = new Set(["allow", "approve", "yes", "y", "ok", "允许", "同意", "批准", "通过"]);
const DENY_TOKENS = new Set(["deny", "reject", "no", "n", "拒绝", "不允许", "否"]);
const NO_PENDING_MESSAGE = "当前没有待处理的 Claude Code 授权请求。";
const AMBIGUOUS_PENDING_MESSAGE =
  "当前有多个待处理的 Claude Code 授权请求，请使用 /allow <编号> 或 /deny <编号>。";
const INVALID_RESPONSE_USAGE = "授权回复格式：/allow <编号> 或 /deny <编号>；只有一个待授权请求时可省略编号。";
const DENIED_MESSAGE = "用户拒绝了本次 Claude Code 工具授权。";
const ABORTED_MESSAGE = "任务已中断，授权请求已取消。";
const SEND_FAILED_MESSAGE = "授权请求发送到钉钉失败，已拒绝本次工具调用。";

/** Tracks pending tool-permission prompts and resolves them from incoming messages. */
export class PermissionPromptManager {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly pendingById = new Map<number, PendingPermissionPrompt>();
  private readonly pendingByRequestId = new Map<string, PendingPermissionPrompt>();
  private nextPromptId = 1;

  public constructor(options: PermissionPromptManagerOptions = {}) {
    this.logger = options.logger ?? createLogger("permissions");
    this.now = options.now ?? Date.now;
  }

  /** Creates the callback passed to a backend for the current DingTalk task. */
  public createHandler(context: PermissionPromptContext): AgentPermissionHandler {
    return (request) => this.requestPermission(request, context);
  }

  /** Handles `/allow` and `/deny` messages before they reach normal task routing. */
  public async handleResponse(message: IncomingMessage, replySink: ReplySink): Promise<boolean> {
    const parsed = parsePermissionResponse(message.text, this.pendingById.size > 0);

    if (parsed === null) {
      return false;
    }

    if (parsed.kind === "invalid") {
      await replySink.sendText(parsed.message);
      return true;
    }

    const prompt = await this.findPromptForResponse(parsed.promptId, replySink);

    if (prompt === null) {
      return true;
    }

    const decision = createDecision(parsed.behavior);
    this.resolvePending(prompt, decision);
    await replySink.sendText(formatDecisionAcknowledgement(parsed.behavior, prompt));
    this.logger.info("Claude Code permission prompt resolved from DingTalk reply.", {
      promptId: prompt.id,
      requestId: prompt.request.requestId,
      toolName: prompt.request.toolName,
      behavior: parsed.behavior,
      messageId: message.id,
      senderId: message.senderId,
    });
    return true;
  }

  private async requestPermission(
    request: AgentPermissionRequest,
    context: PermissionPromptContext,
  ): Promise<AgentPermissionDecision> {
    if (request.signal.aborted) {
      return createAbortedDecision();
    }

    const existingPrompt = this.pendingByRequestId.get(request.requestId);

    if (existingPrompt !== undefined) {
      return existingPrompt.promise;
    }

    const pending = this.createPendingPrompt(request);
    const abortHandler = (): void => {
      this.resolvePending(pending, createAbortedDecision());
    };
    pending.cleanup = (): void => {
      request.signal.removeEventListener("abort", abortHandler);
    };
    request.signal.addEventListener("abort", abortHandler, { once: true });
    this.pendingById.set(pending.id, pending);
    this.pendingByRequestId.set(request.requestId, pending);

    try {
      await context.replySink.sendMarkdown(formatPermissionPrompt(pending, this.pendingById.size));
      this.logger.info("Claude Code permission prompt sent to DingTalk.", {
        promptId: pending.id,
        requestId: request.requestId,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        messageId: context.message.id,
        senderId: context.message.senderId,
      });
      return await pending.promise;
    } catch (error: unknown) {
      this.resolvePending(pending, { behavior: "deny", message: SEND_FAILED_MESSAGE, interrupt: true });
      this.logger.error("Failed to send Claude Code permission prompt to DingTalk.", {
        error,
        promptId: pending.id,
        requestId: request.requestId,
        toolName: request.toolName,
        messageId: context.message.id,
        senderId: context.message.senderId,
      });
      return { behavior: "deny", message: SEND_FAILED_MESSAGE, interrupt: true };
    } finally {
      pending.cleanup?.();
      delete pending.cleanup;
    }
  }

  private createPendingPrompt(request: AgentPermissionRequest): PendingPermissionPrompt {
    let resolvePrompt: ((decision: AgentPermissionDecision) => void) | undefined;
    const promise = new Promise<AgentPermissionDecision>((resolve) => {
      resolvePrompt = resolve;
    });

    if (resolvePrompt === undefined) {
      throw new Error("Failed to initialize permission prompt resolver.");
    }

    return {
      id: this.nextPromptId++,
      request,
      createdAtMs: this.now(),
      promise,
      resolve: resolvePrompt,
    };
  }

  private async findPromptForResponse(
    promptId: number | undefined,
    replySink: ReplySink,
  ): Promise<PendingPermissionPrompt | null> {
    if (promptId !== undefined) {
      const prompt = this.pendingById.get(promptId);

      if (prompt === undefined) {
        await replySink.sendText(`没有找到编号 #${promptId} 的 Claude Code 授权请求。`);
        return null;
      }

      return prompt;
    }

    if (this.pendingById.size === 0) {
      await replySink.sendText(NO_PENDING_MESSAGE);
      return null;
    }

    if (this.pendingById.size > 1) {
      await replySink.sendText(AMBIGUOUS_PENDING_MESSAGE);
      return null;
    }

    return this.pendingById.values().next().value ?? null;
  }

  private resolvePending(
    pending: PendingPermissionPrompt,
    decision: AgentPermissionDecision,
  ): void {
    if (!this.pendingById.has(pending.id)) {
      return;
    }

    this.pendingById.delete(pending.id);
    this.pendingByRequestId.delete(pending.request.requestId);
    pending.cleanup?.();
    delete pending.cleanup;
    pending.resolve(decision);
  }
}

function parsePermissionResponse(
  text: string,
  hasPendingPrompt: boolean,
): ParsedPermissionResponse | null {
  const trimmedText = text.trim();

  if (trimmedText.length === 0) {
    return null;
  }

  const parts = trimmedText.split(/\s+/);
  const rawToken = parts[0] ?? "";
  const isSlashCommand = rawToken.startsWith("/");
  const token = normalizeToken(isSlashCommand ? rawToken.slice(1) : rawToken);
  const behavior = readResponseBehavior(token);

  if (behavior === null) {
    return null;
  }

  if (!isSlashCommand && !hasPendingPrompt) {
    return null;
  }

  if (parts.length > 2) {
    return { kind: "invalid", message: INVALID_RESPONSE_USAGE };
  }

  const promptIdResult = parsePromptId(parts[1]);

  if (!promptIdResult.ok) {
    return { kind: "invalid", message: INVALID_RESPONSE_USAGE };
  }

  return {
    kind: "decision",
    behavior,
    ...(promptIdResult.promptId !== undefined ? { promptId: promptIdResult.promptId } : {}),
  };
}

function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

function readResponseBehavior(token: string): PermissionResponseBehavior | null {
  if (ALLOW_TOKENS.has(token)) {
    return "allow";
  }

  if (DENY_TOKENS.has(token)) {
    return "deny";
  }

  return null;
}

function parsePromptId(value: string | undefined):
  | {
      ok: true;
      promptId?: number;
    }
  | {
      ok: false;
    } {
  if (value === undefined) {
    return { ok: true };
  }

  const normalizedValue = value.startsWith("#") ? value.slice(1) : value;
  const promptId = Number(normalizedValue);

  if (Number.isInteger(promptId) && promptId > 0) {
    return { ok: true, promptId };
  }

  return { ok: false };
}

function createDecision(behavior: PermissionResponseBehavior): AgentPermissionDecision {
  if (behavior === "allow") {
    return { behavior: "allow" };
  }

  return { behavior: "deny", message: DENIED_MESSAGE };
}

function createAbortedDecision(): AgentPermissionDecision {
  return { behavior: "deny", message: ABORTED_MESSAGE, interrupt: true };
}

function formatPermissionPrompt(
  pending: PendingPermissionPrompt,
  pendingCount: number,
): string {
  const request = pending.request;
  const lines = [
    "### Claude Code 请求工具授权",
    "",
    `编号：#${pending.id}`,
    `工具：${formatInlineCode(request.toolName)}`,
  ];

  appendOptionalField(lines, "请求", request.title);
  appendOptionalField(lines, "动作", request.displayName);
  appendOptionalField(lines, "说明", request.description);
  appendOptionalField(lines, "原因", request.decisionReason);

  if (isNonEmptyString(request.blockedPath)) {
    lines.push(`路径：${formatInlineCode(request.blockedPath)}`);
  }

  lines.push("", "工具输入：", "```json", formatToolInput(request.input), "```", "");

  if (pendingCount > 1) {
    lines.push("当前有多个待授权请求，请在回复中带上编号。");
  }

  lines.push(
    `回复 ${formatInlineCode(`/allow ${pending.id}`)} 允许本次工具调用，或 ${formatInlineCode(`/deny ${pending.id}`)} 拒绝。`,
    "只有一个待授权请求时，也可以直接回复 /allow 或 /deny。",
    "也可以发送 /stop 中断当前 Agent 任务。",
  );

  return lines.join("\n");
}

function appendOptionalField(lines: string[], label: string, value: string | undefined): void {
  if (!isNonEmptyString(value)) {
    return;
  }

  lines.push(`${label}：${truncateText(normalizeFieldText(value), MAX_FIELD_CHARS)}`);
}

function formatToolInput(input: Record<string, unknown>): string {
  return truncateText(safeStringify(input).replace(/```/g, "` ` `"), MAX_TOOL_INPUT_CHARS);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "[tool input could not be serialized]";
  }
}

function normalizeFieldText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatInlineCode(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n... [truncated]`;
}

function formatDecisionAcknowledgement(
  behavior: PermissionResponseBehavior,
  prompt: PendingPermissionPrompt,
): string {
  if (behavior === "allow") {
    return `已允许 Claude Code 授权请求 #${prompt.id}：${prompt.request.toolName}`;
  }

  return `已拒绝 Claude Code 授权请求 #${prompt.id}：${prompt.request.toolName}`;
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
