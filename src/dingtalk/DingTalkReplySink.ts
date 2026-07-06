/** Reply sink that sends text and Markdown messages through DingTalk session webhooks. */

import type { ReplySink } from "../output/types.js";
import { AppError, createLogger, type Logger } from "../utils/index.js";
import type { DingTalkReplyContext } from "./types.js";

type WebhookFetch = typeof fetch;

type DingTalkReplyMessageType = "text" | "markdown";

interface DingTalkReplySinkOptions {
  context: DingTalkReplyContext;
  logger?: Logger;
  fetch?: WebhookFetch;
  now?: () => number;
}

interface DingTalkTextPayload {
  msgtype: "text";
  text: {
    content: string;
  };
}

interface DingTalkMarkdownPayload {
  msgtype: "markdown";
  markdown: {
    title: string;
    text: string;
  };
}

type DingTalkReplyPayload = DingTalkTextPayload | DingTalkMarkdownPayload;

interface DingTalkResponseSummary {
  code?: string;
  message?: string;
  bodyPreview?: string;
}

const DEFAULT_MARKDOWN_TITLE = "Agent 回复";
const MAX_MARKDOWN_TITLE_CHARS = 64;
const MAX_RESPONSE_PREVIEW_CHARS = 500;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX_EXCLUSIVE = 300;
const SECONDS_TIMESTAMP_MAX = 9_999_999_999;

/** Sends replies back to the DingTalk conversation that produced one robot callback. */
export class DingTalkReplySink implements ReplySink {
  private readonly context: DingTalkReplyContext;
  private readonly logger: Logger;
  private readonly fetch: WebhookFetch;
  private readonly now: () => number;

  public constructor(options: DingTalkReplySinkOptions) {
    this.context = options.context;
    this.logger = options.logger ?? createLogger("dingtalk:reply");
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Sends a plain text reply through DingTalk's per-message session webhook. */
  public async sendText(text: string): Promise<void> {
    await this.sendPayload("text", {
      msgtype: "text",
      text: {
        content: text,
      },
    });
  }

  /** Sends a Markdown reply through DingTalk's per-message session webhook. */
  public async sendMarkdown(markdown: string): Promise<void> {
    const normalizedMarkdown = normalizeMarkdown(markdown);
    await this.sendPayload("markdown", {
      msgtype: "markdown",
      markdown: {
        title: extractMarkdownTitle(normalizedMarkdown),
        text: normalizedMarkdown,
      },
    });
  }

  private async sendPayload(
    messageType: DingTalkReplyMessageType,
    payload: DingTalkReplyPayload,
  ): Promise<void> {
    const webhook = this.requireUsableSessionWebhook(messageType);

    try {
      const response = await this.fetch(webhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const responseText = await response.text();
      const summary = summarizeDingTalkResponse(responseText);

      if (!isSuccessfulReply(response, summary)) {
        this.logger.error("DingTalk reply send failed.", {
          messageType,
          status: response.status,
          statusText: response.statusText,
          dingtalkCode: summary.code,
          dingtalkMessage: summary.message,
          responseBody: summary.bodyPreview,
          messageId: this.context.messageId,
          callbackMessageId: this.context.callbackMessageId,
          conversationId: this.context.conversationId,
        });
        throw new AppError("DINGTALK_REPLY_SEND_FAILED", "Failed to send DingTalk reply.", {
          cause: {
            messageType,
            status: response.status,
            statusText: response.statusText,
            dingtalkCode: summary.code,
            dingtalkMessage: summary.message,
          },
        });
      }

      this.logger.debug("DingTalk reply sent.", {
        messageType,
        status: response.status,
        dingtalkCode: summary.code,
        messageId: this.context.messageId,
        callbackMessageId: this.context.callbackMessageId,
      });
    } catch (error: unknown) {
      if (error instanceof AppError) {
        throw error;
      }

      this.logger.error("DingTalk reply request failed.", {
        error,
        messageType,
        messageId: this.context.messageId,
        callbackMessageId: this.context.callbackMessageId,
        conversationId: this.context.conversationId,
      });
      throw new AppError("DINGTALK_REPLY_REQUEST_FAILED", "Failed to request DingTalk reply.", {
        cause: error,
      });
    }
  }

  private requireUsableSessionWebhook(messageType: DingTalkReplyMessageType): string {
    const webhook = this.context.sessionWebhook;

    if (webhook === undefined) {
      this.logger.error("DingTalk reply session webhook is missing.", {
        messageType,
        messageId: this.context.messageId,
        callbackMessageId: this.context.callbackMessageId,
        conversationId: this.context.conversationId,
        senderId: this.context.senderId,
      });
      throw new AppError(
        "DINGTALK_REPLY_WEBHOOK_MISSING",
        "DingTalk session webhook is missing.",
      );
    }

    if (isWebhookExpired(this.context.sessionWebhookExpiredTime, this.now())) {
      this.logger.error("DingTalk reply session webhook has expired.", {
        messageType,
        messageId: this.context.messageId,
        callbackMessageId: this.context.callbackMessageId,
        conversationId: this.context.conversationId,
        senderId: this.context.senderId,
        sessionWebhookExpiredTime: this.context.sessionWebhookExpiredTime,
      });
      throw new AppError(
        "DINGTALK_REPLY_WEBHOOK_EXPIRED",
        "DingTalk session webhook has expired.",
      );
    }

    return webhook;
  }
}

/** Normalizes Markdown text before sending it to DingTalk. */
function normalizeMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, "\n");

