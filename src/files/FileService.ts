/** Local file validation and delivery service for the `/dl` command. */

import { stat } from "node:fs/promises";
import path from "node:path";

import type { ReplyFile, ReplySink } from "../output/types.js";
import { PathPolicy, PathPolicyError } from "../security/PathPolicy.js";
import type { AppErrorOptions } from "../utils/errors.js";
import { UserFacingError } from "../utils/errors.js";
import { createLogger, type Logger } from "../utils/logger.js";

/** Options required to construct the file download service. */
export interface FileServiceOptions {
  pathPolicy: PathPolicy;
  maxFileBytes: number;
  logger?: Logger;
  now?: () => Date;
}

/** Request accepted by FileService when handling `/dl <path>`. */
export interface SendLocalFileOptions {
  inputPath: string;
  baseDir: string;
  senderId: string;
  replySink: ReplySink;
}

/** Successful local file delivery result. */
export interface SendLocalFileResult {
  file: ReplyFile;
}

/** User-safe file download error categories. */
export type FileServiceErrorCode =
  | "FILE_DOWNLOAD_INVALID_PATH"
  | "FILE_DOWNLOAD_TOO_LARGE"
  | "FILE_DOWNLOAD_SEND_FAILED";

interface FileServiceErrorOptions extends AppErrorOptions {
  fileName?: string;
  realpath?: string;
  sizeBytes?: number;
}

/** Error whose safe message can be shown directly to the DingTalk user. */
export class FileServiceError extends UserFacingError {
  public readonly code: FileServiceErrorCode;
  public readonly fileName?: string;
  public readonly realpath?: string;
  public readonly sizeBytes?: number;

  public constructor(
    code: FileServiceErrorCode,
    message: string,
    options: FileServiceErrorOptions = {},
  ) {
    super(code, message, options);
    this.name = "FileServiceError";
    this.code = code;
    this.fileName = options.fileName;
    this.realpath = options.realpath;
    this.sizeBytes = options.sizeBytes;
  }
}

const UNKNOWN_FILE_NAME = "指定文件";

/** Validates local file requests and sends allowed files through the current reply sink. */
export class FileService {
  private readonly pathPolicy: PathPolicy;
  private readonly maxFileBytes: number;
  private readonly logger: Logger;
  private readonly now: () => Date;

  public constructor(options: FileServiceOptions) {
    this.pathPolicy = options.pathPolicy;
    this.maxFileBytes = options.maxFileBytes;
    this.logger = options.logger ?? createLogger("files");
    this.now = options.now ?? (() => new Date());
  }

  /** Resolves, validates, audits, and sends one requested local file. */
  public async sendLocalFile(options: SendLocalFileOptions): Promise<SendLocalFileResult> {
    const requestedAt = this.now().toISOString();
    let file: ReplyFile | null = null;

    try {
      file = await this.resolveAllowedFile(options.inputPath, options.baseDir);
      await options.replySink.sendFile(file);
      this.logger.info("Local file download sent.", {
        senderId: options.senderId,
        realpath: file.path,
        sizeBytes: file.sizeBytes,
        time: requestedAt,
        result: "sent",
      });

      return { file };
    } catch (error: unknown) {
      if (error instanceof PathPolicyError) {
        const fileError = createPathFileServiceError(error, options.inputPath);
        this.logRejected(options.senderId, requestedAt, fileError);
        throw fileError;
      }

      if (error instanceof FileServiceError) {
        this.logRejected(options.senderId, requestedAt, error);
        throw error;
      }

      const failedFileName = file?.name ?? displayFileName(options.inputPath);
      this.logger.error("Local file download send failed.", {
        error,
        senderId: options.senderId,
        realpath: file?.path,
        sizeBytes: file?.sizeBytes,
        fileName: failedFileName,
        time: requestedAt,
        result: "failed",
      });
      throw new FileServiceError(
        "FILE_DOWNLOAD_SEND_FAILED",
        `Failed to send local file: ${file?.path ?? options.inputPath}`,
        {
          safeMessage: `文件发送失败：${failedFileName}。请稍后重试或查看服务日志。`,
          cause: error,
          fileName: failedFileName,
          realpath: file?.path,
          sizeBytes: file?.sizeBytes,
        },
      );
    }
  }

  private async resolveAllowedFile(inputPath: string, baseDir: string): Promise<ReplyFile> {
    const realFile = await this.pathPolicy.assertAllowedFile(inputPath, { baseDir });
    const fileStats = await stat(realFile);
    const fileName = path.basename(realFile) || UNKNOWN_FILE_NAME;
    const file: ReplyFile = {
      path: realFile,
      name: fileName,
      sizeBytes: fileStats.size,
    };

    if (!fileStats.isFile()) {
      throw new FileServiceError(
        "FILE_DOWNLOAD_INVALID_PATH",
        `Local download target is not a regular file: ${realFile}`,
        {
          safeMessage: `不能发送目录、设备文件、socket 或其他非普通文件：${fileName}。`,
          fileName,
          realpath: realFile,
          sizeBytes: fileStats.size,
        },
      );
    }

    if (fileStats.size > this.maxFileBytes) {
      throw new FileServiceError(
        "FILE_DOWNLOAD_TOO_LARGE",
        `Local download target exceeds size limit: ${realFile}`,
        {
          safeMessage: `文件过大，不能发送：${fileName}（${formatBytes(fileStats.size)}，限制 ${formatBytes(this.maxFileBytes)}）。`,
          fileName,
          realpath: realFile,
          sizeBytes: fileStats.size,
        },
      );
    }

    return file;
  }

  private logRejected(senderId: string, time: string, error: FileServiceError): void {
    this.logger.warn("Local file download rejected.", {
      senderId,
      code: error.code,
      fileName: error.fileName,
      realpath: error.realpath ?? null,
      sizeBytes: error.sizeBytes ?? null,
      time,
      result: "rejected",
    });
  }
}

function createPathFileServiceError(
  error: PathPolicyError,
  inputPath: string,
): FileServiceError {
  const fileName = displayFileName(error.resolvedPath ?? inputPath);

  return new FileServiceError("FILE_DOWNLOAD_INVALID_PATH", error.message, {
    safeMessage: formatPathPolicySafeMessage(error, fileName),
    cause: error,
    fileName,
    realpath: error.resolvedPath,
  });
}

function formatPathPolicySafeMessage(error: PathPolicyError, fileName: string): string {
  switch (error.code) {
    case "PATH_NOT_FOUND":
      return `文件不存在：${fileName}。`;
    case "PATH_NOT_DIRECTORY":
    case "PATH_NOT_FILE":
      return `不能发送目录、设备文件、socket 或其他非普通文件：${fileName}。`;
    case "PATH_NOT_ACCESSIBLE":
      return `无法访问文件：${fileName}。`;
    case "PATH_OUTSIDE_ALLOWED_ROOTS":
      return `文件不在允许发送的目录内：${fileName}。`;
    case "PATH_ALLOWED_ROOTS_EMPTY":
      return "文件发送目录未正确配置，请联系服务维护者。";
  }
}

function displayFileName(inputPath: string): string {
  const baseName = path.basename(inputPath.trim());
  return baseName.length > 0 ? baseName : UNKNOWN_FILE_NAME;
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
