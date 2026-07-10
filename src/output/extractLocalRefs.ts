/** Extracts local file references from Agent Markdown output for attachment delivery. */

/** Maximum number of referenced local files auto-delivered per Agent reply. */
export const MAX_AUTO_ATTACHMENTS = 10;

/** Result of scanning Markdown for local file references. */
export interface LocalRefsResult {
  /** Local paths to deliver, deduped and in first-seen order, capped at the limit. */
  paths: string[];
  /** Number of local references dropped because the cap was reached. */
  dropped: number;
}

/** Matches Markdown image destinations `![alt](target)`. */
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(\s*(?<target>[^)\s]+)(?:\s+[^)]*)?\)/g;

/**
 * Matches Markdown link destinations `[text](target)` that are NOT images. The
 * negative lookbehind rejects a leading `!`, so image syntax is handled separately.
 */
const MARKDOWN_FILE_LINK_PATTERN = /(?<!!)\[[^\]]*\]\(\s*(?<target>[^)\s]+)(?:\s+[^)]*)?\)/g;

/** URL-ish schemes and prefixes that are not deliverable local files. */
const REMOTE_PREFIX_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * Scans Markdown image references `![alt](target)` for local image paths. Remote
 * URLs, protocol-relative URLs, `data:` URIs, and anchors are excluded. Results are
 * deduped in first-seen order and capped at MAX_AUTO_ATTACHMENTS.
 */
export function extractLocalImageRefs(markdown: string): LocalRefsResult {
  return collectLocalRefs(markdown, MARKDOWN_IMAGE_PATTERN);
}

/**
 * Scans Markdown link references `[text](target)` (excluding image syntax) for local
 * file paths, applying the same local-path filtering, dedupe, and cap as image refs.
 */
export function extractLocalFileRefs(markdown: string): LocalRefsResult {
  return collectLocalRefs(markdown, MARKDOWN_FILE_LINK_PATTERN);
}

/** Collects deduped, capped local paths matched by one Markdown reference pattern. */
function collectLocalRefs(markdown: string, pattern: RegExp): LocalRefsResult {
  const seen = new Set<string>();
  const paths: string[] = [];
  let dropped = 0;

  for (const match of markdown.matchAll(pattern)) {
    const rawTarget = match.groups?.target;

    if (rawTarget === undefined) {
      continue;
    }

    const target = normalizeTarget(rawTarget);

    if (target === undefined || !isLocalPath(target) || seen.has(target)) {
      continue;
    }

    seen.add(target);

    if (paths.length >= MAX_AUTO_ATTACHMENTS) {
      dropped += 1;
      continue;
    }

    paths.push(target);
  }

  return { paths, dropped };
}

/** Strips surrounding angle brackets and whitespace from a Markdown link target. */
function normalizeTarget(rawTarget: string): string | undefined {
  let target = rawTarget.trim();

  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  }

  return target.length > 0 ? target : undefined;
}

/** Reports whether a Markdown link target is a deliverable local filesystem path. */
function isLocalPath(target: string): boolean {
  return !REMOTE_PREFIX_PATTERN.test(target);
}
