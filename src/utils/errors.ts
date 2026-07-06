/** Shared application error types with stable codes and user-safe messages. */

/** Options accepted by application error constructors. */
export interface AppErrorOptions {
  cause?: unknown;
  safeMessage?: string;
}

/** Base error for failures that need a stable machine-readable category. */
export class AppError extends Error {
  public readonly code: string;
  public readonly safeMessage?: string;

  public constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.safeMessage = options.safeMessage;

    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Error whose safe message may be shown directly to a DingTalk user. */
export class UserFacingError extends AppError {
  public constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(code, message, {
      ...options,
      safeMessage: options.safeMessage ?? message,
    });
  }
}

/** Checks whether an unknown thrown value is one of the project error types. */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
