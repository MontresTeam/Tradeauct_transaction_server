/** Expected, reportable failure with an HTTP status and a stable error code. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly errorCode: string;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, errorCode = "APP_ERROR", details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
