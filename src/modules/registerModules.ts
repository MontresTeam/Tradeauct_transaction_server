import type { Express } from "express";
import type { Env } from "../core/env.js";
import { createSecurity } from "../core/security/index.js";
import { registerGatewayModule } from "./gateway/gateway.routes.js";
import { registerHealthModule } from "./health/health.routes.js";
import { registerInternalModule } from "./internal/internal.routes.js";

/**
 * Composition root, mirroring TradeAuct_backend_server: each module exposes a
 * `register<Name>Module(app, env, ...)` and mounts its own router.
 */
export function registerModules(app: Express, env: Env): void {
  const security = createSecurity(env);

  registerHealthModule(app, env);
  registerGatewayModule(app, env);
  registerInternalModule(app, env, security);
}
