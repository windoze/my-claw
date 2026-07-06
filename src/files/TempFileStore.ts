/** Controlled temporary storage for user-provided DingTalk attachments. */

import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import type { IncomingMessageAttachment } from "../messages/types.js";
import { UserFacingError, type AppErrorOptions } from "../utils/errors.js";
import { createLogger, type Logger } from "../utils/logger.js";

/** Options used to create a TempFileStore. */
export interface TempFileStoreOptions {
  rootDir: string;
  maxFileBytes: number;
  allowedMimeTypes: readonly string[];
  ttlMs?: number;
  cleanupIntervalMs?: number;
  logger?: Logger;
  now?: () => Date;
}

/** Request to save one downloaded attachment response. */
export interface SaveDownloadedAttachmentOptions {
  attachment: IncomingMessageAttachment;
  response: Response;
  messageId?: string;
  senderId: string;
}

/** Result returned after one attachment is materialized locally. */
export interface SaveDownloadedAttachmentResult {
  attachment: IncomingMessageAttachment;
}

/** User-safe categories produced while materializing attachments. */
export type TempFileStoreErrorCode =
  | "ATTACHMENT_DOWNLOAD_FAILED"
  | "ATTACHMENT_EMPTY_RESPONSE"
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_TYPE_UNSUPPORTED"
  | "ATTACHMENT_WRITE_FAILED";

interface TempFileStoreErrorOptions extends AppErrorOptions {
  fileName?: string;
  mime?: string;
  sizeBytes?: number;
}

/** Error whose safe message may be sent directly to the DingTalk user. */
export class TempFileStoreError extends UserFacingError {
  public readonly code: TempFileStoreErrorCode;
  public readonly fileName?: string;
  public readonly mime?: string;
  public readonly sizeBytes?: number;

  public constructor(
    code: TempFileStoreErrorCode,
    message: string,
    options: TempFileStoreErrorOptions = {},
  ) {
    super(code, message, options);
    this.name = "TempFileStoreError";
    this.code = code;
    this.fileName = options.fileName;
    this.mime = options.mime;
    this.sizeBytes = options.sizeBytes;
  }
}

const DEFAULT_ATTACHMENT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SAFE_FILE_NAME_CHARS = 120;
const GENERIC_BINARY_MIME = "application/octet-stream";
const UNKNOWN_ATTACHMENT_NAME = "附件";

