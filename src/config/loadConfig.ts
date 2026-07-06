/** Loads JSONC configuration files and validates them against the application schema. */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";

import { PathPolicy, PathPolicyError } from "../security/PathPolicy.js";
import { resolveUserPath } from "../utils/path.js";
import { appConfigSchema } from "./schema.js";
import type { AppConfig } from "./types.js";

export const CONFIG_ENV_VAR = "AGENT_DINGTALK_CONFIG";
export const DEFAULT_CONFIG_FILE_NAME = "agent-dingtalk.config.jsonc";
export const EXAMPLE_CONFIG_FILE_NAME = "agent-dingtalk.config.example.jsonc";

/** Options used to choose where configuration is loaded from. */
export interface LoadConfigOptions {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Error type for failures that should clearly identify the affected config file. */
export class ConfigLoadError extends Error {
  public readonly configPath: string;

  public constructor(message: string, configPath: string, cause?: unknown) {
    super(message);
    this.name = "ConfigLoadError";
    this.configPath = configPath;

    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** Loads, parses, validates, and default-fills the application configuration. */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  const configPath = resolveConfigPath(options);
  const source = await readConfigSource(configPath);
  const parsedConfig = parseJsoncConfig(source, configPath);
  const validatedConfig = validateConfig(parsedConfig, configPath);

  return normalizeConfigPaths(validatedConfig, configPath);
}

/** Resolves the effective config path from explicit options, environment, or defaults. */
export function resolveConfigPath(options: LoadConfigOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configuredPath =
    options.configPath ?? env[CONFIG_ENV_VAR] ?? DEFAULT_CONFIG_FILE_NAME;

  return resolveUserPath(configuredPath, cwd);
}

/** Reads the config file and turns missing-file errors into actionable guidance. */
async function readConfigSource(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, "utf8");
  } catch (error: unknown) {
    if (isErrorWithCode(error, "ENOENT")) {
      throw new ConfigLoadError(formatMissingConfigMessage(configPath), configPath, error);
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigLoadError(
      `Unable to read configuration file: ${configPath}\nReason: ${reason}`,
      configPath,
      error,
    );
  }
}

/** Parses JSONC and reports location-aware syntax errors. */
function parseJsoncConfig(source: string, configPath: string): unknown {
  const parseErrors: ParseError[] = [];
  const parsedConfig: unknown = parse(source, parseErrors, {
    allowTrailingComma: true,
  });

  if (parseErrors.length > 0) {
    throw new ConfigLoadError(
      [
        `Unable to parse configuration file: ${configPath}`,
        ...parseErrors.map((parseError) => formatParseError(source, parseError)),
      ].join("\n"),
      configPath,
    );
  }

  return parsedConfig;
}

/** Validates parsed JSONC data and formats every Zod issue with a field path. */
function validateConfig(parsedConfig: unknown, configPath: string): AppConfig {
  const result = appConfigSchema.safeParse(parsedConfig);

  if (!result.success) {
    throw new ConfigLoadError(
      [
        `Configuration validation failed for file: ${configPath}`,
        ...formatValidationIssues(result.error),
      ].join("\n"),
      configPath,
      result.error,
    );
  }

  const config: AppConfig = result.data;
  return config;
}

/** Normalizes configured directories and verifies the default cwd is allowlisted. */
async function normalizeConfigPaths(config: AppConfig, configPath: string): Promise<AppConfig> {
  const configDir = path.dirname(configPath);
  const pathPolicy = await mapPathPolicyError(
    "security.allowedRootDirs",
    configPath,
    () => PathPolicy.create(config.security.allowedRootDirs, { baseDir: configDir }),
  );
  const defaultCwd = await mapPathPolicyError(
    "defaultEnvironment.cwd",
    configPath,
    () => pathPolicy.assertAllowedDir(config.defaultEnvironment.cwd, { baseDir: configDir }),
  );

  return {
    ...config,
    defaultEnvironment: {
      ...config.defaultEnvironment,
      cwd: defaultCwd,
    },
    security: {
      ...config.security,
      allowedRootDirs: [...pathPolicy.allowedRootDirs],
    },
  };
}

/** Adds config-file context to path policy errors without hiding the precise reason. */
async function mapPathPolicyError<T>(
  fieldPath: string,
  configPath: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error: unknown) {
    if (error instanceof PathPolicyError) {
      throw new ConfigLoadError(
        [
          `Configuration path validation failed for file: ${configPath}`,
          ...formatConfigPathPolicyIssue(fieldPath, error),
        ].join("\n"),
        configPath,
        error,
      );
    }

    throw error;
  }
}

/** Formats JSONC parse errors with one-based line and column numbers. */
function formatParseError(source: string, parseError: ParseError): string {
  const location = getLineColumn(source, parseError.offset);
  const reason = printParseErrorCode(parseError.error);

  return `- line ${location.line}, column ${location.column}: ${reason}`;
}

/** Converts Zod validation issues into user-readable field-path messages. */
function formatValidationIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const fieldPath = formatIssuePath(issue.path);
    return `- ${fieldPath}: ${issue.message}`;
  });
}

/** Formats a path policy error under a config field path, preserving multiline details. */
function formatConfigPathPolicyIssue(
  fieldPath: string,
  error: PathPolicyError,
): string[] {
  const [firstLine = error.message, ...detailLines] = error.message.split("\n");

  return [
    `- ${fieldPath}: ${firstLine}`,
    ...detailLines.map((detailLine) => `  ${detailLine}`),
  ];
}

/** Builds a dot-and-index field path from a Zod issue path. */
function formatIssuePath(pathSegments: readonly PropertyKey[]): string {
  if (pathSegments.length === 0) {
    return "<root>";
  }

  return pathSegments.reduce<string>((fieldPath, segment) => {
    if (typeof segment === "number") {
      return `${fieldPath}[${segment}]`;
    }

    const segmentText = typeof segment === "symbol" ? segment.toString() : segment;
    return fieldPath.length === 0 ? segmentText : `${fieldPath}.${segmentText}`;
  }, "");
}

/** Calculates a one-based line and column pair for a character offset. */
function getLineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;

  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

/** Creates the required copy-example instruction when the default config is absent. */
function formatMissingConfigMessage(configPath: string): string {
  return [
    `Configuration file not found: ${configPath}`,
    `Copy ${EXAMPLE_CONFIG_FILE_NAME} to ${DEFAULT_CONFIG_FILE_NAME} and update the DingTalk credentials, or set ${CONFIG_ENV_VAR} to another JSONC config file path.`,
  ].join("\n");
}

/** Checks Node filesystem errors without losing the original error object. */
function isErrorWithCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && error.code === code;
}
