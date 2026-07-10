/** Reply sink that sends text, Markdown, and file messages through DingTalk APIs. */

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type { DingTalkConfig } from "../config/types.js";
import type { ReplyCardStreamer, ReplyFile, ReplyImage, ReplySink } from "../output/types.js";
import { AppError, createLogger, type Logger } from "../utils/index.js";
import type { DingTalkReplyContext } from "./types.js";

type WebhookFetch = typeof fetch;

type DingTalkReplyMessageType = "text" | "markdown" | "file";

/** DingTalk media upload categories accepted by the /media/upload endpoint. */
type DingTalkMediaType = "file" | "image";

interface DingTalkReplySinkOptions {
  context: DingTalkReplyContext;
  config?: DingTalkConfig;
  fileClient?: DingTalkFileClient;
  cardStreamer?: ReplyCardStreamer;
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

interface DingTalkFilePayload {
  msgtype: "file";
  file: {
    mediaId: string;
    fileName: string;
    fileType: string;
  };
}

type DingTalkReplyPayload = DingTalkTextPayload | DingTalkMarkdownPayload | DingTalkFilePayload;

interface DingTalkResponseSummary {
  code?: string;
  message?: string;
  bodyPreview?: string;
}

interface DingTalkAccessTokenCache {
  token: string;
  expiresAtMs: number;
}

interface DingTalkFileClientOptions {
  config: DingTalkConfig;
  logger?: Logger;
  fetch?: WebhookFetch;
  now?: () => number;
}

interface MultipartFileBody {
  body: ArrayBuffer;
  contentType: string;
}

const DEFAULT_MARKDOWN_TITLE = "Agent 回复";
const MAX_MARKDOWN_TITLE_CHARS = 64;
const MAX_RESPONSE_PREVIEW_CHARS = 500;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX_EXCLUSIVE = 300;
const SECONDS_TIMESTAMP_MAX = 9_999_999_999;
const ACCESS_TOKEN_URL = "https://oapi.dingtalk.com/gettoken";
const MEDIA_UPLOAD_URL = "https://oapi.dingtalk.com/media/upload";
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;

/** Uploads local files to DingTalk media storage and caches the required access token. */
export class DingTalkFileClient {
  private readonly config: DingTalkConfig;
  private readonly logger: Logger;
  private readonly fetch: WebhookFetch;
  private readonly now: () => number;
  private tokenCache: DingTalkAccessTokenCache | null = null;

  public constructor(options: DingTalkFileClientOptions) {
    this.config = options.config;
    this.logger = options.logger ?? createLogger("dingtalk:file");
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Uploads a local file or image and returns the media id DingTalk expects in messages. */
  public async uploadFile(file: ReplyFile, mediaType: DingTalkMediaType = "file"): Promise<string> {
    const accessToken = await this.getAccessToken();
    const uploadUrl = new URL(MEDIA_UPLOAD_URL);
    uploadUrl.searchParams.set("access_token", accessToken);
    uploadUrl.searchParams.set("type", mediaType);
    const multipart = await createMultipartFileBody(file);

    try {
      const response = await this.fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": multipart.contentType,
        },
        body: multipart.body,
      });
      const responseText = await response.text();
      const summary = summarizeDingTalkResponse(responseText);
      const mediaId = readMediaId(responseText);

      if (!isSuccessfulReply(response, summary) || mediaId === undefined) {
        this.logger.error("DingTalk media upload failed.", {
          status: response.status,
          statusText: response.statusText,
          dingtalkCode: summary.code,
          dingtalkMessage: summary.message,
          responseBody: summary.bodyPreview,
          fileName: file.name,
          sizeBytes: file.sizeBytes,
        });
        throw new AppError(
          "DINGTALK_FILE_UPLOAD_FAILED",
          "Failed to upload DingTalk file media.",
          {
            cause: {
              status: response.status,
              statusText: response.statusText,
              dingtalkCode: summary.code,
              dingtalkMessage: summary.message,
            },
          },
        );
      }

      this.logger.debug("DingTalk media uploaded.", {
        fileName: file.name,
        sizeBytes: file.sizeBytes,
      });
      return mediaId;
    } catch (error: unknown) {
      if (error instanceof AppError) {
        throw error;
      }

      this.logger.error("DingTalk media upload request failed.", {
        error,
        fileName: file.name,
        sizeBytes: file.sizeBytes,
      });
      throw new AppError(
        "DINGTALK_FILE_UPLOAD_REQUEST_FAILED",
        "Failed to request DingTalk file media upload.",
        { cause: error },
      );
    }
  }

  private async getAccessToken(): Promise<string> {
    const cachedToken = this.tokenCache;

    if (cachedToken !== null && cachedToken.expiresAtMs > this.now()) {
      return cachedToken.token;
    }

    const tokenUrl = new URL(ACCESS_TOKEN_URL);
    tokenUrl.searchParams.set("appkey", this.config.clientId);
    tokenUrl.searchParams.set("appsecret", this.config.clientSecret);

    try {
      const response = await this.fetch(tokenUrl);
      const responseText = await response.text();
      const summary = summarizeDingTalkResponse(responseText);
      const token = readAccessToken(responseText);
      const expiresInSeconds = readAccessTokenExpiresIn(responseText);

      if (!isSuccessfulReply(response, summary) || token === undefined) {
        this.logger.error("DingTalk access token request failed.", {
          status: response.status,
          statusText: response.statusText,
          dingtalkCode: summary.code,
          dingtalkMessage: summary.message,
          responseBody: summary.bodyPreview,
        });
        throw new AppError(
          "DINGTALK_FILE_TOKEN_FAILED",
          "Failed to obtain DingTalk access token.",
          {
            cause: {
              status: response.status,
              statusText: response.statusText,
              dingtalkCode: summary.code,
              dingtalkMessage: summary.message,
            },
          },
        );
      }

      this.tokenCache = {
        token,
        expiresAtMs:
          this.now() + expiresInSeconds * 1000 - ACCESS_TOKEN_EXPIRY_SKEW_MS,
      };
      return token;
    } catch (error: unknown) {
      if (error instanceof AppError) {
        throw error;
      }

      this.logger.error("DingTalk access token request failed.", { error });
      throw new AppError(
        "DINGTALK_FILE_TOKEN_REQUEST_FAILED",
        "Failed to request DingTalk access token.",
        { cause: error },
      );
    }
  }
}

