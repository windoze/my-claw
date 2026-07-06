/** Scoped structured logger with conservative redaction for sensitive values. */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

/** Logger surface shared by application modules. */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

interface ConsoleSink {
  debug(message?: unknown, ...optionalParams: unknown[]): void;
  info(message?: unknown, ...optionalParams: unknown[]): void;
  warn(message?: unknown, ...optionalParams: unknown[]): void;
  error(message?: unknown, ...optionalParams: unknown[]): void;
}

export interface LoggerOptions {
  sink?: ConsoleSink;
  now?: () => Date;
}

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 25;
const MAX_OBJECT_KEYS = 40;
const MAX_STRING_LENGTH = 2_000;
const SENSITIVE_KEY_PATTERN =
  /(?:client[_-]?secret|secret|token|password|credential|authorization|api[_-]?key)/i;
const ENV_KEY_PATTERN = /^(?:env|environment|processEnv|process\.env)$/i;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(clientSecret|client_secret|accessToken|access_token|refreshToken|refresh_token|token|authorization|password|apiKey|api_key)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** Creates a logger whose lines include timestamp, level, scope, and message. */
export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? console;
  const now = options.now ?? (() => new Date());
  const normalizedScope = normalizeScope(scope);

  return {
    debug(message, context): void {
      writeLog(sink, now, "debug", normalizedScope, message, context);
    },
    info(message, context): void {
      writeLog(sink, now, "info", normalizedScope, message, context);
    },
    warn(message, context): void {
      writeLog(sink, now, "warn", normalizedScope, message, context);
    },
    error(message, context): void {
      writeLog(sink, now, "error", normalizedScope, message, context);
    },
  };
}

/** Redacts a string before it is included in a log line. */
export function redactLogString(value: string): string {
  return truncateString(value)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, key: string, separator: string) => {
      return `${key}${separator}${REDACTED}`;
    })
    .replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED}`);
}

function writeLog(
  sink: ConsoleSink,
  now: () => Date,
  level: LogLevel,
  scope: string,
  message: string,
  context?: LogContext,
): void {
  const baseLine = `${now().toISOString()} ${level.toUpperCase()} [${scope}] ${redactLogString(message)}`;
  const contextText = context === undefined ? "" : ` ${formatContext(context)}`;
  sink[level](`${baseLine}${contextText}`);
}

function formatContext(context: LogContext): string {
  return JSON.stringify(sanitizeValue(context, "context", 0, new WeakSet<object>()));
}

function normalizeScope(scope: string): string {
  const trimmedScope = scope.trim();
  return trimmedScope.length === 0 ? "app" : redactLogString(trimmedScope);
}

function sanitizeValue(
  value: unknown,
  key: string,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return REDACTED;
  }

  if (ENV_KEY_PATTERN.test(key)) {
    return "[REDACTED_ENV]";
  }

  if (typeof value === "string") {
    return redactLogString(value);
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }

  if (typeof value === "undefined") {
    return "[undefined]";
  }

  if (typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}]`;
  }

  if (value instanceof Error) {
    return sanitizeError(value, depth, seen);
  }

  if (depth >= MAX_DEPTH) {
    return "[MaxDepth]";
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return sanitizeArray(value, depth, seen);
  }

  return sanitizeObject(value as Record<string, unknown>, depth, seen);
}

function sanitizeError(error: Error, depth: number, seen: WeakSet<object>): LogContext {
  const details: LogContext = {
    name: error.name,
    message: redactLogString(error.message),
  };

  if (error.stack !== undefined) {
    details.stack = redactLogString(error.stack);
  }

  const code = readErrorProperty(error, "code");
  if (code !== undefined) {
    details.code = sanitizeValue(code, "code", depth + 1, seen);
  }

  const safeMessage = readErrorProperty(error, "safeMessage");
  if (safeMessage !== undefined) {
    details.safeMessage = sanitizeValue(safeMessage, "safeMessage", depth + 1, seen);
  }

  if (error.cause !== undefined) {
    details.cause = sanitizeValue(error.cause, "cause", depth + 1, seen);
  }

  return details;
}

function sanitizeArray(values: unknown[], depth: number, seen: WeakSet<object>): unknown[] {
  const limitedValues = values
    .slice(0, MAX_ARRAY_ITEMS)
    .map((item, index) => sanitizeValue(item, String(index), depth + 1, seen));

  if (values.length > MAX_ARRAY_ITEMS) {
    limitedValues.push(`[${values.length - MAX_ARRAY_ITEMS} more items]`);
  }

  return limitedValues;
}

function sanitizeObject(
  value: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
): LogContext {
  const details: LogContext = {};
  const entries = Object.entries(value);

  for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
    details[key] = sanitizeValue(item, key, depth + 1, seen);
  }

  if (entries.length > MAX_OBJECT_KEYS) {
    details.truncated = `${entries.length - MAX_OBJECT_KEYS} more keys`;
  }

  return details;
}

function readErrorProperty(error: Error, propertyName: string): unknown {
  return Reflect.get(error, propertyName);
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
}
