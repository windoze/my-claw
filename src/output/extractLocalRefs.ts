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

/**
 * Matches Markdown image `![alt](target)` and link `[text](target)` destinations.
 * The leading `!` is optional and captured so both forms are handled uniformly.
 */
const MARKDOWN_LINK_PATTERN = /!?\[[^\]]*\]\(\s*(?<target>[^)\s]+)(?:\s+[^)]*)?\)/g;

/** URL-ish schemes and prefixes that are not deliverable local files. */
const REMOTE_PREFIX_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * Scans Markdown for referenced local files (images and links), keeping only paths
 * that point at the local filesystem. Remote URLs, protocol-relative URLs, `data:`
 * URIs, `mailto:` links, and pure anchors are excluded. Results are deduped in
 * first-seen order and capped at MAX_AUTO_ATTACHMENTS.
 */
export function extractLocalRefs(markdown: string): LocalRefsResult {
  const seen = new Set<string>();
  const paths: string[] = [];
  let dropped = 0;

  for (const match of markdown.matchAll(MARKDOWN_LINK_PATTERN)) {
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
