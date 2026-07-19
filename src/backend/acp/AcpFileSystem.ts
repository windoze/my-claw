/** ACP `fs/*` client-method implementation bounded by the gateway path policy. */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

import type { PathPolicy } from "../../security/PathPolicy.js";
import { UserFacingError } from "../../utils/errors.js";
import { createLogger, type Logger } from "../../utils/logger.js";
import { resolveUserPath } from "../../utils/path.js";

/** Options for constructing an ACP filesystem bridge for one session directory. */
export interface AcpFileSystemOptions {
  pathPolicy: PathPolicy;
  cwd: string;
  maxFileBytes?: number;
  logger?: Logger;
}

/**
 * Serves ACP `fs/read_text_file` and `fs/write_text_file` requests, enforcing the
 * gateway's directory allowlist (rejecting symlink escapes) and a per-file size
 * ceiling. Paths are resolved against the session `cwd`; the ACP spec passes
 * absolute paths, but relative ones are handled defensively.
 */
export class AcpFileSystem {
  private readonly pathPolicy: PathPolicy;
  private readonly cwd: string;
  private readonly maxFileBytes: number | undefined;
  private readonly logger: Logger;

  public constructor(options: AcpFileSystemOptions) {
    this.pathPolicy = options.pathPolicy;
    this.cwd = options.cwd;
    this.maxFileBytes = options.maxFileBytes;
    this.logger = options.logger ?? createLogger("backend:acp:fs");
  }

  /** Reads an allowlisted text file, optionally sliced by 1-based line + limit. */
  public async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const realPath = await this.pathPolicy.assertAllowedFile(params.path, { baseDir: this.cwd });

    if (this.maxFileBytes !== undefined) {
      const info = await stat(realPath);
      if (info.size > this.maxFileBytes) {
        throw new UserFacingError(
          "ACP_FS_FILE_TOO_LARGE",
          `文件超过大小上限（${info.size} > ${this.maxFileBytes} 字节）：${params.path}`,
        );
      }
    }

    const content = await readFile(realPath, "utf8");
    return { content: sliceLines(content, params.line ?? null, params.limit ?? null) };
  }

  /** Writes text to an allowlisted path, creating parent directories as needed. */
  public async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    // The target file may not exist yet, so validate its parent directory (which
    // resolves symlinks) and confirm the joined path stays inside an allowed root.
    const resolvedPath = resolveUserPath(params.path, this.cwd);
    const realDir = await this.pathPolicy.assertAllowedDir(dirname(resolvedPath), {
      baseDir: this.cwd,
    });

    if (!this.pathPolicy.isAllowedRealPath(resolvedPath)) {
      throw new UserFacingError(
        "ACP_FS_PATH_OUTSIDE_ROOTS",
        `写入路径不在允许目录内：${params.path}`,
      );
    }

    await mkdir(realDir, { recursive: true });
    await writeFile(resolvedPath, params.content, "utf8");
    this.logger.debug("ACP fs write completed.", { path: resolvedPath });
    return {};
  }
}

/**
 * Returns the substring starting at a 1-based line for at most `limit` lines.
 * A null start or limit means "from the beginning" / "to the end" respectively.
 */
function sliceLines(content: string, line: number | null, limit: number | null): string {
  if ((line === null || line <= 1) && limit === null) {
    return content;
  }

  const lines = content.split("\n");
  const startIndex = line !== null && line > 1 ? line - 1 : 0;
  const endIndex = limit !== null ? startIndex + limit : lines.length;
  return lines.slice(startIndex, endIndex).join("\n");
}
