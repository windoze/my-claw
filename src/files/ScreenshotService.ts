/** Captures the primary display and returns it as a deliverable image file. */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ReplyFile } from "../output/types.js";
import { UserFacingError } from "../utils/errors.js";
import { createLogger, type Logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

/** macOS screenshot binary; `-x` mutes the shutter, `-D 1` targets the primary display. */
const SCREENCAPTURE_BIN = "/usr/sbin/screencapture";
const SCREENCAPTURE_ARGS = ["-x", "-D", "1"] as const;
const CAPTURE_TIMEOUT_MS = 15_000;
const PERMISSION_HINT = "截屏失败，请检查服务的屏幕录制权限。";

/** Options used to construct the screenshot service. */
export interface ScreenshotServiceOptions {
  logger?: Logger;
}

/** Captures the primary display to a temporary PNG for delivery through a reply sink. */
export class ScreenshotService {
  private readonly logger: Logger;

  public constructor(options: ScreenshotServiceOptions = {}) {
    this.logger = options.logger ?? createLogger("screenshot");
  }

  /** Captures the primary display and returns the resulting temp PNG as a ReplyFile. */
  public async capture(): Promise<ReplyFile> {
    const fileName = `screenshot-${randomUUID()}.png`;
    const outputPath = path.join(os.tmpdir(), fileName);

    try {
      await execFileAsync(SCREENCAPTURE_BIN, [...SCREENCAPTURE_ARGS, outputPath], {
        timeout: CAPTURE_TIMEOUT_MS,
      });
    } catch (error: unknown) {
      this.logger.error("screencapture invocation failed.", { error, outputPath });
      await this.cleanup(outputPath);
      throw new UserFacingError("SCREENSHOT_CAPTURE_FAILED", PERMISSION_HINT, { cause: error });
    }

    const sizeBytes = await fileSizeOrZero(outputPath);

    if (sizeBytes === 0) {
      this.logger.error("Screenshot output is missing or empty.", { outputPath, sizeBytes });
      await this.cleanup(outputPath);
      throw new UserFacingError("SCREENSHOT_EMPTY_OUTPUT", PERMISSION_HINT);
    }

    return { path: outputPath, name: fileName, sizeBytes };
  }

  /** Removes a captured screenshot temp file, ignoring missing-file errors. */
  public async cleanup(filePath: string): Promise<void> {
    try {
      await rm(filePath, { force: true });
    } catch (error: unknown) {
      this.logger.warn("Failed to remove screenshot temp file.", { error, filePath });
    }
  }
}

/** Returns the file size in bytes, or 0 when the path is missing or unreadable. */
async function fileSizeOrZero(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}
