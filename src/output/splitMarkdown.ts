/** Markdown-aware splitting utilities for DingTalk message size limits. */

const DEFAULT_CODE_FENCE = "```";
const CODE_BLOCK_FALLBACK_NOTICE = "[代码块过长，已按普通文本分段]";
const PARAGRAPH_SEPARATOR = "\n\n";

type MarkdownBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "code";
      text: string;
    };

interface PlainTextSplitOptions {
  trimBoundaryWhitespace?: boolean;
}

/** Splits Markdown into chunks no longer than maxChars, preferring readable boundaries. */
export function splitMarkdown(markdown: string, maxChars: number): string[] {
  const limit = normalizeLimit(maxChars);

  if (markdown.length === 0) {
    return [];
  }

  if (markdown.length <= limit) {
    return [markdown];
  }

  const chunks: string[] = [];
  let currentChunk = "";

  for (const block of parseMarkdownBlocks(markdown)) {
    for (const blockChunk of splitMarkdownBlock(block, limit)) {
      if (blockChunk.length === 0) {
        continue;
      }

      if (currentChunk.length === 0) {
        currentChunk = blockChunk;
        continue;
      }

      const joined = `${currentChunk}${PARAGRAPH_SEPARATOR}${blockChunk}`;
      if (joined.length <= limit) {
        currentChunk = joined;
        continue;
      }

      chunks.push(currentChunk);
      currentChunk = blockChunk;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks.length === 0 ? [] : chunks.flatMap((chunk) => enforceHardLimit(chunk, limit));
}

/** Converts a Markdown document into paragraph and fenced-code blocks. */
function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const textLines: string[] = [];
  let codeLines: string[] | null = null;

  for (const line of markdown.split("\n")) {
    if (isFenceLine(line)) {
      if (codeLines === null) {
        flushTextBlocks(textLines, blocks);
        codeLines = [line];
      } else {
        codeLines.push(line);
        blocks.push({ type: "code", text: codeLines.join("\n") });
        codeLines = null;
      }
      continue;
    }

    if (codeLines !== null) {
      codeLines.push(line);
      continue;
    }

    textLines.push(line);
  }

  if (codeLines !== null) {
    blocks.push({ type: "code", text: codeLines.join("\n") });
  }

  flushTextBlocks(textLines, blocks);
  return blocks;
}

/** Flushes accumulated non-code lines as paragraph-sized text blocks. */
function flushTextBlocks(textLines: string[], blocks: MarkdownBlock[]): void {
  const text = textLines.join("\n").trimEnd();
  textLines.length = 0;

  if (text.trim().length === 0) {
    return;
  }

  for (const paragraph of text.split(/\n{2,}/u)) {
    const normalizedParagraph = paragraph.trimEnd();
    if (normalizedParagraph.trim().length > 0) {
      blocks.push({ type: "text", text: normalizedParagraph });
    }
  }
}

/** Splits one logical Markdown block while preserving code fences when feasible. */
function splitMarkdownBlock(block: MarkdownBlock, limit: number): string[] {
  if (block.text.length <= limit) {
    return [block.text];
  }

  if (block.type === "code") {
    return splitCodeBlock(block.text, limit);
  }

  return splitPlainText(block.text, limit);
}

/** Splits a fenced code block and closes/reopens fences around each chunk. */
function splitCodeBlock(codeBlock: string, limit: number): string[] {
  const lines = codeBlock.split("\n");
  const openingFence = lines[0] ?? DEFAULT_CODE_FENCE;
  const closingFence = getClosingFence(openingFence);
  const hasClosingFence = lines.length > 1 && isFenceLine(lines[lines.length - 1] ?? "");
  const bodyLines = hasClosingFence ? lines.slice(1, -1) : lines.slice(1);
  const body = bodyLines.join("\n");
  const bodyLimit = limit - openingFence.length - closingFence.length - 2;

  if (bodyLimit < 1) {
    return splitPlainText(formatCodeBlockFallback(codeBlock), limit);
  }

  const bodyChunks =
    body.length === 0
      ? [""]
      : splitPlainText(body, bodyLimit, { trimBoundaryWhitespace: false });

  return bodyChunks.map((bodyChunk) => `${openingFence}\n${bodyChunk}\n${closingFence}`);
}

/** Splits non-code text at paragraph, line, or whitespace boundaries before hard slicing. */
function splitPlainText(
  text: string,
  limit: number,
  options: PlainTextSplitOptions = {},
): string[] {
  if (text.length <= limit) {
    return text.length === 0 ? [] : [text];
  }

  const trimBoundaryWhitespace = options.trimBoundaryWhitespace ?? true;
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const splitAt = findPlainTextSplitIndex(remaining, limit);
    const rawChunk = remaining.slice(0, splitAt);
    const chunk = trimBoundaryWhitespace ? rawChunk.trimEnd() : rawChunk;

    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    remaining = remaining.slice(splitAt);
    if (trimBoundaryWhitespace) {
      remaining = remaining.trimStart();
    }
  }

  const tail = trimBoundaryWhitespace ? remaining.trim() : remaining;
  if (tail.length > 0) {
    chunks.push(tail);
  }

  return chunks;
}

/** Finds the most readable split point available before the hard character limit. */
function findPlainTextSplitIndex(text: string, limit: number): number {
  const window = text.slice(0, limit);
  const paragraphIndex = window.lastIndexOf(PARAGRAPH_SEPARATOR);
  if (paragraphIndex > 0) {
    return paragraphIndex + PARAGRAPH_SEPARATOR.length;
  }

  const newlineIndex = window.lastIndexOf("\n");
  if (newlineIndex > 0) {
    return newlineIndex + 1;
  }

  for (let index = Math.min(limit - 1, text.length - 1); index > 0; index -= 1) {
    if (/\s/u.test(text[index] ?? "")) {
      return index + 1;
    }
  }

  return limit;
}

/** Applies an emergency hard limit guard to keep every returned chunk sendable. */
function enforceHardLimit(chunk: string, limit: number): string[] {
  if (chunk.length <= limit) {
    return [chunk];
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < chunk.length; offset += limit) {
    chunks.push(chunk.slice(offset, offset + limit));
  }
  return chunks;
}

/** Detects Markdown triple-backtick fence lines. */
function isFenceLine(line: string): boolean {
  return /^ {0,3}```/u.test(line);
}

/** Reuses the opening fence marker so split chunks remain valid Markdown blocks. */
function getClosingFence(openingFence: string): string {
  const match = /^( {0,3})(`{3,})/u.exec(openingFence);
  if (match === null) {
    return DEFAULT_CODE_FENCE;
  }

  return `${match[1]}${match[2]}`;
}

/** Converts an unsplittable code block to labeled plain text before size splitting. */
function formatCodeBlockFallback(codeBlock: string): string {
  const lines = codeBlock.split("\n");
  const bodyLines = isFenceLine(lines[lines.length - 1] ?? "")
    ? lines.slice(1, -1)
    : lines.slice(1);
  const body = bodyLines.join("\n").trim();

  if (body.length === 0) {
    return CODE_BLOCK_FALLBACK_NOTICE;
  }

  return `${CODE_BLOCK_FALLBACK_NOTICE}\n${body}`;
}

/** Normalizes invalid limits defensively even though config validation requires positive ints. */
function normalizeLimit(maxChars: number): number {
  if (!Number.isFinite(maxChars)) {
    return 1;
  }

  return Math.max(1, Math.floor(maxChars));
}