/** Sends replies back to the DingTalk conversation that produced one robot callback. */
export class DingTalkReplySink implements ReplySink {
  private readonly context: DingTalkReplyContext;
  private readonly config?: DingTalkConfig;
  private readonly fileClient?: DingTalkFileClient;
  public readonly cardStreamer?: ReplyCardStreamer;
  private readonly logger: Logger;
  private readonly fetch: WebhookFetch;
  private readonly now: () => number;

  public constructor(options: DingTalkReplySinkOptions) {
    this.context = options.context;
    this.config = options.config;
    this.fileClient = options.fileClient;
    this.cardStreamer = options.cardStreamer;
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

  /** Uploads a local file to DingTalk and sends a file message through the session webhook. */
  public async sendFile(file: ReplyFile): Promise<void> {
    const fileClient = this.fileClient ?? this.createFileClient();
    const mediaId = await fileClient.uploadFile(file);

    await this.sendPayload("file", {
      msgtype: "file",
      file: {
        mediaId,
        fileName: file.name,
        fileType: extractFileType(file.name),
      },
    });
  }

  /**
   * Uploads a local image to DingTalk and renders it inline via a Markdown message.
   *
   * The session webhook's `image` msgtype only accepts a public `picURL`, which local
   * files lack. DingTalk instead lets an uploaded image `mediaId` stand in for a URL
   * inside Markdown, so images are delivered as `![alt](mediaId)`.
   */
  public async sendImage(image: ReplyImage): Promise<void> {
    const mediaId = await this.uploadImage(image);
    const altText = escapeMarkdownImageAlt(image.name);

    await this.sendPayload("markdown", {
      msgtype: "markdown",
      markdown: {
        title: truncateTitle(image.name),
        text: `![${altText}](${mediaId})`,
      },
    });
  }

  /** Uploads a local image and returns the DingTalk mediaId usable as a Markdown URL. */
  public async uploadImage(image: ReplyImage): Promise<string> {
    const fileClient = this.fileClient ?? this.createFileClient();
    return fileClient.uploadFile(image, "image");
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

  private createFileClient(): DingTalkFileClient {
    if (this.config === undefined) {
      throw new AppError(
        "DINGTALK_FILE_CONFIG_MISSING",
        "DingTalk file sending requires DingTalk credentials.",
      );
    }

    return new DingTalkFileClient({
      config: this.config,
      logger: this.logger,
      fetch: this.fetch,
      now: this.now,
    });
  }
}

async function createMultipartFileBody(file: ReplyFile): Promise<MultipartFileBody> {
  const boundary = `----my-claw-${randomUUID()}`;
  const header = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="media"; filename="${escapeMultipartFileName(file.name)}"`,
      "Content-Type: application/octet-stream",
      "",
      "",
    ].join("\r\n"),
  );
  const content = await readFile(file.path);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

  return {
    body: toArrayBuffer(Buffer.concat([header, content, footer])),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function escapeMultipartFileName(fileName: string): string {
  return fileName.replace(/[\r\n"]/g, "_");
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
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

/** Derives DingTalk's required `fileType` (extension without the dot) from a file name. */
function extractFileType(fileName: string): string {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).trim().toLowerCase();
  return extension.length > 0 && extension.length < fileName.length ? extension : "";
}

/** Escapes characters that would break the alt text of an inline Markdown image. */
function escapeMarkdownImageAlt(alt: string): string {
  return alt.replace(/[\r\n]+/g, " ").replace(/[[\]]/g, "");
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

function readMediaId(responseText: string): string | undefined {
  const parsed = parseResponseRecord(responseText);
  const mediaId = parsed?.media_id ?? parsed?.mediaId;

  if (typeof mediaId === "string" && mediaId.length > 0) {
    return mediaId;
  }

  return undefined;
}

function readAccessToken(responseText: string): string | undefined {
  const parsed = parseResponseRecord(responseText);
  const token = parsed?.access_token ?? parsed?.accessToken;

  if (typeof token === "string" && token.length > 0) {
    return token;
  }

  return undefined;
}

function readAccessTokenExpiresIn(responseText: string): number {
  const parsed = parseResponseRecord(responseText);
  const expiresIn = parsed?.expires_in ?? parsed?.expireIn ?? parsed?.expiresIn;

  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return expiresIn;
  }

  if (typeof expiresIn === "string") {
    const parsedExpiresIn = Number.parseInt(expiresIn, 10);

    if (Number.isFinite(parsedExpiresIn) && parsedExpiresIn > 0) {
      return parsedExpiresIn;
    }
  }

  return 7200;
}

function parseResponseRecord(responseText: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(responseText);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
