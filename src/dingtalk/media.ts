/** DingTalk media download helpers for user-provided robot attachments. */

import type { DingTalkConfig } from "../config/types.js";
import type { TempFileStore } from "../files/TempFileStore.js";
import type { IncomingMessage, IncomingMessageAttachment } from "../messages/types.js";
import { AppError, UserFacingError } from "../utils/errors.js";
import { createLogger, type Logger } from "../utils/logger.js";

type DingTalkFetch = typeof fetch;

/** Options used to create a DingTalkMediaClient. */
export interface DingTalkMediaClientOptions {
  config: DingTalkConfig;
  logger?: Logger;
  fetch?: DingTalkFetch;
  now?: () => number;
}

/** Options used to materialize message attachments before backend execution. */
export interface DingTalkAttachmentResolverOptions {
  mediaClient: DingTalkMediaClient;
  tempFileStore: TempFileStore;
  logger?: Logger;
}

/** Resolves downloadable DingTalk attachments into local temp files. */
export type DingTalkAttachmentResolver = (message: IncomingMessage) => Promise<IncomingMessage>;

interface DingTalkAccessTokenCache {
  token: string;
  expiresAtMs: number;
}

interface DingTalkResponseSummary {
  code?: string;
  message?: string;
  bodyPreview?: string;
}

const ACCESS_TOKEN_URL = "https://oapi.dingtalk.com/gettoken";
const MESSAGE_FILE_DOWNLOAD_URL = "https://api.dingtalk.com/v1.0/robot/messageFiles/download";
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX_EXCLUSIVE = 300;
const MAX_RESPONSE_PREVIEW_CHARS = 500;

/** Minimal DingTalk OpenAPI client for robot attachment downloads. */
export class DingTalkMediaClient {
  private readonly config: DingTalkConfig;
  private readonly logger: Logger;
  private readonly fetch: DingTalkFetch;
  private readonly now: () => number;
  private tokenCache: DingTalkAccessTokenCache | null = null;

  public constructor(options: DingTalkMediaClientOptions) {
    this.config = options.config;
    this.logger = options.logger ?? createLogger("dingtalk:media");
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Downloads one robot message attachment stream by its DingTalk downloadCode. */
  public async downloadMessageFile(attachment: IncomingMessageAttachment): Promise<Response> {
    const downloadCode = normalizeDownloadCode(attachment.downloadCode);

    if (downloadCode === undefined) {
      throw new UserFacingError(
        "DINGTALK_ATTACHMENT_DOWNLOAD_CODE_MISSING",
        `无法下载附件：${displayAttachmentName(attachment)}。`,
      );
    }

    try {
      const accessToken = await this.getAccessToken();
      const response = await this.fetch(MESSAGE_FILE_DOWNLOAD_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": accessToken,
        },
        body: JSON.stringify({ downloadCode }),
      });

      if (response.status < HTTP_OK_MIN || response.status >= HTTP_OK_MAX_EXCLUSIVE) {
        const responseText = await response.text();
        const summary = summarizeDingTalkResponse(responseText);
        this.logger.error("DingTalk attachment download failed.", {
          status: response.status,
          statusText: response.statusText,
          dingtalkCode: summary.code,
          dingtalkMessage: summary.message,
          responseBody: summary.bodyPreview,
          fileName: attachment.filename,
          mime: attachment.mime,
          type: attachment.type,
        });
        throw new UserFacingError(
          "DINGTALK_ATTACHMENT_DOWNLOAD_FAILED",
          `附件下载失败：${displayAttachmentName(attachment)}。请稍后重试或查看服务日志。`,
        );
      }

      return response;
    } catch (error: unknown) {
      if (error instanceof UserFacingError) {
        throw error;
      }

      this.logger.error("DingTalk attachment download request failed.", {
        error,
        fileName: attachment.filename,
        mime: attachment.mime,
        type: attachment.type,
      });
      throw new UserFacingError(
        "DINGTALK_ATTACHMENT_DOWNLOAD_REQUEST_FAILED",
        `附件下载失败：${displayAttachmentName(attachment)}。请稍后重试或查看服务日志。`,
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

      if (!isSuccessfulJsonResponse(response, summary) || token === undefined) {
        this.logger.error("DingTalk access token request failed.", {
          status: response.status,
          statusText: response.statusText,
          dingtalkCode: summary.code,
          dingtalkMessage: summary.message,
          responseBody: summary.bodyPreview,
        });
        throw new AppError("DINGTALK_MEDIA_TOKEN_FAILED", "Failed to obtain DingTalk access token.");
      }

      this.tokenCache = {
        token,
        expiresAtMs: this.now() + expiresInSeconds * 1000 - ACCESS_TOKEN_EXPIRY_SKEW_MS,
      };
      return token;
    } catch (error: unknown) {
      if (error instanceof AppError) {
        throw error;
      }

      this.logger.error("DingTalk access token request failed.", { error });
      throw new AppError("DINGTALK_MEDIA_TOKEN_REQUEST_FAILED", "Failed to request DingTalk access token.", {
        cause: error,
      });
    }
  }
}

/** Creates the app-level resolver that downloads authorized DingTalk attachments. */
export function createDingTalkAttachmentResolver(
  options: DingTalkAttachmentResolverOptions,
): DingTalkAttachmentResolver {
  const logger = options.logger ?? createLogger("dingtalk:attachments");

  return async (message: IncomingMessage): Promise<IncomingMessage> => {
    if (message.attachments === undefined || message.attachments.length === 0) {
      return message;
    }

    const resolvedAttachments: IncomingMessageAttachment[] = [];

    for (const attachment of message.attachments) {
      if (attachment.localPath !== undefined) {
        resolvedAttachments.push(attachment);
        continue;
      }

      const response = await options.mediaClient.downloadMessageFile(attachment);
      const saved = await options.tempFileStore.saveDownloadedAttachment({
        attachment,
        response,
        messageId: message.id,
        senderId: message.senderId,
      });
      resolvedAttachments.push(saved.attachment);
    }

    logger.debug("Resolved DingTalk message attachments.", {
      messageId: message.id,
      senderId: message.senderId,
      attachmentCount: resolvedAttachments.length,
    });

    return {
      ...message,
      attachments: resolvedAttachments,
    };
  };
}

function normalizeDownloadCode(downloadCode: string | undefined): string | undefined {
  const trimmed = downloadCode?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function displayAttachmentName(attachment: IncomingMessageAttachment): string {
  return attachment.filename?.trim() || "附件";
}

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

function isSuccessfulJsonResponse(response: Response, summary: DingTalkResponseSummary): boolean {
  if (response.status < HTTP_OK_MIN || response.status >= HTTP_OK_MAX_EXCLUSIVE) {
    return false;
  }

  if (summary.code === undefined) {
    return true;
  }

  return summary.code === "0";
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

function readResponseCode(value: Record<string, unknown>): string | undefined {
  const code = value.errcode ?? value.code;

  if (typeof code === "string" || typeof code === "number") {
    return String(code);
  }

  return undefined;
}

function readResponseMessage(value: Record<string, unknown>): string | undefined {
  const message = value.errmsg ?? value.message;

  if (typeof message === "string") {
    return truncateResponsePreview(message);
  }

  return undefined;
}

function truncateResponsePreview(value: string): string {
  if (value.length <= MAX_RESPONSE_PREVIEW_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_RESPONSE_PREVIEW_CHARS)}...[truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
