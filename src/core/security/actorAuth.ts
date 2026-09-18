/**
 * Who the request is on behalf of.
 *
 * The main server forwards the end user's own access token in `X-TA-Actor`,
 * and this server verifies it independently. It deliberately does not accept a
 * buyer id in a body or a header: if it did, a compromised main server could
 * charge or read any account it liked, and the signed-service check above
 * would happily let it.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { AppError } from "../errors/AppError.js";
import { prisma } from "../prisma.js";
import { ACTOR_HEADER } from "./signing.js";

export type Actor = {
  userId: string;
  email: string;
  role: string;
};

declare module "express-serve-static-core" {
  interface Request {
    actor?: Actor;
    adminPermissions?: string[];
  }
}

export type ActorAuthConfig = {
  jwtSecret: string;
};

function verifyActorToken(token: string, secret: string): Actor {
  try {
    const decoded = jwt.verify(token, secret) as jwt.JwtPayload & {
      sub?: string;
      userId?: string;
      id?: string;
      email?: string;
      role?: string;
    };

    const userId = decoded.sub || decoded.userId || decoded.id;
    if (!userId) {
      throw new AppError(401, "Actor token has no subject", "ACTOR_TOKEN_INVALID");
    }

    return { userId, email: decoded.email || "", role: decoded.role || "BUYER" };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(401, "Actor token rejected", "ACTOR_TOKEN_INVALID");
  }
}

export function createActorAuthMiddleware(config: ActorAuthConfig) {
  const requireActor: RequestHandler = (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const token = req.headers[ACTOR_HEADER];
      if (typeof token !== "string" || !token) {
        throw new AppError(401, "Missing actor token", "ACTOR_TOKEN_MISSING");
      }
      req.actor = verifyActorToken(token, config.jwtSecret);
      next();
    } catch (error) {
      next(error);
    }
  };

  /**
   * Admin access tokens are signed with the same secret but carry a role, and
   * the permission set lives in the database — so it is read per request
   * rather than trusted from the token.
   */
  const requireAdminActor = (permission?: string): RequestHandler => {
    return (req: Request, res: Response, next: NextFunction): void => {
      void (async () => {
        try {
          await new Promise<void>((resolve, reject) => {
            requireActor(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
          });

          const admin = await prisma.adminUser.findUnique({
            where: { id: req.actor?.userId },
            include: { role: true },
          });

          if (!admin || !admin.isActive) {
            throw new AppError(403, "Admin account is not active", "ADMIN_FORBIDDEN");
          }

          const permissions = normalizePermissionSet(admin.role?.permissions);
          req.adminPermissions = [...permissions];

          if (permission && !permissions.has("*") && !permissions.has("all") && !permissions.has(permission)) {
            throw new AppError(403, "Missing permission for this operation", "ADMIN_PERMISSION_DENIED");
          }

          next();
        } catch (error) {
          next(error);
        }
      })();
    };
  };

  return { requireActor, requireAdminActor };
}

/** Mirrors the permission shapes accepted by TradeAuct_backend_server. */
export function normalizePermissionSet(permissions: unknown): Set<string> {
  if (permissions == null) return new Set();

  if (Array.isArray(permissions)) {
    return new Set(permissions.filter((item): item is string => typeof item === "string"));
  }

  if (typeof permissions === "object") {
    const set = new Set<string>();
    for (const [key, value] of Object.entries(permissions as Record<string, unknown>)) {
      if (value === true) {
        set.add(key);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") set.add(`${key}:${item}`);
        }
      } else if (typeof value === "object" && value !== null) {
        for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
          if (nestedValue === true) set.add(`${key}.${nestedKey}`);
        }
      }
    }
    return set;
  }

  return new Set();
}