  if (hasUnclosedCodeFence(normalized)) {
    return `${normalized}\n\`\`\``;
  }

  return normalized;
}

/** Detects odd fenced code-block markers so DingTalk receives balanced Markdown. */
function hasUnclosedCodeFence(markdown: string): boolean {
  const fenceMatches = markdown.match(/^```/gm);
  return fenceMatches !== null && fenceMatches.length % 2 !== 0;
}

/** Derives DingTalk's required Markdown title from the first heading or text line. */
function extractMarkdownTitle(markdown: string): string {
  const heading = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("#"));

  if (heading !== undefined) {
    return truncateTitle(heading.replace(/^#+\s*/, ""));
  }

  const firstTextLine = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("```"));

  if (firstTextLine !== undefined) {
    return truncateTitle(stripMarkdownInlineSyntax(firstTextLine));
  }

  return DEFAULT_MARKDOWN_TITLE;
}

/** Removes simple inline Markdown markers from fallback title text. */
function stripMarkdownInlineSyntax(text: string): string {
  return text
    .replace(/[*_`~>#-]/g, "")
    .replace(/\[(?<label>[^\]]+)\]\([^)]+\)/g, "$<label>")
    .trim();
}

/** Keeps DingTalk Markdown titles short enough for notification surfaces. */
function truncateTitle(title: string): string {
  const normalizedTitle = title.trim() || DEFAULT_MARKDOWN_TITLE;

  if (normalizedTitle.length <= MAX_MARKDOWN_TITLE_CHARS) {
    return normalizedTitle;
  }

  return `${normalizedTitle.slice(0, MAX_MARKDOWN_TITLE_CHARS - 3)}...`;
}

/** Extracts a safe, bounded summary from DingTalk's webhook response body. */
function summarizeDingTalkResponse(responseText: string): DingTalkResponseSummary {
  const trimmedBody = responseText.trim();

  if (trimmedBody.length === 0) {
    return {};
  }

  const bodyPreview = truncateResponsePreview(trimmedBody);

  try {
    const parsed: unknown = JSON.parse(trimmedBody);

    if (!isRecord(parsed)) {
      return { bodyPreview };
    }

    return {
      code: readResponseCode(parsed),
      message: readResponseMessage(parsed),
      bodyPreview,
    };
  } catch {
    return { bodyPreview };
  }
}

/** Treats HTTP 2xx plus DingTalk errcode/code 0 as a successful send. */
function isSuccessfulReply(response: Response, summary: DingTalkResponseSummary): boolean {
  if (response.status < HTTP_OK_MIN || response.status >= HTTP_OK_MAX_EXCLUSIVE) {
    return false;
  }

  if (summary.code === undefined) {
    return true;
  }

  return summary.code === "0";
}

/** Reads DingTalk's common numeric/string error code fields. */
function readResponseCode(value: Record<string, unknown>): string | undefined {
  const code = value.errcode ?? value.code;

  if (typeof code === "string" || typeof code === "number") {
    return String(code);
  }

  return undefined;
}

/** Reads DingTalk's common error message fields without allowing unbounded logs. */
function readResponseMessage(value: Record<string, unknown>): string | undefined {
  const message = value.errmsg ?? value.message;

  if (typeof message === "string") {
    return truncateResponsePreview(message);
  }

  return undefined;
}

/** Checks webhook expiration while accepting either seconds or milliseconds timestamps. */
function isWebhookExpired(expiredTime: number | undefined, now: number): boolean {
  if (expiredTime === undefined) {
    return false;
  }

  const expiresAtMs = expiredTime <= SECONDS_TIMESTAMP_MAX ? expiredTime * 1000 : expiredTime;
  return expiresAtMs <= now;
}

/** Bounds logged response body snippets. */
function truncateResponsePreview(value: string): string {
  if (value.length <= MAX_RESPONSE_PREVIEW_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_RESPONSE_PREVIEW_CHARS)}...[truncated]`;
}

/** Narrows unknown JSON values to object records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
