/** In-memory reply sink for local routing and command integration checks. */

import type {
  ReplyCardStreamHandle,
  ReplyCardStreamer,
  ReplyCardStreamStart,
  ReplyCardStreamUpdate,
  ReplyFile,
  ReplyImage,
  ReplySink,
} from "../output/types.js";

/** Options that let focused checks simulate DingTalk card failures. */
export interface FakeReplySinkOptions {
  failCardStart?: unknown;
  failCardUpdateAt?: number;
}

/** Recorded reply call made by code under test. */
export type FakeReplyCall =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "markdown";
      markdown: string;
    }
  | {
      type: "file";
      file: ReplyFile;
    }
  | {
      type: "image";
      image: ReplyImage;
    }
  | {
      type: "card_start";
      input: ReplyCardStreamStart;
      handle: ReplyCardStreamHandle;
    }
  | {
      type: "card_update";
      handle: ReplyCardStreamHandle;
      input: ReplyCardStreamUpdate;
    };

/** Reply sink that records all text and Markdown sends in call order. */
export class FakeReplySink implements ReplySink {
  public readonly calls: FakeReplyCall[] = [];
  public readonly textReplies: string[] = [];
  public readonly markdownReplies: string[] = [];
  public readonly fileReplies: ReplyFile[] = [];
  public readonly imageReplies: ReplyImage[] = [];
  public readonly cardStarts: ReplyCardStreamStart[] = [];
  public readonly cardUpdates: ReplyCardStreamUpdate[] = [];
  public readonly cardStreamer: ReplyCardStreamer;

  private readonly failCardStart: unknown;
  private readonly failCardUpdateAt: number | undefined;
  private cardUpdateCount = 0;

  public constructor(options: FakeReplySinkOptions = {}) {
    this.failCardStart = options.failCardStart;
    this.failCardUpdateAt = options.failCardUpdateAt;
    this.cardStreamer = {
      start: (input) => this.startCardStream(input),
      update: (handle, input) => this.updateCardStream(handle, input),
    };
  }

  /** Stores a text reply without sending it to DingTalk. */
  public async sendText(text: string): Promise<void> {
    this.textReplies.push(text);
    this.calls.push({ type: "text", text });
  }

  /** Stores a Markdown reply without sending it to DingTalk. */
  public async sendMarkdown(markdown: string): Promise<void> {
    this.markdownReplies.push(markdown);
    this.calls.push({ type: "markdown", markdown });
  }

  /** Stores a file reply without sending it to DingTalk. */
  public async sendFile(file: ReplyFile): Promise<void> {
    this.fileReplies.push(file);
    this.calls.push({ type: "file", file });
  }

  /** Stores an image reply without sending it to DingTalk. */
  public async sendImage(image: ReplyImage): Promise<void> {
    this.imageReplies.push(image);
    this.calls.push({ type: "image", image });
  }

  /** Returns a deterministic fake mediaId without uploading to DingTalk. */
  public async uploadImage(image: ReplyImage): Promise<string> {
    return `fake-media:${image.name}`;
  }

  /** Stores a fake card start and returns a deterministic card handle. */
  public async startCardStream(input: ReplyCardStreamStart): Promise<ReplyCardStreamHandle> {
    if (this.failCardStart !== undefined) {
      throw this.failCardStart;
    }

    const handle: ReplyCardStreamHandle = {
      outTrackId: input.outTrackId,
      cardId: `fake-card:${input.outTrackId}`,
    };
    this.cardStarts.push(input);
    this.calls.push({ type: "card_start", input, handle });
    return handle;
  }

  /** Stores a fake card update unless the configured failure index is reached. */
  public async updateCardStream(
    handle: ReplyCardStreamHandle,
    input: ReplyCardStreamUpdate,
  ): Promise<void> {
    this.cardUpdateCount += 1;

    if (this.failCardUpdateAt === this.cardUpdateCount) {
      throw new Error(`Fake card update ${this.cardUpdateCount} failed.`);
    }

    this.cardUpdates.push(input);
    this.calls.push({ type: "card_update", handle, input });
  }

  /** Clears all recorded calls so the same sink can be reused across scenarios. */
  public clear(): void {
    this.calls.length = 0;
    this.textReplies.length = 0;
    this.markdownReplies.length = 0;
    this.fileReplies.length = 0;
    this.imageReplies.length = 0;
    this.cardStarts.length = 0;
    this.cardUpdates.length = 0;
    this.cardUpdateCount = 0;
  }

  /** Returns text reply bodies in the order they were sent. */
  public getTextReplies(): string[] {
    return [...this.textReplies];
  }

  /** Returns Markdown reply bodies in the order they were sent. */
  public getMarkdownReplies(): string[] {
    return [...this.markdownReplies];
  }

  /** Returns file reply descriptors in the order they were sent. */
  public getFileReplies(): ReplyFile[] {
    return [...this.fileReplies];
  }

  /** Returns image reply descriptors in the order they were sent. */
  public getImageReplies(): ReplyImage[] {
    return [...this.imageReplies];
  }
}
