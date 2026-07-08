/** DingTalk Stream Mode adapter contracts and normalized callback metadata. */

import type { DWClientDownStream } from "dingtalk-stream-sdk-nodejs";

import type { DingTalkConfig, StreamingConfig } from "../config/types.js";
import type { ConversationType, IncomingMessage } from "../messages/types.js";
import type { ReplySink } from "../output/types.js";
import type { Logger } from "../utils/logger.js";
import type { MessageDeduper } from "./MessageDeduper.js";

/** Raw downstream callback frame received from the DingTalk Stream SDK. */
export type DingTalkRobotCallback = DWClientDownStream;

/** Minimal client surface used by the adapter and exposed for tests. */
export interface DingTalkStreamClient {
  registerCallbackListener(
    topic: string,
    callback: (callback: DingTalkRobotCallback) => void,
  ): DingTalkStreamClient;
  connect(): Promise<void>;
  disconnect(): void;
  getConfig?(): Partial<DingTalkStreamClientOptions>;
  on?(eventName: string | symbol, listener: (...args: unknown[]) => void): unknown;
  off?(eventName: string | symbol, listener: (...args: unknown[]) => void): unknown;
  removeListener?(eventName: string | symbol, listener: (...args: unknown[]) => void): unknown;
}

/** Constructor options accepted by the official Stream SDK client. */
export interface DingTalkStreamClientOptions {
  clientId: string;
  clientSecret: string;
  keepAlive?: boolean;
  ua?: string;
  autoReconnect?: boolean;
}

/** Factory used to create a real or fake DingTalk Stream client. */
export type DingTalkStreamClientFactory = (
  options: DingTalkStreamClientOptions,
) => DingTalkStreamClient;

/** Handler invoked after a raw callback is mapped to the internal message contract. */
export type DingTalkIncomingMessageHandler = (
  message: IncomingMessage,
  replySink: ReplySink,
) => Promise<unknown> | unknown;

/** Creates the reply sink for the current callback. */
export type DingTalkReplySinkFactory = (context: DingTalkReplyContext) => ReplySink;

/** Parsed DingTalk robot message payload with SDK-version-tolerant extra fields. */
export interface DingTalkRobotMessagePayload {
  content?: unknown;
  conversationId?: string;
  conversationType?: string;
  file?: unknown;
  image?: unknown;
  msgId?: string;
  msgtype?: string;
  robotCode?: string;
  senderId?: string;
  senderStaffId?: string;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  text?: {
    content?: string;
  };
  [key: string]: unknown;
}

/** Reply metadata preserved for later DingTalk reply-sink implementation. */
export interface DingTalkReplyContext {
  messageId?: string;
  callbackMessageId?: string;
  conversationId?: string;
  conversationType: ConversationType;
  senderId: string;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  robotCode?: string;
  rawCallback: DingTalkRobotCallback;
  rawMessage: DingTalkRobotMessagePayload;
}

/** Warning emitted when the mapper can continue with a safe fallback. */
export interface DingTalkMessageMappingWarning {
  code: string;
  message: string;
  field?: string;
}

/** Successful callback mapping result. */
export interface DingTalkMessageMappingSuccess {
  ok: true;
  message: IncomingMessage;
  replyContext: DingTalkReplyContext;
  robotMessage: DingTalkRobotMessagePayload;
  warnings: DingTalkMessageMappingWarning[];
}

/** Failed callback mapping result; callers should log and ignore the callback. */
export interface DingTalkMessageMappingFailure {
  ok: false;
  reason: DingTalkMessageMappingWarning;
  warnings: DingTalkMessageMappingWarning[];
  callbackMessageId?: string;
}

/** Result of converting a raw DingTalk callback into an internal message. */
export type DingTalkMessageMappingResult =
  | DingTalkMessageMappingSuccess
  | DingTalkMessageMappingFailure;

/** Runtime configuration needed by DingTalkAdapter. */
export interface DingTalkAdapterOptions {
  config: DingTalkConfig;
  streaming?: StreamingConfig;
  handler: DingTalkIncomingMessageHandler;
  createReplySink?: DingTalkReplySinkFactory;
  clientFactory?: DingTalkStreamClientFactory;
  deduper?: MessageDeduper;
  logger?: Logger;
  topic?: string;
  keepAlive?: boolean;
  autoReconnect?: boolean;
  ua?: string;
}
