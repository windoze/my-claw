/** DingTalk AI Card creation and streaming update client. */

import { randomUUID } from "node:crypto";

import type { DingTalkConfig, StreamingConfig } from "../../config/types.js";
import type { ConversationType } from "../../messages/types.js";
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
  content: string;
  conversationId?: string;
  conversationType: ConversationType;
  receiverUserId: string;
}

interface UpdateCardInput {
  outTrackId: string;
  content: string;
  isFinalize: boolean;
  isError: boolean;
}

interface CardOpenSpace {
  openSpaceId: string;
  spaceType: typeof PRIVATE_OPEN_SPACE_TYPE | typeof GROUP_OPEN_SPACE_TYPE;
}

const ACCESS_TOKEN_URL = "https://oapi.dingtalk.com/gettoken";
const AI_CARD_CREATE_AND_DELIVER_URL =
  "https://api.dingtalk.com/v1.0/card/instances/createAndDeliver";
const AI_CARD_INSTANCE_UPDATE_URL = "https://api.dingtalk.com/v1.0/card/instances";
const AI_CARD_STREAMING_UPDATE_URL = "https://api.dingtalk.com/v1.0/card/streaming";
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX_EXCLUSIVE = 300;
const MAX_RESPONSE_PREVIEW_CHARS = 500;
const CARD_CALLBACK_TYPE_STREAM = "STREAM";
const OPEN_SPACE_PREFIX = "dtv1.card//";
const PRIVATE_OPEN_SPACE_TYPE = "IM_ROBOT";
const GROUP_OPEN_SPACE_TYPE = "IM_GROUP";

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

  /** Creates and delivers a DingTalk AI Card instance to the current chat. */
  public async createCard(input: CreateCardInput): Promise<ReplyCardStreamHandle> {
    const robotCode = this.requireRobotCode();
    const templateId = this.requireTemplateId();
    const cardParamMap = createCardParamMap(input.content, this.streamingConfig.contentKey);
    const openSpace = createOpenSpace({
      conversationId: input.conversationId,
      conversationType: input.conversationType,
      receiverUserId: input.receiverUserId,
    });

    this.logger.debug("DingTalk AI Card create payload prepared.", {
      outTrackId: input.outTrackId,
      outTrackIdLength: input.outTrackId.length,
      openSpaceId: openSpace.openSpaceId,
      openSpaceType: openSpace.spaceType,
      cardParamKeys: Object.keys(cardParamMap),
    });

    const createResponseText = await this.requestCardApi(
      "create-and-deliver",
      AI_CARD_CREATE_AND_DELIVER_URL,
      {
        cardTemplateId: templateId,
        outTrackId: input.outTrackId,
        cardData: { cardParamMap, config: { autoLayout: true } },
        callbackType: CARD_CALLBACK_TYPE_STREAM,
        openSpaceId: openSpace.openSpaceId,
        userIdType: 1,
        ...createOpenSpaceModel(openSpace.spaceType),
        ...createDeliverModel(openSpace.spaceType, robotCode),
      },
      {
        outTrackId: input.outTrackId,
        outTrackIdLength: input.outTrackId.length,
        openSpaceId: openSpace.openSpaceId,
        openSpaceType: openSpace.spaceType,
        cardParamKeys: Object.keys(cardParamMap),
      },
    );

    const cardId = readCardInstanceId(createResponseText) ?? input.outTrackId;
    this.logger.info("DingTalk AI Card created.", {
      cardId,
      outTrackId: input.outTrackId,
      openSpaceId: openSpace.openSpaceId,
      openSpaceType: openSpace.spaceType,
    });

    return { outTrackId: input.outTrackId, cardId };
  }

  /** Updates the AI Card streaming content variable. */
  public async updateStreamingContent(input: UpdateCardInput): Promise<void> {
    const accessToken = await this.getAccessToken();
    const guid = createGuid();
    const contentKey = this.streamingConfig.contentKey;
    const response = await this.fetch(AI_CARD_STREAMING_UPDATE_URL, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify({
        outTrackId: input.outTrackId,
        guid,
        key: contentKey,
        content: input.content,
        isFull: true,
        isFinalize: input.isFinalize,
        isError: input.isError,
      }),
    });
    const responseText = await response.text();
    const summary = summarizeDingTalkResponse(responseText);

    if (!isSuccessfulOpenApiResponse(response, summary)) {
      const logContext = {
        outTrackId: input.outTrackId,
        key: contentKey,
        guid,
        contentLength: input.content.length,
        isFinalize: input.isFinalize,
        isError: input.isError,
      };

      this.logger.warn("DingTalk AI Card streaming update failed; trying card data update fallback.", {
        status: response.status,
        statusText: response.statusText,
        dingtalkCode: summary.code,
        dingtalkMessage: summary.message,
        responseBody: summary.bodyPreview,
        ...logContext,
      });

      if (await this.tryUpdateCardContentVariable(input, contentKey, logContext)) {
        return;
      }

      this.logger.error("DingTalk AI Card streaming update failed.", {
        status: response.status,
        statusText: response.statusText,
        dingtalkCode: summary.code,
        dingtalkMessage: summary.message,
        responseBody: summary.bodyPreview,
        ...logContext,
      });
      throw new AppError("DINGTALK_CARD_UPDATE_FAILED", "Failed to update DingTalk AI Card.");
    }
  }

  private async tryUpdateCardContentVariable(
    input: UpdateCardInput,
    contentKey: string,
    logContext: Record<string, unknown>,
  ): Promise<boolean> {
    const accessToken = await this.getAccessToken();
    const response = await this.fetch(AI_CARD_INSTANCE_UPDATE_URL, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify({
        outTrackId: input.outTrackId,
        cardData: {
          cardParamMap: {
            [contentKey]: input.content,
          },
        },
        cardUpdateOptions: {
          updateCardDataByKey: true,
          updatePrivateDataByKey: true,
        },
      }),
    });
    const responseText = await response.text();
    const summary = summarizeDingTalkResponse(responseText);

    if (!isSuccessfulOpenApiResponse(response, summary)) {
      this.logger.warn("DingTalk AI Card card-data update fallback failed.", {
        status: response.status,
        statusText: response.statusText,
        dingtalkCode: summary.code,
        dingtalkMessage: summary.message,
        responseBody: summary.bodyPreview,
        ...logContext,
      });
      return false;
    }

    this.logger.info("DingTalk AI Card updated through card-data fallback.", logContext);
    return true;
  }

  private async requestCardApi(
    operation: string,
    url: string,
    body: Record<string, unknown>,
    logContext: Record<string, unknown>,
  ): Promise<string> {
    const accessToken = await this.getAccessToken();
    const response = await this.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    const summary = summarizeDingTalkResponse(responseText);

    if (!isSuccessfulOpenApiResponse(response, summary)) {
      this.logger.error("DingTalk AI Card API request failed.", {
        operation,
        status: response.status,
        statusText: response.statusText,
        dingtalkCode: summary.code,
        dingtalkMessage: summary.message,
        responseBody: summary.bodyPreview,
        ...logContext,
      });
      throw new AppError(
        "DINGTALK_CARD_CREATE_FAILED",
        `Failed to ${operation} DingTalk AI Card.`,
      );
    }

    this.logger.debug("DingTalk AI Card API request succeeded.", {
      operation,
      ...logContext,
    });
    return responseText;
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

  /** Creates and delivers the initial AI Card to the callback conversation. */
  public async start(input: ReplyCardStreamStart): Promise<ReplyCardStreamHandle> {
    return this.client.createCard({
      outTrackId: input.outTrackId,
      content: input.content,
      conversationId: this.context.conversationId,
      conversationType: this.context.conversationType,
      receiverUserId: this.context.senderId,
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

function createCardParamMap(content: string, contentKey: string): Record<string, string> {
  return { [contentKey]: content };
}

function createOpenSpace(input: {
  conversationId: string | undefined;
  conversationType: ConversationType;
  receiverUserId: string;
}): CardOpenSpace {
  switch (input.conversationType) {
    case "private":
      return {
        openSpaceId: `${OPEN_SPACE_PREFIX}${PRIVATE_OPEN_SPACE_TYPE}.${normalizeRequiredOpenSpacePart(
          input.receiverUserId,
          "DINGTALK_CARD_RECEIVER_MISSING",
          "DingTalk receiver userId is required for private AI Card delivery.",
        )}`,
        spaceType: PRIVATE_OPEN_SPACE_TYPE,
      };
    case "group":
      return {
        openSpaceId: `${OPEN_SPACE_PREFIX}${GROUP_OPEN_SPACE_TYPE}.${normalizeRequiredOpenSpacePart(
          input.conversationId,
          "DINGTALK_CARD_CONVERSATION_MISSING",
          "DingTalk conversationId is required for group AI Card delivery.",
        )}`,
        spaceType: GROUP_OPEN_SPACE_TYPE,
      };
    case "unknown":
      throw new AppError(
        "DINGTALK_CARD_CONVERSATION_TYPE_UNSUPPORTED",
        "DingTalk conversationType is required for AI Card delivery.",
      );
  }
}

function normalizeRequiredOpenSpacePart(
  value: string | undefined,
  code: string,
  message: string,
): string {
  const normalizedValue = value?.trim();

  if (normalizedValue === undefined || normalizedValue.length === 0) {
    throw new AppError(code, message);
  }

  return normalizedValue;
}

function createOpenSpaceModel(spaceType: CardOpenSpace["spaceType"]): Record<string, unknown> {
  if (spaceType === PRIVATE_OPEN_SPACE_TYPE) {
    return {
      imRobotOpenSpaceModel: {
        supportForward: false,
      },
    };
  }

  return {
    imGroupOpenSpaceModel: {
      supportForward: false,
      lastMessageI18n: {
        zh_CN: "Agent 回复",
        en_US: "Agent reply",
      },
    },
  };
}

function createDeliverModel(
  spaceType: CardOpenSpace["spaceType"],
  robotCode: string,
): Record<string, unknown> {
  if (spaceType === PRIVATE_OPEN_SPACE_TYPE) {
    return {
      imRobotOpenDeliverModel: {
        robotCode,
        spaceType: PRIVATE_OPEN_SPACE_TYPE,
      },
    };
  }

  return {
    imGroupOpenDeliverModel: {
      robotCode,
    },
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

  if (hasFailedDeliverResult(summary.result)) {
    return false;
  }

  if (summary.code === undefined) {
    return true;
  }

  return summary.code === "0" || summary.code.toLowerCase() === "ok";
}

function hasFailedDeliverResult(result: unknown): boolean {
  if (!isRecord(result) || !Array.isArray(result.deliverResults)) {
    return false;
  }

  return result.deliverResults.some((item) => isRecord(item) && item.success === false);
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

function readCardInstanceId(responseText: string): string | undefined {
  const parsed = parseResponseRecord(responseText);
  const result = isRecord(parsed?.result) ? parsed.result : undefined;
  const cardId =
    readNonEmptyString(parsed?.cardInstanceId) ??
    readNonEmptyString(result?.cardInstanceId) ??
    readNonEmptyString(parsed?.cardId) ??
    readNonEmptyString(result?.cardId) ??
    readNonEmptyString(parsed?.processQueryKey) ??
    readNonEmptyString(result?.processQueryKey);

  return cardId;
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

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function createGuid(): string {
  return randomUUID();
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
