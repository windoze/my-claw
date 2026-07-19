/** Reply contracts used by renderers and DingTalk reply implementations. */

/** Local file selected for direct delivery back to the current chat. */
export interface ReplyFile {
  path: string;
  name: string;
  sizeBytes: number;
}

/** Local image selected for inline delivery back to the current chat. */
export type ReplyImage = ReplyFile;

/** User-visible lifecycle status shown in a streaming card. */
export type ReplyCardStreamStatus = "running" | "done" | "stopped" | "error";

/** Handle returned after a streaming card has been created. */
export interface ReplyCardStreamHandle {
  outTrackId: string;
  cardId?: string;
}

/** Initial card content used before backend text starts streaming. */
export interface ReplyCardStreamStart {
  outTrackId: string;
  title: string;
  content: string;
  status: ReplyCardStreamStatus;
  taskId?: string;
  sessionId?: string;
}

/** Card content update sent as backend events arrive. */
export interface ReplyCardStreamUpdate {
  title: string;
  content: string;
  status: ReplyCardStreamStatus;
  taskId?: string;
  sessionId?: string;
  isFinal: boolean;
  isError: boolean;
}

/** Optional streaming-card capability implemented by DingTalk reply sinks. */
export interface ReplyCardStreamer {
  start(input: ReplyCardStreamStart): Promise<ReplyCardStreamHandle>;
  update(handle: ReplyCardStreamHandle, input: ReplyCardStreamUpdate): Promise<void>;
}

/** Optional metadata supplied by the message router to output renderers. */
export interface OutputRenderContext {
  taskId?: string;
  /**
   * Rewrites local image references (`![alt](path)`) in a Markdown body to DingTalk
   * inline images (`![alt](mediaId)`) before the body is sent. Returns the original
   * text unchanged when there is nothing to inline or the injector is absent.
   */
  inlineImages?(markdown: string): Promise<string>;
  /**
   * Returns true (and clears the flag) when an out-of-band message — a permission
   * prompt, acknowledgement, or other non-card reply — was sent to the chat since
   * the last call. The card renderer uses this to finalize the current AI Card and
   * start a fresh one, so the streaming card stays the last message in the chat.
   */
  consumeCardBreak?(): boolean;
}

/** Destination capable of sending replies back to the current chat. */
export interface ReplySink {
  sendText(text: string): Promise<void>;
  sendMarkdown(markdown: string): Promise<void>;
  sendFile(file: ReplyFile): Promise<void>;
  sendImage(image: ReplyImage): Promise<void>;
  /** Uploads a local image and returns the DingTalk mediaId usable as a Markdown URL. */
  uploadImage?(image: ReplyImage): Promise<string>;
  cardStreamer?: ReplyCardStreamer;
}
