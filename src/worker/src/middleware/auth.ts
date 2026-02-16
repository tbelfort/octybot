import { createMiddleware } from "hono/factory";
import type { HonoEnv } from "../types";
import { verifyJWT, signJWT } from "../utils/jwt";

const REFRESH_THRESHOLD_SECONDS = 7 * 86400;

export const jwtAuth = createMiddleware<HonoEnv>(
  async (c, next) => {
    // Extract token from Authorization header or query param
    const authHeader = c.req.header("Authorization");
    let token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!token) {
      token = c.req.query("token") || null;
    }

    if (!token) {
      return c.json({ error: "Missing authentication token" }, 401);
    }

    const payload = await verifyJWT(token, c.env.JWT_SECRET);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 403);
    }

    // Store device info on context for downstream routes
    c.set("deviceId", payload.sub);
    c.set("deviceType", payload.type);

    await next();

    // Auto-refresh: if token expires within 7 days, issue a new one
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp - now < REFRESH_THRESHOLD_SECONDS) {
      const newToken = await signJWT(
        { sub: payload.sub, type: payload.type },
        c.env.JWT_SECRET
      );
      c.header("X-Refresh-Token", newToken);
    }
  }
);
