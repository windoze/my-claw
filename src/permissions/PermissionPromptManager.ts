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

/** How a backend `canUseTool` request should be surfaced to the user. */
type PromptKind = "permission" | "question" | "plan";

const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
const EXIT_PLAN_MODE_TOOL = "ExitPlanMode";

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

/** One choice offered by an AskUserQuestion prompt. */
interface QuestionOption {
  label: string;
  description?: string;
}

/** One normalized AskUserQuestion question extracted from the raw tool input. */
interface ParsedQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface PendingPermissionPrompt {
  id: number;
  kind: PromptKind;
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
const PLAN_REJECTED_MESSAGE = "用户希望继续完善计划，暂不执行。";
const AMBIGUOUS_PENDING_QUESTION_MESSAGE =
  "当前有多个待回答的 Claude Code 提问，请在回复前加上编号，例如 #1 2。";
const MAX_ANSWER_LINE_CHARS = 800;

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

  /** Handles permission decisions and interactive question answers before normal routing. */
  public async handleResponse(message: IncomingMessage, replySink: ReplySink): Promise<boolean> {
    if (await this.handleQuestionAnswer(message, replySink)) {
      return true;
    }

    return this.handleDecisionResponse(message, replySink);
  }

  /** Resolves `/allow` and `/deny` replies for permission and plan prompts. */
  private async handleDecisionResponse(
    message: IncomingMessage,
    replySink: ReplySink,
  ): Promise<boolean> {
    const decisionPrompts = this.listDecisionPrompts();
    const parsed = parsePermissionResponse(message.text, decisionPrompts.length > 0);

    if (parsed === null) {
      return false;
    }

    if (parsed.kind === "invalid") {
      await replySink.sendText(parsed.message);
      return true;
    }

    const prompt = await this.findPromptForResponse(parsed.promptId, decisionPrompts, replySink);

    if (prompt === null) {
      return true;
    }

    const decision = createDecision(parsed.behavior, prompt);
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

  /** Resolves an AskUserQuestion prompt from a numbered/free-text answer reply. */
  private async handleQuestionAnswer(
    message: IncomingMessage,
    replySink: ReplySink,
  ): Promise<boolean> {
    const questionPrompts = this.listPromptsByKind("question");

    if (questionPrompts.length === 0) {
      return false;
    }

    const parsed = parseQuestionReply(message.text);

    if (parsed === null) {
      return false;
    }

    const prompt =
      parsed.promptId !== undefined
        ? this.pendingById.get(parsed.promptId)
        : questionPrompts.length === 1
          ? questionPrompts[0]
          : undefined;

    if (parsed.promptId !== undefined && (prompt === undefined || prompt.kind !== "question")) {
      await replySink.sendText(`没有找到编号 #${parsed.promptId} 的 Claude Code 提问。`);
      return true;
    }

    if (prompt === undefined) {
      await replySink.sendText(AMBIGUOUS_PENDING_QUESTION_MESSAGE);
      return true;
    }

    const questions = parseQuestions(prompt.request.input);
    const outcome = buildAnswers(questions, parsed.answerLines);

    if (!outcome.ok) {
      await replySink.sendText(outcome.message);
      return true;
    }

    const updatedInput = { ...prompt.request.input, answers: outcome.answers };
    this.resolvePending(prompt, { behavior: "allow", updatedInput });
    await replySink.sendText(formatAnswerAcknowledgement(prompt, outcome.answers));
    this.logger.info("Claude Code question prompt answered from DingTalk reply.", {
      promptId: prompt.id,
      requestId: prompt.request.requestId,
      toolName: prompt.request.toolName,
      messageId: message.id,
      senderId: message.senderId,
    });
    return true;
  }

  /** Lists pending prompts of a given kind ordered by creation. */
  private listPromptsByKind(kind: PromptKind): PendingPermissionPrompt[] {
    return [...this.pendingById.values()].filter((prompt) => prompt.kind === kind);
  }

  /** Lists prompts answerable via `/allow` and `/deny` (permission and plan prompts). */
  private listDecisionPrompts(): PendingPermissionPrompt[] {
    return [...this.pendingById.values()].filter((prompt) => prompt.kind !== "question");
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
      await context.replySink.sendMarkdown(formatPrompt(pending, this.pendingById.size));
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
      kind: classifyPromptKind(request.toolName),
      request,
      createdAtMs: this.now(),
      promise,
      resolve: resolvePrompt,
    };
  }

