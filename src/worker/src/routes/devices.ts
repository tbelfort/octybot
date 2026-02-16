import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { generatePairingCode, signJWT } from "../utils/jwt";

const app = new Hono<HonoEnv>();

// POST /devices/register — agent registers, gets pairing code
app.post("/register", async (c) => {
  const body = await c.req
    .json<{ device_name?: string }>()
    .catch(() => ({ device_name: undefined }));

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min

  await c.env.DB.prepare(
    "INSERT INTO devices (id, device_type, device_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, "agent", body.device_name || "Home Agent", now, now)
    .run();

  await c.env.DB.prepare(
    "INSERT INTO pairing_codes (code, device_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)"
  )
    .bind(code, id, expiresAt, now)
    .run();

  return c.json({ device_id: id, code, expires_at: expiresAt }, 201);
});

// GET /devices/:id/status — agent polls until paired, gets JWT
app.get("/:id/status", async (c) => {
  const deviceId = c.req.param("id");

  const device = await c.env.DB.prepare(
    "SELECT id FROM devices WHERE id = ?"
  )
    .bind(deviceId)
    .first();

  if (!device) return c.json({ error: "Device not found" }, 404);

  // Check if a pairing code for this device has been used
  const pairing = await c.env.DB.prepare(
    "SELECT code, used FROM pairing_codes WHERE device_id = ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(deviceId)
    .first<{ code: string; used: number }>();

  if (!pairing) return c.json({ error: "No pairing code found" }, 404);

  if (!pairing.used) {
    return c.json({ status: "waiting" });
  }

  // Paired — issue JWT for the agent
  const token = await signJWT(
    { sub: deviceId, type: "agent" },
    c.env.JWT_SECRET
  );

  // Update last_seen
  await c.env.DB.prepare(
    "UPDATE devices SET last_seen_at = ? WHERE id = ?"
  )
    .bind(new Date().toISOString(), deviceId)
    .run();

  return c.json({ status: "paired", token });
});

// POST /devices/pair — PWA submits code, gets JWT
app.post("/pair", async (c) => {
  const body = await c.req.json<{ code: string }>();
  const code = body.code?.trim().toUpperCase();

  if (!code) return c.json({ error: "Code is required" }, 400);

  const pairing = await c.env.DB.prepare(
    "SELECT code, device_id, expires_at, used FROM pairing_codes WHERE code = ?"
  )
    .bind(code)
    .first<{ code: string; device_id: string; expires_at: string; used: number }>();

  if (!pairing) return c.json({ error: "Invalid pairing code" }, 404);
  if (pairing.used) return c.json({ error: "Code already used" }, 410);
  if (new Date(pairing.expires_at) < new Date()) {
    return c.json({ error: "Code expired" }, 410);
  }

  // Mark code as used
  await c.env.DB.prepare(
    "UPDATE pairing_codes SET used = 1 WHERE code = ?"
  )
    .bind(code)
    .run();

  // Create PWA device record
  const pwaDeviceId = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    "INSERT INTO devices (id, device_type, device_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(pwaDeviceId, "pwa", "Phone", now, now)
    .run();

  // Issue JWT for the PWA
  const token = await signJWT(
    { sub: pwaDeviceId, type: "pwa" },
    c.env.JWT_SECRET
  );

  return c.json({ token, device_id: pwaDeviceId });
});

export default app;
