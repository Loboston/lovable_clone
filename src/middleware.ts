import { createMiddleware } from "hono/factory";
import { verifyJWT, getBearerToken } from "./auth";
import type { Env, JWTPayload } from "./types";

export function authMiddleware() {
  return createMiddleware<{ Bindings: Env; Variables: { user: JWTPayload } }>(
    async (c, next) => {
      const token = getBearerToken(c.req.raw);
      if (!token) {
        return c.json({ error: "Missing or invalid authorization" }, 401);
      }
      const secret = c.env.PLATFORM_JWT_SECRET;
      if (!secret) {
        return c.json({ error: "Server misconfiguration" }, 500);
      }
      const payload = await verifyJWT(token, secret);
      if (!payload) {
        return c.json({ error: "Invalid or expired token" }, 401);
      }
      c.set("user", payload);
      await next();
    }
  );
}
