/** Reply contracts used by renderers and DingTalk reply implementations. */

/** Destination capable of sending text or Markdown back to the current chat. */
export interface ReplySink {
  sendText(text: string): Promise<void>;
  sendMarkdown(markdown: string): Promise<void>;
}
