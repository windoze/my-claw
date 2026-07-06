/** DingTalk AI Card creation and streaming update client. */

import type { DingTalkConfig, StreamingConfig } from "../../config/types.js";
import type {
  ReplyCardStreamHandle,
  ReplyCardStreamer,
  ReplyCardStreamStart,
  ReplyCardStreamUpdate,
} from "../../output/types.js";
import { AppError } from "../../utils/errors.js";
import { createLogger, type Logger } from "../../utils/logger.js";
import type { DingTalkReplyContext } from "../types.js";

type DingTalkFetch = typeof fetch;

/** Options used to create a DingTalkCardClient. */
export interface DingTalkCardClientOptions {
  dingtalkConfig: DingTalkConfig;
  streamingConfig: StreamingConfig;
  logger?: Logger;
  fetch?: DingTalkFetch;
  now?: () => number;
}

/** Options used for one callback-scoped card stream. */
export interface DingTalkCardStreamerOptions {
  context: DingTalkReplyContext;
  client: DingTalkCardClient;
}

interface DingTalkAccessTokenCache {
  token: string;
  expiresAtMs: number;
}

interface DingTalkResponseSummary {
  success?: boolean;
  result?: unknown;
  code?: string;
  message?: string;
  bodyPreview?: string;
}

interface CreateCardInput {
  outTrackId: string;
  receiverUserId: string;
  title: string;
  content: string;
  status: ReplyCardStreamStart["status"];
  taskId?: string;
  sessionId?: string;
}

interface UpdateCardInput {
  outTrackId: string;
  content: string;
  isFinalize: boolean;
  isError: boolean;
}

const ACCESS_TOKEN_URL = "https://oapi.dingtalk.com/gettoken";
const ROBOT_INTERACTIVE_CARD_SEND_URL =
  "https://api.dingtalk.com/v1.0/im/v1.0/robot/interactiveCards/send";
const AI_CARD_STREAMING_UPDATE_URL = "https://api.dingtalk.com/v1.0/card/streaming";
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX_EXCLUSIVE = 300;
const MAX_RESPONSE_PREVIEW_CHARS = 500;

/** Minimal OpenAPI client for creating and updating DingTalk AI Card streams. */
export class DingTalkCardClient {
  private readonly dingtalkConfig: DingTalkConfig;
  private readonly streamingConfig: StreamingConfig;
  private readonly logger: Logger;
  private readonly fetch: DingTalkFetch;
  private readonly now: () => number;
  private tokenCache: DingTalkAccessTokenCache | null = null;

  public constructor(options: DingTalkCardClientOptions) {
    this.dingtalkConfig = options.dingtalkConfig;
    this.streamingConfig = options.streamingConfig;
    this.logger = options.logger ?? createLogger("dingtalk:cards");
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Creates and sends the initial private-chat card instance. */
  public async createCard(input: CreateCardInput): Promise<ReplyCardStreamHandle> {
    const robotCode = this.requireRobotCode();
    const templateId = this.requireTemplateId();
    const accessToken = await this.getAccessToken();
    const response = await this.fetch(ROBOT_INTERACTIVE_CARD_SEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify({
        cardTemplateId: templateId,
        singleChatReceiver: JSON.stringify({ userId: input.receiverUserId }),
        cardBizId: input.outTrackId,
        robotCode,
        cardData: JSON.stringify({
          cardParamMap: createCardParamMap(input, this.streamingConfig.contentKey),
        }),
      }),
    });
    const responseText = await response.text();
    const summary = summarizeDingTalkResponse(responseText);

    if (!isSuccessfulOpenApiResponse(response, summary)) {
      this.logger.error("DingTalk AI Card creation failed.", {
        status: response.status,
        statusText: response.statusText,
        dingtalkCode: summary.code,
        dingtalkMessage: summary.message,
        responseBody: summary.bodyPreview,
        outTrackId: input.outTrackId,
      });
      throw new AppError("DINGTALK_CARD_CREATE_FAILED", "Failed to create DingTalk AI Card.");
    }

    const cardId = readProcessQueryKey(responseText) ?? input.outTrackId;
    this.logger.info("DingTalk AI Card created.", {
      cardId,
      outTrackId: input.outTrackId,
      taskId: input.taskId,
      sessionId: input.sessionId,
    });

    return { outTrackId: input.outTrackId, cardId };
  }

  /** Updates the AI Card streaming content variable. */
  public async updateStreamingContent(input: UpdateCardInput): Promise<void> {
    const accessToken = await this.getAccessToken();
    const response = await this.fetch(AI_CARD_STREAMING_UPDATE_URL, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify({
        outTrackId: input.outTrackId,
        guid: createGuid(input.outTrackId),
        key: this.streamingConfig.contentKey,
        content: input.content,
        isFull: true,
        isFinalize: input.isFinalize,
        isError: input.isError,
      }),
    });
    const responseText = await response.text();
    const summary = summarizeDingTalkResponse(responseText);

