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
}

/** Destination capable of sending replies back to the current chat. */
export interface ReplySink {
  sendText(text: string): Promise<void>;
  sendMarkdown(markdown: string): Promise<void>;
  sendFile(file: ReplyFile): Promise<void>;
  sendImage(image: ReplyImage): Promise<void>;
  cardStreamer?: ReplyCardStreamer;
}
