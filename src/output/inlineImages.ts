/** Rewrites local Markdown image references into DingTalk inline images (mediaId). */

import { extractLocalImageRefs } from "./extractLocalRefs.js";

/**
 * Uploads one local image path and returns its DingTalk mediaId, or `null` when the
 * image cannot be inlined (out of policy, missing, oversized, upload failed). Must not
 * throw — inlining is best-effort and falls back to the original reference.
 */
export type ImageUploader = (localPath: string) => Promise<string | null>;

/** Matches a complete Markdown image token, capturing alt text and target. */
const MARKDOWN_IMAGE_TOKEN = /!\[(?<alt>[^\]]*)\]\(\s*(?<target>[^)\s]+)(?:\s+[^)]*)?\)/g;

/**
 * Rewrites `![alt](localPath)` to `![alt](mediaId)` for every local image reference
 * whose upload succeeds. Each unique path is uploaded at most once (cached), so a body
 * that repeats an image — or a card body re-sent on finalize — never re-uploads it.
 * References that fail to upload are left untouched.
 */
export async function inlineLocalImages(
  markdown: string,
  upload: ImageUploader,
): Promise<string> {
  const { paths } = extractLocalImageRefs(markdown);

  if (paths.length === 0) {
    return markdown;
  }

  const mediaIdByPath = new Map<string, string>();

  for (const localPath of paths) {
    const mediaId = await upload(localPath);

    if (mediaId !== null) {
      mediaIdByPath.set(localPath, mediaId);
    }
  }

  if (mediaIdByPath.size === 0) {
    return markdown;
  }

  return markdown.replace(MARKDOWN_IMAGE_TOKEN, (match, alt: string, target: string) => {
    const mediaId = mediaIdByPath.get(normalizeTarget(target));
    return mediaId === undefined ? match : `![${alt}](${mediaId})`;
  });
}

/** Strips surrounding angle brackets/whitespace so targets match the extractor's keys. */
function normalizeTarget(target: string): string {
  const trimmed = target.trim();

  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}
