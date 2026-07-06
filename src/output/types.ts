/** Reply contracts used by renderers and DingTalk reply implementations. */

/** Local file selected for direct delivery back to the current chat. */
export interface ReplyFile {
  path: string;
  name: string;
  sizeBytes: number;
}

/** Destination capable of sending text or Markdown back to the current chat. */
export interface ReplySink {
  sendText(text: string): Promise<void>;
  sendMarkdown(markdown: string): Promise<void>;
  sendFile(file: ReplyFile): Promise<void>;
}
