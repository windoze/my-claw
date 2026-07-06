/** Internal message contracts shared by DingTalk adapters and command routing. */

/** Conversation categories normalized from DingTalk callback payloads. */
export type ConversationType = "private" | "group" | "unknown";

/** Normalized inbound message used by security, commands, and Agent routing. */
export interface IncomingMessage {
  id?: string;
  text: string;
  senderId: string;
  conversationType: ConversationType;
  raw?: unknown;
  replyContext?: unknown;
}