  private async findPromptForResponse(
    promptId: number | undefined,
    decisionPrompts: readonly PendingPermissionPrompt[],
    replySink: ReplySink,
  ): Promise<PendingPermissionPrompt | null> {
    if (promptId !== undefined) {
      const prompt = decisionPrompts.find((candidate) => candidate.id === promptId);

      if (prompt === undefined) {
        await replySink.sendText(`没有找到编号 #${promptId} 的 Claude Code 授权请求。`);
        return null;
      }

      return prompt;
    }

    if (decisionPrompts.length === 0) {
      await replySink.sendText(NO_PENDING_MESSAGE);
      return null;
    }

    if (decisionPrompts.length > 1) {
      await replySink.sendText(AMBIGUOUS_PENDING_MESSAGE);
      return null;
    }

    return decisionPrompts[0] ?? null;
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

function createDecision(
  behavior: PermissionResponseBehavior,
  prompt: PendingPermissionPrompt,
): AgentPermissionDecision {
  if (behavior === "allow") {
    return { behavior: "allow" };
  }

  const message = prompt.kind === "plan" ? PLAN_REJECTED_MESSAGE : DENIED_MESSAGE;
  return { behavior: "deny", message };
}

/** Classifies a backend tool request into how it should be surfaced to the user. */
function classifyPromptKind(toolName: string): PromptKind {
  if (toolName === ASK_USER_QUESTION_TOOL) {
    return "question";
  }

  if (toolName === EXIT_PLAN_MODE_TOOL) {
    return "plan";
  }

  return "permission";
}

/** Renders a pending prompt into user-facing Markdown based on its kind. */
function formatPrompt(pending: PendingPermissionPrompt, pendingCount: number): string {
  if (pending.kind === "question") {
    return formatQuestionPrompt(pending);
  }

  if (pending.kind === "plan") {
    return formatPlanPrompt(pending);
  }

  return formatPermissionPrompt(pending, pendingCount);
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
  if (prompt.kind === "plan") {
    return behavior === "allow"
      ? `已批准 Claude Code 执行计划 #${prompt.id}。`
      : `已让 Claude Code 继续完善计划 #${prompt.id}。`;
  }

  if (behavior === "allow") {
    return `已允许 Claude Code 授权请求 #${prompt.id}：${prompt.request.toolName}`;
  }

  return `已拒绝 Claude Code 授权请求 #${prompt.id}：${prompt.request.toolName}`;
}

/** Renders an AskUserQuestion prompt as a readable numbered-option list. */
function formatQuestionPrompt(pending: PendingPermissionPrompt): string {
  const questions = parseQuestions(pending.request.input);
  const lines = ["### Claude Code 提问", "", `编号：#${pending.id}`, ""];

  if (questions.length === 0) {
    // Fall back to raw input if the shape is unexpected so nothing is silently dropped.
    lines.push("工具输入：", "```json", formatToolInput(pending.request.input), "```", "");
    lines.push("无法解析提问选项，请发送 /stop 中断当前 Agent 任务。");
    return lines.join("\n");
  }

  const multiQuestion = questions.length > 1;
  let optionNumber = 1;

  questions.forEach((question, index) => {
    const heading = multiQuestion ? `问题 ${index + 1}` : "问题";
    const headerSuffix = isNonEmptyString(question.header) ? `（${question.header}）` : "";
    lines.push(`**${heading}${headerSuffix}**：${normalizeFieldText(question.question)}`);

    if (question.multiSelect) {
      lines.push("（可多选）");
    }

    for (const option of question.options) {
      const description = isNonEmptyString(option.description)
        ? ` — ${truncateText(normalizeFieldText(option.description), MAX_FIELD_CHARS)}`
        : "";
      lines.push(`${optionNumber}. ${option.label}${description}`);
      optionNumber += 1;
    }

    lines.push("");
  });

  lines.push(...formatQuestionReplyHint(questions));
  lines.push("也可以发送 /stop 中断当前 Agent 任务。");

  return lines.join("\n");
}

/** Builds the reply-format hint tailored to the number of questions asked. */
function formatQuestionReplyHint(questions: readonly ParsedQuestion[]): string[] {
  if (questions.length > 1) {
    return [
      "请分行回复，每行对应一个问题，按上面的选项编号（多选用逗号分隔），例如：",
      "```",
      "1",
      "2,3",
      "```",
      "也可以直接输入自定义答案文本代替编号。",
    ];
  }

  const [question] = questions;
  const example = question?.multiSelect ? "1,3" : "2";
  return [
    `直接回复选项编号即可，例如 ${formatInlineCode(example)}${question?.multiSelect ? "（多选用逗号分隔）" : ""}。`,
    "也可以直接输入自定义答案文本代替编号。",
  ];
}

/** Renders an ExitPlanMode prompt as a readable plan-approval request. */
function formatPlanPrompt(pending: PendingPermissionPrompt): string {
  const request = pending.request;
  const lines = ["### Claude Code 请求批准执行计划", "", `编号：#${pending.id}`, ""];

  appendOptionalField(lines, "说明", request.description);

  const allowedPrompts = extractAllowedPrompts(request.input);
  if (allowedPrompts.length > 0) {
    lines.push("计划中涉及的操作：");
    for (const prompt of allowedPrompts) {
      lines.push(`- ${truncateText(normalizeFieldText(prompt), MAX_FIELD_CHARS)}`);
    }
    lines.push("");
  }

  lines.push(
    `回复 ${formatInlineCode(`/allow ${pending.id}`)} 批准并开始执行计划，或 ${formatInlineCode(`/deny ${pending.id}`)} 让 Claude Code 继续完善计划。`,
    "只有一个待处理请求时，也可以直接回复 /allow 或 /deny。",
    "也可以发送 /stop 中断当前 Agent 任务。",
  );

  return lines.join("\n");
}

/** Extracts the human-readable Bash action prompts from an ExitPlanMode input. */
function extractAllowedPrompts(input: Record<string, unknown>): string[] {
  const allowedPrompts = input.allowedPrompts;

  if (!Array.isArray(allowedPrompts)) {
    return [];
  }

  const prompts: string[] = [];
  for (const entry of allowedPrompts) {
    if (isRecord(entry) && typeof entry.prompt === "string" && entry.prompt.trim().length > 0) {
      prompts.push(entry.prompt);
    }
  }

  return prompts;
}

/** Parsed answer reply: an optional prompt id plus one answer segment per question. */
interface ParsedQuestionReply {
  promptId?: number;
  answerLines: string[];
}

/** Parses a user reply into per-question answer segments, or null if it isn't an answer. */
function parseQuestionReply(text: string): ParsedQuestionReply | null {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return null;
  }

  // Answers to permission/plan prompts (/allow, /deny, /stop) are handled elsewhere.
  if (trimmed.startsWith("/")) {
    return null;
  }

  const rawLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rawLines.length === 0) {
    return null;
  }

