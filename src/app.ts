import express from "express";
import helmet from "helmet";
import type { Env } from "./core/env.js";
import { errorHandler, notFoundHandler } from "./core/middleware/errorHandler.js";
import { requestContext } from "./core/middleware/requestContext.js";
import { registerModules } from "./modules/registerModules.js";

/**
 * There is deliberately no CORS middleware.
 *
 * Nothing in a browser may call this server: buyers, sellers and admins all go
 * through the main server, and Stripe posts server-to-server. Without an
 * `Access-Control-Allow-Origin` header, a page that tries anyway is stopped by
 * the browser before the request is even sent.
 */
export function createApp(env: Env): express.Express {
  const app = express();

  app.disable("x-powered-by");
  if (env.TRUST_PROXY) {
    app.set("trust proxy", 1);
  }

  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-origin" } }));
  app.use(requestContext);

  /**
   * Every body is captured raw and parsed from that same buffer.
   *
   * Stripe signs the exact bytes it sends, and so does the main server, so a
   * re-serialised body would fail both checks. Keeping one raw buffer for the
   * whole server means no route can accidentally verify a signature against a
   * round-tripped copy of the payload.
   */
  app.use(
    express.json({
      limit: "2mb",
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = Buffer.from(buf);
      },
      // Stripe posts application/json; the main server does too. Anything
      // else is parsed as an empty body and will fail signature verification.
      type: ["application/json", "application/*+json"],
    }),
  );

  registerModules(app, env);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
