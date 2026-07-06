/** DingTalk robot callback mapping into the gateway's internal message contract. */

import type {
  ConversationType,
  IncomingMessage,
  IncomingMessageAttachment,
  IncomingMessageAttachmentType,
} from "../messages/types.js";
import type {
  DingTalkMessageMappingFailure,
  DingTalkMessageMappingResult,
  DingTalkMessageMappingWarning,
  DingTalkReplyContext,
  DingTalkRobotCallback,
  DingTalkRobotMessagePayload,
} from "./types.js";

interface JsonParseResult {
  payload?: DingTalkRobotMessagePayload;
  error?: string;
}

interface ValueReadResult {
  value?: string;
  source?: string;
}

/** Compact, secret-safe shape for first-batch raw callback debug logging. */
export interface DingTalkCallbackLogSample {
  type?: string;
  specVersion?: string;
  headers: {
    messageId?: string;
    topic?: string;
    contentType?: string;
    eventType?: string;
  };
  data?: {
    keys: string[];
    messageId?: string;
    senderId?: string;
    senderStaffId?: string;
    senderIdSource?: string;
    conversationType?: string;
    normalizedConversationType?: ConversationType;
    msgtype?: string;
    textLength?: number;
    attachmentCount?: number;
    hasAttachmentDownloadCode?: boolean;
    hasSessionWebhook: boolean;
    sessionWebhookExpiredTime?: number;
    hasRobotCode: boolean;
  };
  dataParseError?: string;
}

/** Maps one DingTalk robot callback frame to an IncomingMessage when possible. */
export function mapDingTalkRobotMessage(
  callback: DingTalkRobotCallback,
): DingTalkMessageMappingResult {
  const warnings: DingTalkMessageMappingWarning[] = [];
  const parsed = parsePayload(callback.data);

  if (parsed.payload === undefined) {
    return failure("DINGTALK_MESSAGE_DATA_INVALID", parsed.error ?? "Invalid message data.", {
      callback,
      warnings,
      field: "data",
    });
  }

  const robotMessage = parsed.payload;
  const messageId = readMessageId(callback, robotMessage, warnings);
  const senderId = readSenderId(robotMessage, warnings);
  const text = readText(robotMessage);
  const attachments = readAttachments(robotMessage, warnings);

  if (messageId === undefined) {
    warnings.push({
      code: "DINGTALK_MESSAGE_ID_MISSING",
      message: "DingTalk callback is missing message id; weak dedupe key will be used.",
      field: "msgId",
    });
  }

  if (senderId.value === undefined) {
    return failure("DINGTALK_SENDER_ID_MISSING", "DingTalk callback is missing sender id.", {
      callback,
      warnings,
      field: "senderStaffId",
    });
  }

  const conversationType = normalizeConversationType(robotMessage.conversationType, warnings);
  const replyContext = createReplyContext(callback, robotMessage, messageId, senderId.value);
  const message: IncomingMessage = {
    ...(messageId !== undefined ? { id: messageId } : {}),
    text,
    senderId: senderId.value,
    conversationType,
    ...(attachments.length > 0 ? { attachments } : {}),
    raw: {
      callback,
      message: robotMessage,
    },
    replyContext,
  };

  return {
    ok: true,
    message,
    replyContext,
    robotMessage,
    warnings,
  };
}

/** Builds a redacted debug sample that confirms important raw DingTalk fields. */
export function createDingTalkCallbackLogSample(
  callback: DingTalkRobotCallback,
): DingTalkCallbackLogSample {
  const parsed = parsePayload(callback.data);
  const robotMessage = parsed.payload;

  if (robotMessage === undefined) {
    return {
      type: callback.type,
      specVersion: callback.specVersion,
      headers: createHeaderSample(callback),
      dataParseError: parsed.error,
    };
  }

  const sender = readSenderId(robotMessage, []);
  const normalizedConversationType = normalizeConversationType(robotMessage.conversationType, []);
  const textContent = robotMessage.text?.content;
  const attachments = readAttachments(robotMessage, []);

  return {
    type: callback.type,
    specVersion: callback.specVersion,
    headers: createHeaderSample(callback),
    data: {
      keys: Object.keys(robotMessage).sort(),
      messageId: robotMessage.msgId,
      senderId: robotMessage.senderId,
      senderStaffId: robotMessage.senderStaffId,
      senderIdSource: sender.source,
      conversationType: robotMessage.conversationType,
      normalizedConversationType,
      msgtype: robotMessage.msgtype,
      textLength: typeof textContent === "string" ? textContent.length : undefined,
      attachmentCount: attachments.length,
      hasAttachmentDownloadCode: attachments.some((attachment) =>
        isNonEmptyString(attachment.downloadCode),
      ),
      hasSessionWebhook: isNonEmptyString(robotMessage.sessionWebhook),
      sessionWebhookExpiredTime: robotMessage.sessionWebhookExpiredTime,
      hasRobotCode: isNonEmptyString(robotMessage.robotCode),
    },
  };
}