    if (!isSuccessfulOpenApiResponse(response, summary)) {
      this.logger.error("DingTalk AI Card streaming update failed.", {
        status: response.status,
        statusText: response.statusText,
        dingtalkCode: summary.code,
        dingtalkMessage: summary.message,
        responseBody: summary.bodyPreview,
        outTrackId: input.outTrackId,
        isFinalize: input.isFinalize,
        isError: input.isError,
      });
      throw new AppError("DINGTALK_CARD_UPDATE_FAILED", "Failed to update DingTalk AI Card.");
    }
  }

  private requireRobotCode(): string {
    const robotCode = this.dingtalkConfig.robotCode?.trim();

    if (robotCode === undefined || robotCode.length === 0) {
      throw new AppError(
        "DINGTALK_CARD_ROBOT_CODE_MISSING",
        "dingtalk.robotCode is required for AI Card streaming.",
      );
    }

    return robotCode;
  }

  private requireTemplateId(): string {
    const templateId = this.streamingConfig.templateId?.trim();

    if (templateId === undefined || templateId.length === 0) {
      throw new AppError(
        "DINGTALK_CARD_TEMPLATE_MISSING",
        "streaming.templateId is required for AI Card streaming.",
      );
    }

    return templateId;
  }

  private async getAccessToken(): Promise<string> {
    const cachedToken = this.tokenCache;

    if (cachedToken !== null && cachedToken.expiresAtMs > this.now()) {
      return cachedToken.token;
    }

    const tokenUrl = new URL(ACCESS_TOKEN_URL);
    tokenUrl.searchParams.set("appkey", this.dingtalkConfig.clientId);
    tokenUrl.searchParams.set("appsecret", this.dingtalkConfig.clientSecret);

    try {
      const response = await this.fetch(tokenUrl);
      const responseText = await response.text();
      const summary = summarizeDingTalkResponse(responseText);
      const token = readAccessToken(responseText);
      const expiresInSeconds = readAccessTokenExpiresIn(responseText);

      if (!isSuccessfulOpenApiResponse(response, summary) || token === undefined) {
        this.logger.error("DingTalk access token request failed.", {
          status: response.status,
          statusText: response.statusText,
          dingtalkCode: summary.code,
          dingtalkMessage: summary.message,
          responseBody: summary.bodyPreview,
        });
        throw new AppError("DINGTALK_CARD_TOKEN_FAILED", "Failed to obtain DingTalk access token.");
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
      throw new AppError("DINGTALK_CARD_TOKEN_REQUEST_FAILED", "Failed to request DingTalk access token.", {
        cause: error,
      });
    }
  }
}

/** Callback-scoped adapter exposing card streaming through ReplySink.cardStreamer. */
export class DingTalkCardStreamer implements ReplyCardStreamer {
  private readonly context: DingTalkReplyContext;
  private readonly client: DingTalkCardClient;

  public constructor(options: DingTalkCardStreamerOptions) {
    this.context = options.context;
    this.client = options.client;
  }

  /** Sends the initial AI Card to the callback sender's private chat. */
  public async start(input: ReplyCardStreamStart): Promise<ReplyCardStreamHandle> {
    return this.client.createCard({
      outTrackId: input.outTrackId,
      receiverUserId: this.context.senderId,
      title: input.title,
      content: input.content,
      status: input.status,
      taskId: input.taskId,
      sessionId: input.sessionId,
    });
  }

  /** Pushes the latest full Markdown content into the AI Card streaming variable. */
  public async update(
    handle: ReplyCardStreamHandle,
    input: ReplyCardStreamUpdate,
  ): Promise<void> {
    await this.client.updateStreamingContent({
      outTrackId: handle.outTrackId,
      content: input.content,
      isFinalize: input.isFinal,
      isError: input.isError,
    });
  }
}

function createCardParamMap(
  input: CreateCardInput,
  contentKey: string,
): Record<string, string> {
  return {
    title: input.title,
    [contentKey]: input.content,
    status: input.status,
    taskId: input.taskId ?? "",
    sessionId: input.sessionId ?? "",
  };
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
      success: readBoolean(parsed.success),
      result: parsed.result,
      code: readResponseCode(parsed),
      message: readResponseMessage(parsed),
      bodyPreview,
    };
  } catch {
    return { bodyPreview };
  }
}

function isSuccessfulOpenApiResponse(response: Response, summary: DingTalkResponseSummary): boolean {
  if (response.status < HTTP_OK_MIN || response.status >= HTTP_OK_MAX_EXCLUSIVE) {
    return false;
  }

  if (summary.success === false) {
    return false;
  }

  if (summary.result === false) {
    return false;
  }

  if (summary.code === undefined) {
    return true;
  }

  return summary.code === "0" || summary.code.toLowerCase() === "ok";
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

function readProcessQueryKey(responseText: string): string | undefined {
  const parsed = parseResponseRecord(responseText);
  const processQueryKey = parsed?.processQueryKey;

  if (typeof processQueryKey === "string" && processQueryKey.length > 0) {
    return processQueryKey;
  }

  return undefined;
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

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function createGuid(outTrackId: string): string {
  return `${outTrackId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
