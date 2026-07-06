/** Internal message contracts shared by DingTalk adapters and command routing. */

/** Conversation categories normalized from DingTalk callback payloads. */
export type ConversationType = "private" | "group" | "unknown";

/** Attachment categories the gateway can pass to Agent backends. */
export type IncomingMessageAttachmentType = "file" | "image";

/** Normalized attachment metadata, optionally materialized to a local temp path. */
export interface IncomingMessageAttachment {
  type: IncomingMessageAttachmentType;
  filename?: string;
  mime?: string;
  downloadCode?: string;
  localPath?: string;
  size?: number;
}

/** Normalized inbound message used by security, commands, and Agent routing. */
export interface IncomingMessage {
  id?: string;
  text: string;
  senderId: string;
  conversationType: ConversationType;
  attachments?: IncomingMessageAttachment[];
  raw?: unknown;
  replyContext?: unknown;
}
