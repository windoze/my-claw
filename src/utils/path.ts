/** Filesystem path helpers shared by config loading and runtime security checks. */

import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import { AppError } from "./errors.js";

/** Error categories produced while resolving a user-provided directory path. */
export type PathResolutionErrorCode =
  | "PATH_NOT_FOUND"
  | "PATH_NOT_DIRECTORY"
  | "PATH_NOT_ACCESSIBLE";

/** Error raised when a path cannot be resolved to an existing directory. */
export class PathResolutionError extends AppError {
  public readonly code: PathResolutionErrorCode;
  public readonly inputPath: string;
  public readonly resolvedPath?: string;

  public constructor(
    code: PathResolutionErrorCode,
    message: string,
    inputPath: string,
    resolvedPath?: string,
    cause?: unknown,
  ) {
    super(code, message, { cause });
    this.name = "PathResolutionError";
    this.code = code;
    this.inputPath = inputPath;
    this.resolvedPath = resolvedPath;
  }
}

/** Expands a leading current-user home marker; named users such as `~alice` are not rewritten. */
export function expandHome(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return nodePath.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

/** Resolves absolute, relative, and home-based user paths against an optional base directory. */
export function resolveUserPath(inputPath: string, baseDir?: string): string {
  const expandedPath = expandHome(inputPath);

  if (nodePath.isAbsolute(expandedPath)) {
    return nodePath.resolve(expandedPath);
  }

  return nodePath.resolve(resolveBaseDir(baseDir), expandedPath);
}

/** Resolves an existing directory and follows symlinks to its real filesystem target. */
export async function realpathDir(inputPath: string): Promise<string> {
  const absolutePath = nodePath.resolve(inputPath);
  let resolvedPath: string;

  try {
    resolvedPath = await realpath(absolutePath);
  } catch (error: unknown) {
    throw createPathResolutionError(error, inputPath, absolutePath);
  }

  const stats = await statResolvedPath(resolvedPath, inputPath);

  if (!stats.isDirectory()) {
    throw new PathResolutionError(
      "PATH_NOT_DIRECTORY",
      `Path is not a directory: ${inputPath}`,
      inputPath,
      resolvedPath,
    );
  }

  return nodePath.resolve(resolvedPath);
}

/** Checks whether a normalized child path is equal to or contained inside a normalized parent path. */
export function isPathInside(childPath: string, parentPath: string): boolean {
  const normalizedChild = nodePath.resolve(childPath);
  const normalizedParent = nodePath.resolve(parentPath);
  const relativePath = nodePath.relative(normalizedParent, normalizedChild);

  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !nodePath.isAbsolute(relativePath))
  );
}

/** Resolves the base used for relative user paths. */
function resolveBaseDir(baseDir?: string): string {
  if (baseDir === undefined) {
    return process.cwd();
  }

  const expandedBaseDir = expandHome(baseDir);
  return nodePath.isAbsolute(expandedBaseDir)
    ? nodePath.resolve(expandedBaseDir)
    : nodePath.resolve(process.cwd(), expandedBaseDir);
}

/** Stats a resolved path while preserving clear user-facing path errors. */
async function statResolvedPath(resolvedPath: string, inputPath: string) {
  try {
    return await stat(resolvedPath);
  } catch (error: unknown) {
    throw createPathResolutionError(error, inputPath, resolvedPath);
  }
}

/** Converts Node filesystem errors into stable path-resolution error codes. */
function createPathResolutionError(
  error: unknown,
  inputPath: string,
  resolvedPath: string,
): PathResolutionError {
  if (isNodeErrorWithCode(error, "ENOENT") || isNodeErrorWithCode(error, "ENOTDIR")) {
    return new PathResolutionError(
      "PATH_NOT_FOUND",
      `Directory does not exist: ${inputPath}`,
      inputPath,
      resolvedPath,
      error,
    );
  }

  return new PathResolutionError(
    "PATH_NOT_ACCESSIBLE",
    `Unable to access directory: ${inputPath}`,
    inputPath,
    resolvedPath,
    error,
  );
}

/** Checks Node filesystem errors without assuming every thrown value is an Error. */
function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