  const firstLine = rawLines[0] ?? "";
  const idMatch = firstLine.match(/^#(\d+)\s+(.*)$/);

  if (idMatch !== null) {
    const promptId = Number(idMatch[1]);
    const remainder = (idMatch[2] ?? "").trim();
    const answerLines = remainder.length > 0 ? [remainder, ...rawLines.slice(1)] : rawLines.slice(1);

    if (answerLines.length === 0) {
      return null;
    }

    return { promptId, answerLines };
  }

  return { answerLines: rawLines };
}

type BuildAnswersOutcome =
  | { ok: true; answers: Record<string, string> }
  | { ok: false; message: string };

/** Maps per-question answer segments onto option labels, validating count and range. */
function buildAnswers(
  questions: readonly ParsedQuestion[],
  answerLines: readonly string[],
): BuildAnswersOutcome {
  if (questions.length === 0) {
    return { ok: false, message: "无法解析本次提问，请发送 /stop 中断当前 Agent 任务后重试。" };
  }

  if (answerLines.length !== questions.length) {
    return {
      ok: false,
      message:
        questions.length === 1
          ? "请只回复一个答案（选项编号或自定义文本）。"
          : `本次提问有 ${questions.length} 个问题，请分 ${questions.length} 行回复，每行对应一个问题。`,
    };
  }

  const answers: Record<string, string> = {};

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const rawAnswer = (answerLines[index] ?? "").trim();

    if (question === undefined || rawAnswer.length === 0) {
      return { ok: false, message: "答案不能为空，请重新回复。" };
    }

    const resolved = resolveAnswerForQuestion(question, rawAnswer, index, questions.length);

    if (!resolved.ok) {
      return resolved;
    }

    answers[question.question] = resolved.value;
  }

