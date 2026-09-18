import type { NextFunction, Request, RequestHandler, Response } from "express";
import { newTraceId, withTrace } from "../logger.js";
import { TRACE_HEADER } from "../security/signing.js";

/**
 * Give every request a trace id and make it available to logs without
 * threading it through call signatures. The main server sends its own id when
 * it has one, so a single id spans both services.
 */
export const requestContext: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const incoming = req.headers[TRACE_HEADER];
  const traceId = typeof incoming === "string" && incoming ? incoming : newTraceId();

  res.setHeader(TRACE_HEADER, traceId);
  withTrace(traceId, () => {
    next();
  });
};
