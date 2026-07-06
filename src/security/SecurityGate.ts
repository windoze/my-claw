/** Authorization gate for DingTalk messages before commands or backends run. */

import type { DingTalkConfig } from "../config/types.js";
import type { IncomingMessage } from "../messages/types.js";
import { createLogger, type Logger } from "../utils/index.js";

export const UNSUPPORTED_MESSAGE_TYPE_REPLY = "暂不支持该消息类型";

/** Machine-readable reason for rejecting or ignoring a message before routing. */
export type SecurityGateDecisionCode =
  | "DINGTALK_CONVERSATION_NOT_PRIVATE"
  | "DINGTALK_SENDER_NOT_ALLOWED"
  | "DINGTALK_TEXT_EMPTY";

/** Authorization result returned by SecurityGate. */
export type SecurityGateDecision =
  | {
      allowed: true;
    }
  | {
      allowed: false;
      code: SecurityGateDecisionCode;
      reason: string;
      replyText?: string;
    };

/** Runtime options for DingTalk message authorization. */
export interface SecurityGateOptions {
  config: DingTalkConfig;
  logger?: Logger;
}

/** Ensures only configured DingTalk users in private chats can reach routing logic. */
export class SecurityGate {
  private readonly config: DingTalkConfig;
  private readonly allowedUserIds: ReadonlySet<string>;
  private readonly logger: Logger;

  public constructor(options: SecurityGateOptions) {
    this.config = options.config;
    this.allowedUserIds = new Set(options.config.allowedUserIds);
    this.logger = options.logger ?? createLogger("security");
  }

  /** Checks one normalized message before CommandRouter or backend execution. */
  public authorize(message: IncomingMessage): SecurityGateDecision {
    if (message.conversationType !== "private") {
      return this.reject(message, {
        code: "DINGTALK_CONVERSATION_NOT_PRIVATE",
        reason: this.describeConversationRejection(message),
      });
    }

    if (!this.allowedUserIds.has(message.senderId)) {
      return this.reject(message, {
        code: "DINGTALK_SENDER_NOT_ALLOWED",
        reason: "DingTalk sender is not in the allowed user list.",
      });
    }

    if (message.text.trim().length === 0 && (message.attachments?.length ?? 0) === 0) {
      this.logger.warn("Ignored empty DingTalk text message from authorized sender.", {
        messageId: message.id,
        senderId: message.senderId,
        conversationType: message.conversationType,
      });
      return {
        allowed: false,
        code: "DINGTALK_TEXT_EMPTY",
        reason: "DingTalk message text is empty.",
        replyText: UNSUPPORTED_MESSAGE_TYPE_REPLY,
      };
    }

    return { allowed: true };
  }

  private describeConversationRejection(message: IncomingMessage): string {
    if (message.conversationType === "group" && this.config.rejectGroupMessages) {
      return "DingTalk group message rejected because only private chats are allowed.";
    }

    if (message.conversationType === "group") {
      return "DingTalk group message ignored because only private chats are allowed.";
    }

    return "DingTalk conversation type is not private.";
  }

  private reject(
    message: IncomingMessage,
    decision: Omit<Extract<SecurityGateDecision, { allowed: false }>, "allowed">,
  ): SecurityGateDecision {
    this.logger.warn("Rejected DingTalk message before routing.", {
      code: decision.code,
      reason: decision.reason,
      messageId: message.id,
      senderId: message.senderId,
      conversationType: message.conversationType,
      rejectGroupMessages: this.config.rejectGroupMessages,
    });

    return {
      allowed: false,
      ...decision,
    };
  }
}
