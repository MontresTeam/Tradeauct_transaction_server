import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { isAppError } from "../errors/AppError.js";
import { logger } from "../logger.js";

/**
 * One response envelope for the whole server: `{ error: { code, message } }`.
 *
 * Messages are deliberately terse. An internal caller gets the code it needs
 * to branch on; it does not get Stripe internals, Prisma text or stack frames,
 * which have a way of ending up in a browser.
 */
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (isAppError(err)) {
    // 401/403 on /internal means someone is calling this server without a
    // valid signature. That is worth a log line every time.
    const level = err.statusCode >= 500 || err.statusCode === 401 || err.statusCode === 403 ? "warn" : "info";
    logger[level]("Request failed", {
      code: err.errorCode,
      status: err.statusCode,
      path: req.path,
      method: req.method,
      message: err.message,
    });

    res.status(err.statusCode).json({
      error: { code: err.errorCode, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: err.flatten(),
      },
    });
    return;
  }

  logger.error("Unhandled error", { path: req.path, method: req.method, error: err });
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
};

export const notFoundHandler: RequestHandler = (req: Request, res: Response): void => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `Route not found: ${req.method} ${req.path}` } });
};