function parsePayload(data: unknown): JsonParseResult {
  if (isRecord(data)) {
    return { payload: data as DingTalkRobotMessagePayload };
  }

  if (typeof data !== "string") {
    return { error: "DingTalk callback data is not a JSON string." };
  }

  const trimmedData = data.trim();

  if (trimmedData.length === 0) {
    return { error: "DingTalk callback data is empty." };
  }

  try {
    const parsed: unknown = JSON.parse(trimmedData);

    if (!isRecord(parsed)) {
      return { error: "DingTalk callback data JSON is not an object." };
    }

    return { payload: parsed as DingTalkRobotMessagePayload };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `DingTalk callback data is invalid JSON: ${message}` };
  }
}

function readMessageId(
  callback: DingTalkRobotCallback,
  robotMessage: DingTalkRobotMessagePayload,
  warnings: DingTalkMessageMappingWarning[],
): string | undefined {
  if (isNonEmptyString(robotMessage.msgId)) {
    return robotMessage.msgId;
  }

  if (isNonEmptyString(callback.headers.messageId)) {
    warnings.push({
      code: "DINGTALK_MESSAGE_ID_FALLBACK",
      message: "DingTalk robot payload is missing msgId; using callback header messageId.",
      field: "msgId",
    });
    return callback.headers.messageId;
  }

  return undefined;
}

function readSenderId(
  robotMessage: DingTalkRobotMessagePayload,
  warnings: DingTalkMessageMappingWarning[],
): ValueReadResult {
  if (isNonEmptyString(robotMessage.senderStaffId)) {
    return { value: robotMessage.senderStaffId, source: "senderStaffId" };
  }

  if (isNonEmptyString(robotMessage.senderId)) {
    warnings.push({
      code: "DINGTALK_SENDER_ID_FALLBACK",
      message: "DingTalk robot payload is missing senderStaffId; using senderId.",
      field: "senderStaffId",
    });
    return { value: robotMessage.senderId, source: "senderId" };
  }

  return {};
}

function readText(robotMessage: DingTalkRobotMessagePayload): string {
  const text = robotMessage.text?.content;
  return typeof text === "string" ? text : "";
}

function readAttachments(
  robotMessage: DingTalkRobotMessagePayload,
  warnings: DingTalkMessageMappingWarning[],
): IncomingMessageAttachment[] {
  const messageType = normalizeMessageType(robotMessage.msgtype);

  if (messageType === "image" || messageType === "picture") {
    return [readAttachment(robotMessage, "image", ["image", "content"], warnings)];
  }

  if (messageType === "file") {
    return [readAttachment(robotMessage, "file", ["file", "content"], warnings)];
  }

  if (messageType === undefined || messageType === "text") {
    return [];
  }

  warnings.push({
    code: "DINGTALK_MESSAGE_TYPE_UNSUPPORTED",
    message: `DingTalk robot message type is not supported yet: ${messageType}`,
    field: "msgtype",
  });
  return [];
}