  return { ok: true, answers };
}

/** Resolves one answer segment: numeric tokens become option labels; text passes through. */
function resolveAnswerForQuestion(
  question: ParsedQuestion,
  rawAnswer: string,
  questionIndex: number,
  questionCount: number,
): { ok: true; value: string } | { ok: false; message: string } {
  const label = questionCount > 1 ? `问题 ${questionIndex + 1}` : "问题";
  const tokens = rawAnswer
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const allNumeric = tokens.length > 0 && tokens.every((token) => /^\d+$/.test(token));

  // A non-numeric answer is treated as free-text (the SDK-provided "Other" option).
  if (!allNumeric) {
    return { ok: true, value: truncateText(rawAnswer, MAX_ANSWER_LINE_CHARS) };
  }

  if (!question.multiSelect && tokens.length > 1) {
    return { ok: false, message: `${label}为单选，请只回复一个选项编号。` };
  }

  const labels: string[] = [];
  for (const token of tokens) {
    const optionIndex = Number(token) - 1;
    const option = question.options[optionIndex];

    if (option === undefined) {
      return {
        ok: false,
        message: `${label}没有编号 ${token} 的选项，请回复 1 到 ${question.options.length} 之间的编号。`,
      };
    }

    labels.push(option.label);
  }

  return { ok: true, value: labels.join(", ") };
}

/** Normalizes the raw AskUserQuestion tool input into a simple question list. */
function parseQuestions(input: Record<string, unknown>): ParsedQuestion[] {
  const rawQuestions = input.questions;

  if (!Array.isArray(rawQuestions)) {
    return [];
  }

  const questions: ParsedQuestion[] = [];

  for (const rawQuestion of rawQuestions) {
    if (!isRecord(rawQuestion) || typeof rawQuestion.question !== "string") {
      continue;
    }

    const options = parseQuestionOptions(rawQuestion.options);

    if (options.length === 0) {
      continue;
    }

    questions.push({
      question: rawQuestion.question,
      ...(typeof rawQuestion.header === "string" ? { header: rawQuestion.header } : {}),
      options,
      multiSelect: rawQuestion.multiSelect === true,
    });
  }

  return questions;
}

/** Extracts the label/description option pairs from a raw question options array. */
function parseQuestionOptions(rawOptions: unknown): QuestionOption[] {
  if (!Array.isArray(rawOptions)) {
    return [];
  }

  const options: QuestionOption[] = [];

  for (const rawOption of rawOptions) {
    if (!isRecord(rawOption) || typeof rawOption.label !== "string") {
      continue;
    }

    options.push({
      label: rawOption.label,
      ...(typeof rawOption.description === "string" ? { description: rawOption.description } : {}),
    });
  }

  return options;
}

/** Confirms which answers were recorded for an AskUserQuestion prompt. */
function formatAnswerAcknowledgement(
  prompt: PendingPermissionPrompt,
  answers: Record<string, string>,
): string {
  const lines = [`已回答 Claude Code 提问 #${prompt.id}：`];

  for (const [question, answer] of Object.entries(answers)) {
    lines.push(`- ${truncateText(normalizeFieldText(question), MAX_FIELD_CHARS)} → ${answer}`);
  }

  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
