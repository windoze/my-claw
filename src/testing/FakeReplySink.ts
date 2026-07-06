/** In-memory reply sink for local routing and command integration checks. */

import type { ReplySink } from "../output/types.js";

/** Recorded reply call made by code under test. */
export type FakeReplyCall =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "markdown";
      markdown: string;
    };

/** Reply sink that records all text and Markdown sends in call order. */
export class FakeReplySink implements ReplySink {
  public readonly calls: FakeReplyCall[] = [];
  public readonly textReplies: string[] = [];
  public readonly markdownReplies: string[] = [];

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

  /** Clears all recorded calls so the same sink can be reused across scenarios. */
  public clear(): void {
    this.calls.length = 0;
    this.textReplies.length = 0;
    this.markdownReplies.length = 0;
  }

  /** Returns text reply bodies in the order they were sent. */
  public getTextReplies(): string[] {
    return [...this.textReplies];
  }

  /** Returns Markdown reply bodies in the order they were sent. */
  public getMarkdownReplies(): string[] {
    return [...this.markdownReplies];
  }
}
