/** Directory allowlist policy used before opening local Agent working directories. */

import {
  isPathInside,
  PathResolutionError,
  type PathResolutionErrorCode,
  realpathDir,
  resolveUserPath,
} from "../utils/path.js";
import { UserFacingError } from "../utils/errors.js";

/** Options for resolving user-provided paths before policy checks. */
export interface PathPolicyOptions {
  baseDir?: string;
}

/** Error categories produced by directory allowlist enforcement. */
export type PathPolicyErrorCode =
  | PathResolutionErrorCode
  | "PATH_OUTSIDE_ALLOWED_ROOTS"
  | "PATH_ALLOWED_ROOTS_EMPTY";

/** Error raised when a directory cannot be used under the configured path policy. */
export class PathPolicyError extends UserFacingError {
  public readonly code: PathPolicyErrorCode;
  public readonly inputPath: string;
  public readonly resolvedPath?: string;

  public constructor(
    code: PathPolicyErrorCode,
    message: string,
    inputPath: string,
    resolvedPath?: string,
    cause?: unknown,
  ) {
    super(code, message, { cause });
    this.name = "PathPolicyError";
    this.code = code;
    this.inputPath = inputPath;
    this.resolvedPath = resolvedPath;
  }
}

/** Holds realpathed allowed roots and validates requested directories against them. */
export class PathPolicy {
  public readonly allowedRootDirs: readonly string[];

  private constructor(allowedRootDirs: readonly string[]) {
    this.allowedRootDirs = allowedRootDirs;
  }

  /** Builds a policy by resolving every configured allowed root to a real directory. */
  public static async create(
    allowedRootDirs: readonly string[],
    options: PathPolicyOptions = {},
  ): Promise<PathPolicy> {
    if (allowedRootDirs.length === 0) {
      throw new PathPolicyError(
        "PATH_ALLOWED_ROOTS_EMPTY",
        "At least one allowed root directory must be configured.",
        "",
      );
    }

    const normalizedAllowedRootDirs: string[] = [];

    for (const allowedRootDir of allowedRootDirs) {
      const resolvedAllowedRootDir = await normalizeAllowedRootDir(allowedRootDir, options);

      if (!normalizedAllowedRootDirs.includes(resolvedAllowedRootDir)) {
        normalizedAllowedRootDirs.push(resolvedAllowedRootDir);
      }
    }

    return new PathPolicy(normalizedAllowedRootDirs);
  }

  /** Resolves a requested directory, follows symlinks, and returns its allowed realpath. */
  public async assertAllowedDir(
    dir: string,
    options: PathPolicyOptions = {},
  ): Promise<string> {
    const resolvedDir = resolveUserPath(dir, options.baseDir);
    const realDir = await realpathPolicyDir(dir, resolvedDir, "Directory");

    if (!this.isAllowedRealDir(realDir)) {
      throw new PathPolicyError(
        "PATH_OUTSIDE_ALLOWED_ROOTS",
        [
          `Directory is not under an allowed root: ${realDir}`,
          `Allowed roots: ${this.allowedRootDirs.join(", ")}`,
        ].join("\n"),
        dir,
        realDir,
      );
    }

    return realDir;
  }

  /** Checks an already-realpathed directory against the policy without touching the filesystem. */
  public isAllowedRealDir(realDir: string): boolean {
    return this.allowedRootDirs.some((allowedRootDir) =>
      isPathInside(realDir, allowedRootDir),
    );
  }
}

/** Resolves and validates a configured allowed root directory. */
async function normalizeAllowedRootDir(
  allowedRootDir: string,
  options: PathPolicyOptions,
): Promise<string> {
  const resolvedAllowedRootDir = resolveUserPath(allowedRootDir, options.baseDir);
  return realpathPolicyDir(allowedRootDir, resolvedAllowedRootDir, "Allowed root directory");
}

/** Converts low-level directory resolution failures into policy errors with stable messages. */
async function realpathPolicyDir(
  inputPath: string,
  resolvedPath: string,
  subject: string,
): Promise<string> {
  try {
    return await realpathDir(resolvedPath);
  } catch (error: unknown) {
    if (error instanceof PathResolutionError) {
      throw new PathPolicyError(
        error.code,
        formatPathResolutionMessage(subject, inputPath, error),
        inputPath,
        error.resolvedPath,
        error,
      );
    }

    throw error;
  }
}

/** Formats directory errors so missing, non-directory, and inaccessible paths are distinct. */
function formatPathResolutionMessage(
  subject: string,
  inputPath: string,
  error: PathResolutionError,
): string {
  switch (error.code) {
    case "PATH_NOT_FOUND":
      return `${subject} does not exist: ${inputPath}`;
    case "PATH_NOT_DIRECTORY":
      return `${subject} is not a directory: ${inputPath}`;
    case "PATH_NOT_ACCESSIBLE":
      return `Unable to access ${subject.toLowerCase()}: ${inputPath}`;
  }
}