function readAttachment(
  robotMessage: DingTalkRobotMessagePayload,
  type: IncomingMessageAttachmentType,
  payloadKeys: readonly string[],
  warnings: DingTalkMessageMappingWarning[],
): IncomingMessageAttachment {
  const payload = readAttachmentPayload(robotMessage, payloadKeys);
  const downloadCode =
    readOptionalString(payload.downloadCode) ??
    readOptionalString(payload.download_code) ??
    readOptionalString(robotMessage.downloadCode);
  const filename =
    readOptionalString(payload.filename) ??
    readOptionalString(payload.fileName) ??
    readOptionalString(payload.name) ??
    readOptionalString(robotMessage.filename) ??
    readOptionalString(robotMessage.fileName);
  const mime =
    readOptionalString(payload.mime) ??
    readOptionalString(payload.mimeType) ??
    readOptionalString(payload.contentType) ??
    readOptionalString(robotMessage.mime) ??
    readOptionalString(robotMessage.mimeType) ??
    readOptionalString(robotMessage.contentType);
  const size =
    readOptionalPositiveNumber(payload.size) ??
    readOptionalPositiveNumber(payload.fileSize) ??
    readOptionalPositiveNumber(payload.sizeBytes) ??
    readOptionalPositiveNumber(robotMessage.size) ??
    readOptionalPositiveNumber(robotMessage.fileSize);

  if (downloadCode === undefined) {
    warnings.push({
      code: "DINGTALK_ATTACHMENT_DOWNLOAD_CODE_MISSING",
      message: "DingTalk attachment message is missing downloadCode.",
      field: `${type}.downloadCode`,
    });
  }

  return {
    type,
    ...(filename !== undefined ? { filename } : {}),
    ...(mime !== undefined ? { mime } : {}),
    ...(downloadCode !== undefined ? { downloadCode } : {}),
    ...(size !== undefined ? { size } : {}),
  };
}

function readAttachmentPayload(
  robotMessage: DingTalkRobotMessagePayload,
  payloadKeys: readonly string[],
): Record<string, unknown> {
  for (const key of payloadKeys) {
    const value = robotMessage[key];

    if (isRecord(value)) {
      return value;
    }
  }

  return robotMessage;
}

function normalizeMessageType(messageType: string | undefined): string | undefined {
  const normalized = messageType?.trim().toLowerCase();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function readOptionalPositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);

    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
}

function normalizeConversationType(
  value: string | undefined,
  warnings: DingTalkMessageMappingWarning[],
): ConversationType {
  const normalizedValue = value?.trim().toLowerCase();

  switch (normalizedValue) {
    case "1":
    case "private":
    case "single":
    case "singlechat":
    case "privatechat":
      return "private";
    case "2":
    case "group":
    case "groupchat":
    case "conversation":
      return "group";
    default:
      warnings.push({
        code: "DINGTALK_CONVERSATION_TYPE_UNKNOWN",
        message: "DingTalk callback conversation type is missing or unknown.",
        field: "conversationType",
      });
      return "unknown";
  }
}

function createReplyContext(
  callback: DingTalkRobotCallback,
  robotMessage: DingTalkRobotMessagePayload,
  messageId: string | undefined,
  senderId: string,
): DingTalkReplyContext {
  return {
    ...(messageId !== undefined ? { messageId } : {}),
    callbackMessageId: callback.headers.messageId,
    conversationId: readOptionalString(robotMessage.conversationId),
    senderId,
    sessionWebhook: readOptionalString(robotMessage.sessionWebhook),
    sessionWebhookExpiredTime:
      typeof robotMessage.sessionWebhookExpiredTime === "number"
        ? robotMessage.sessionWebhookExpiredTime
        : undefined,
    robotCode: readOptionalString(robotMessage.robotCode),
    rawCallback: callback,
    rawMessage: robotMessage,
  };
}

function createHeaderSample(callback: DingTalkRobotCallback): DingTalkCallbackLogSample["headers"] {
  return {
    messageId: callback.headers.messageId,
    topic: callback.headers.topic,
    contentType: callback.headers.contentType,
    eventType: callback.headers.eventType,
  };
}

function failure(
  code: string,
  message: string,
  options: {
    callback: DingTalkRobotCallback;
    warnings: DingTalkMessageMappingWarning[];
    field?: string;
  },
): DingTalkMessageMappingFailure {
  return {
    ok: false,
    reason: {
      code,
      message,
      field: options.field,
    },
    warnings: options.warnings,
    callbackMessageId: options.callback.headers.messageId,
  };
}

function readOptionalString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