const EXTENSION_MIME_TYPES = new Map<string, string>([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".jsonc", "application/json"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

/** Saves downloaded attachments under a bounded temp root and prunes old files. */
export class TempFileStore {
  public readonly rootDir: string;

  private readonly maxFileBytes: number;
  private readonly allowedMimeTypes: readonly string[];
  private readonly ttlMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private cleanupTimer: NodeJS.Timeout | null = null;

  public constructor(options: TempFileStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.maxFileBytes = options.maxFileBytes;
    this.allowedMimeTypes = options.allowedMimeTypes.map((mime) => mime.trim().toLowerCase());
    this.ttlMs = options.ttlMs ?? DEFAULT_ATTACHMENT_TTL_MS;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.logger = options.logger ?? createLogger("files:temp");
    this.now = options.now ?? (() => new Date());
  }

  /** Ensures the root exists and starts periodic cleanup once. */
  public async start(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await this.cleanupExpired();

    if (this.cleanupTimer !== null) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch((error: unknown) => {
        this.logger.error("Attachment temp cleanup failed.", { error, rootDir: this.rootDir });
      });
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  /** Stops future cleanup ticks; existing temp files remain until their TTL expires. */
  public close(): void {
    if (this.cleanupTimer === null) {
      return;
    }

    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  /** Saves one downloaded attachment response to a unique local path. */
  public async saveDownloadedAttachment(
    options: SaveDownloadedAttachmentOptions,
  ): Promise<SaveDownloadedAttachmentResult> {
    await mkdir(this.rootDir, { recursive: true });

    if (!options.response.ok) {
      throw new TempFileStoreError(
        "ATTACHMENT_DOWNLOAD_FAILED",
        `DingTalk attachment download failed with HTTP ${options.response.status}.`,
        {
          safeMessage: `附件下载失败：${displayAttachmentName(options.attachment)}。请稍后重试或查看服务日志。`,
          fileName: displayAttachmentName(options.attachment),
        },
      );
    }

    const fileName = resolveAttachmentFileName(options.attachment, options.response);
    const mime = resolveAttachmentMime(options.attachment, options.response, fileName);
    this.assertMimeAllowed(mime, fileName);
    this.assertAnnouncedSizeAllowed(options.attachment, options.response, fileName, mime);

    const targetPath = await this.createTargetPath(fileName, options.messageId);
    const tempPath = `${targetPath}.tmp-${randomUUID()}`;
    let sizeBytes = 0;

    try {
      sizeBytes = await this.writeResponseBody(options.response, tempPath, fileName, mime);
      await rename(tempPath, targetPath);
      const savedAttachment: IncomingMessageAttachment = {
        ...options.attachment,
        filename: fileName,
        mime,
        localPath: targetPath,
        size: sizeBytes,
      };

      this.logger.info("DingTalk attachment saved to temp file.", {
        senderId: options.senderId,
        messageId: options.messageId,
        type: savedAttachment.type,
        fileName,
        mime,
        sizeBytes,
        localPath: targetPath,
        expiresAt: new Date(this.now().getTime() + this.ttlMs).toISOString(),
      });

      return { attachment: savedAttachment };
    } catch (error: unknown) {
      await rm(tempPath, { force: true });

      if (error instanceof TempFileStoreError) {
        throw error;
      }

      this.logger.error("Failed to save DingTalk attachment temp file.", {
        error,
        senderId: options.senderId,
        messageId: options.messageId,
        fileName,
        mime,
      });
      throw new TempFileStoreError(
        "ATTACHMENT_WRITE_FAILED",
        `Failed to save DingTalk attachment: ${fileName}`,
        {
          safeMessage: `附件保存失败：${fileName}。请稍后重试或查看服务日志。`,
          cause: error,
          fileName,
          mime,
          sizeBytes,
        },
      );
    }
  }

  /** Removes temp files older than the configured TTL. */
  public async cleanupExpired(): Promise<number> {
    const cutoffMs = this.now().getTime() - this.ttlMs;
    const removed = await this.cleanupExpiredInDir(this.rootDir, cutoffMs);

    if (removed > 0) {
      this.logger.debug("Removed expired DingTalk attachment temp files.", {
        rootDir: this.rootDir,
        removed,
      });
    }

    return removed;
  }

  private async createTargetPath(fileName: string, messageId: string | undefined): Promise<string> {
    const messageDirName = sanitizePathSegment(messageId ?? this.now().toISOString());
    const messageDir = path.join(this.rootDir, messageDirName);
    await mkdir(messageDir, { recursive: true });
    return path.join(messageDir, `${randomUUID()}-${fileName}`);
  }

  private async writeResponseBody(
    response: Response,
    tempPath: string,
    fileName: string,
    mime: string,
  ): Promise<number> {
    if (response.body === null) {
      throw new TempFileStoreError("ATTACHMENT_EMPTY_RESPONSE", "DingTalk attachment response is empty.", {
        safeMessage: `附件内容为空：${fileName}。`,
        fileName,
        mime,
      });
    }

    const reader = response.body.getReader();
    const fileHandle = await open(tempPath, "wx");
    let sizeBytes = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        sizeBytes += value.byteLength;

        if (sizeBytes > this.maxFileBytes) {
          throw this.createTooLargeError(fileName, mime, sizeBytes);
        }

        await writeChunk(fileHandle, value);
      }
    } finally {
      await fileHandle.close();
      reader.releaseLock();
    }

    return sizeBytes;
  }

  private assertMimeAllowed(mime: string, fileName: string): void {
    if (isMimeAllowed(mime, this.allowedMimeTypes)) {
      return;
    }

    throw new TempFileStoreError(
      "ATTACHMENT_TYPE_UNSUPPORTED",
      `Attachment MIME type is not allowed: ${mime}`,
      {
        safeMessage: `暂不支持的附件类型：${fileName}（${mime}）。`,
        fileName,
        mime,
      },
    );
  }

  private assertAnnouncedSizeAllowed(
    attachment: IncomingMessageAttachment,
    response: Response,
    fileName: string,
    mime: string,
  ): void {
    const announcedSize = attachment.size ?? parseContentLength(response.headers.get("content-length"));

    if (announcedSize !== undefined && announcedSize > this.maxFileBytes) {
      throw this.createTooLargeError(fileName, mime, announcedSize);
    }
  }

  private createTooLargeError(fileName: string, mime: string, sizeBytes: number): TempFileStoreError {
    return new TempFileStoreError(
      "ATTACHMENT_TOO_LARGE",
      `Attachment exceeds size limit: ${fileName}`,
      {
        safeMessage: `附件过大，不能处理：${fileName}（${formatBytes(sizeBytes)}，限制 ${formatBytes(this.maxFileBytes)}）。`,
        fileName,
        mime,
        sizeBytes,
      },
    );
  }

  private async cleanupExpiredInDir(dir: string, cutoffMs: number): Promise<number> {
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return 0;
      }

      throw error;
    }

    let removed = 0;

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        removed += await this.cleanupExpiredInDir(entryPath, cutoffMs);
        await removeDirIfEmpty(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const entryStats = await stat(entryPath);

      if (entryStats.mtimeMs <= cutoffMs) {
        await rm(entryPath, { force: true });
        removed += 1;
      }
    }

    return removed;
  }
}

