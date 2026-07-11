/** Captures the primary display and returns it as a deliverable image file. */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ScreenshotConfig } from "../config/types.js";
import type { ReplyFile } from "../output/types.js";
import { UserFacingError } from "../utils/errors.js";
import { createLogger, type Logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

const CAPTURE_TIMEOUT_MS = 15_000;

/** Placeholder in configured args that is replaced with the target PNG path. */
const OUTPUT_PLACEHOLDER = "{output}";

/** A screenshot command and its argument template (may contain {output}). */
interface CaptureCommand {
  command: string;
  args: readonly string[];
}

/**
 * macOS default: `-x` mutes the shutter, `-D 1` targets the primary display.
 * Uses the absolute path so it works regardless of PATH.
 */
const MACOS_COMMAND: CaptureCommand = {
  command: "/usr/sbin/screencapture",
  args: ["-x", "-D", "1", OUTPUT_PLACEHOLDER],
};

/**
 * Linux candidates tried in order; the first one available on PATH wins.
 * Covers GNOME, KDE, wlroots/Wayland, and common X11 utilities.
 */
const LINUX_CANDIDATES: readonly CaptureCommand[] = [
  { command: "gnome-screenshot", args: ["-f", OUTPUT_PLACEHOLDER] },
  { command: "spectacle", args: ["-b", "-n", "-o", OUTPUT_PLACEHOLDER] },
  { command: "grim", args: [OUTPUT_PLACEHOLDER] },
  { command: "scrot", args: [OUTPUT_PLACEHOLDER] },
  { command: "maim", args: [OUTPUT_PLACEHOLDER] },
  { command: "import", args: ["-window", "root", OUTPUT_PLACEHOLDER] },
];

const CAPTURE_FAILED_HINT =
  "截屏失败。macOS 请检查屏幕录制权限；Linux 请确认截屏命令已安装（如需在 Wayland 下运行可能还需授权）。";
const NO_COMMAND_HINT =
  "未找到可用的截屏命令。请安装 gnome-screenshot / spectacle / grim / scrot / maim / import 之一，或在配置的 screenshot.command 中指定。";
const UNSUPPORTED_PLATFORM_HINT =
  "当前平台没有内置的截屏命令，请在配置的 screenshot.command / screenshot.args 中显式指定。";

/** Options used to construct the screenshot service. */
export interface ScreenshotServiceOptions {
  logger?: Logger;
  config?: ScreenshotConfig;
}

/** Captures the primary display to a temporary PNG for delivery through a reply sink. */
export class ScreenshotService {
  private readonly logger: Logger;
  private readonly config?: ScreenshotConfig;
  /** Cached command resolved on first capture, reused for subsequent captures. */
  private resolvedCommand?: CaptureCommand;

  public constructor(options: ScreenshotServiceOptions = {}) {
    this.logger = options.logger ?? createLogger("screenshot");
    this.config = options.config;
  }

  /** Captures the primary display and returns the resulting temp PNG as a ReplyFile. */
  public async capture(): Promise<ReplyFile> {
    const fileName = `screenshot-${randomUUID()}.png`;
    const outputPath = path.join(os.tmpdir(), fileName);

    const captureCommand = await this.resolveCommand();
    const args = buildArgs(captureCommand.args, outputPath);

    try {
      await execFileAsync(captureCommand.command, args, {
        timeout: CAPTURE_TIMEOUT_MS,
      });
    } catch (error: unknown) {
      this.logger.error("Screenshot command invocation failed.", {
        error,
        command: captureCommand.command,
        outputPath,
      });
      await this.cleanup(outputPath);
      throw new UserFacingError("SCREENSHOT_CAPTURE_FAILED", CAPTURE_FAILED_HINT, { cause: error });
    }

    const sizeBytes = await fileSizeOrZero(outputPath);

    if (sizeBytes === 0) {
      this.logger.error("Screenshot output is missing or empty.", { outputPath, sizeBytes });
      await this.cleanup(outputPath);
      throw new UserFacingError("SCREENSHOT_EMPTY_OUTPUT", CAPTURE_FAILED_HINT);
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

  /** Resolves the capture command from config or platform detection, caching the result. */
  private async resolveCommand(): Promise<CaptureCommand> {
    if (this.resolvedCommand !== undefined) {
      return this.resolvedCommand;
    }

    if (this.config !== undefined) {
      this.resolvedCommand = { command: this.config.command, args: this.config.args };
      return this.resolvedCommand;
    }

    if (process.platform === "darwin") {
      this.resolvedCommand = MACOS_COMMAND;
      return this.resolvedCommand;
    }

    if (process.platform === "linux") {
      const detected = await detectLinuxCommand();

      if (detected === undefined) {
        this.logger.error("No supported screenshot command found on PATH.");
        throw new UserFacingError("SCREENSHOT_NO_COMMAND", NO_COMMAND_HINT);
      }

      this.logger.info("Auto-detected screenshot command.", { command: detected.command });
      this.resolvedCommand = detected;
      return this.resolvedCommand;
    }

    this.logger.error("Unsupported platform for screenshots.", { platform: process.platform });
    throw new UserFacingError("SCREENSHOT_UNSUPPORTED_PLATFORM", UNSUPPORTED_PLATFORM_HINT);
  }
}

/** Substitutes {output} with the target path, or appends it when no placeholder is present. */
function buildArgs(template: readonly string[], outputPath: string): string[] {
  if (template.includes(OUTPUT_PLACEHOLDER)) {
    return template.map((arg) => (arg === OUTPUT_PLACEHOLDER ? outputPath : arg));
  }

  return [...template, outputPath];
}

/** Returns the first Linux candidate available on PATH, or undefined when none exist. */
async function detectLinuxCommand(): Promise<CaptureCommand | undefined> {
  for (const candidate of LINUX_CANDIDATES) {
    if (await isCommandAvailable(candidate.command)) {
      return candidate;
    }
  }

  return undefined;
}

/** Checks whether a command exists on PATH using `command -v`. */
async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync("/bin/sh", ["-c", `command -v ${command}`], {
      timeout: CAPTURE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
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