async function writeChunk(fileHandle: FileHandle, value: Uint8Array): Promise<void> {
  await fileHandle.write(Buffer.from(value));
}

async function removeDirIfEmpty(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT") || isNodeErrorWithCode(error, "ENOTEMPTY")) {
      return;
    }

    throw error;
  }
}

function resolveAttachmentFileName(
  attachment: IncomingMessageAttachment,
  response: Response,
): string {
  const name =
    attachment.filename ??
    readContentDispositionFileName(response.headers.get("content-disposition")) ??
    defaultAttachmentFileName(attachment);

  return sanitizeFileName(name);
}

function resolveAttachmentMime(
  attachment: IncomingMessageAttachment,
  response: Response,
  fileName: string,
): string {
  const attachmentMime = normalizeMime(attachment.mime);
  const inferredMime = inferMimeFromFileName(fileName);
  const responseMime = normalizeMime(response.headers.get("content-type"));

  return (
    nonGenericMime(attachmentMime) ??
    inferredMime ??
    nonGenericMime(responseMime) ??
    attachmentMime ??
    responseMime ??
    GENERIC_BINARY_MIME
  );
}

function nonGenericMime(mime: string | undefined): string | undefined {
  return mime === undefined || mime === GENERIC_BINARY_MIME ? undefined : mime;
}

function inferMimeFromFileName(fileName: string): string | undefined {
  return EXTENSION_MIME_TYPES.get(path.extname(fileName).toLowerCase());
}

function normalizeMime(value: string | undefined | null): string | undefined {
  const mediaType = value?.split(";")[0]?.trim().toLowerCase();
  return mediaType === undefined || mediaType.length === 0 ? undefined : mediaType;
}

function isMimeAllowed(mime: string, allowedMimeTypes: readonly string[]): boolean {
  const normalizedMime = mime.toLowerCase();
  return allowedMimeTypes.some((allowedMime) => {
    if (allowedMime.endsWith("/*")) {
      return normalizedMime.startsWith(`${allowedMime.slice(0, -1)}`);
    }

    return normalizedMime === allowedMime;
  });
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function readContentDispositionFileName(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }

  const utf8Match = /filename\*=UTF-8''(?<name>[^;]+)/i.exec(value);
  if (utf8Match?.groups?.name !== undefined) {
    return decodeURIComponent(utf8Match.groups.name);
  }

  const quotedMatch = /filename="(?<name>[^"]+)"/i.exec(value);
  if (quotedMatch?.groups?.name !== undefined) {
    return quotedMatch.groups.name;
  }

  const bareMatch = /filename=(?<name>[^;]+)/i.exec(value);
  return bareMatch?.groups?.name?.trim();
}

function defaultAttachmentFileName(attachment: IncomingMessageAttachment): string {
  const extension = attachment.type === "image" ? ".jpg" : ".bin";
  return `${attachment.type}-${randomUUID()}${extension}`;
}

function sanitizeFileName(fileName: string): string {
  const baseName = path.basename(fileName.trim()).replace(/[^\w.\-() \u4e00-\u9fff]/g, "_");
  const normalized = baseName.length > 0 ? baseName : UNKNOWN_ATTACHMENT_NAME;
  return normalized.length <= MAX_SAFE_FILE_NAME_CHARS
    ? normalized
    : normalized.slice(0, MAX_SAFE_FILE_NAME_CHARS);
}

function sanitizePathSegment(value: string): string {
  const normalized = value.trim().replace(/[^\w.\-]/g, "_");
  return normalized.length > 0 ? normalized.slice(0, MAX_SAFE_FILE_NAME_CHARS) : randomUUID();
}

function displayAttachmentName(attachment: IncomingMessageAttachment): string {
  return attachment.filename !== undefined ? sanitizeFileName(attachment.filename) : UNKNOWN_ATTACHMENT_NAME;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }

  return `${(kib / 1024).toFixed(1)} MiB`;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
