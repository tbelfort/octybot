import { Hono } from "hono";
import type { HonoEnv, SettingsRow } from "../types";

const app = new Hono<HonoEnv>();

const ALLOWED_KEYS: Record<string, { min: number; max: number }> = {
  process_idle_timeout_hours: { min: 1, max: 168 },
  process_pool_max: { min: 1, max: 10 },
};

// GET /settings — return all settings as { key: value } map
app.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT key, value FROM settings"
  ).all<SettingsRow>();

  const settings: Record<string, string> = {};
  for (const row of results ?? []) {
    settings[row.key] = row.value;
  }

  return c.json({ settings });
});

// PATCH /settings — update a single setting
app.patch("/", async (c) => {
  const body = await c.req.json<{ key: string; value: string }>().catch(() => ({
    key: "",
    value: "",
  }));

  const rule = ALLOWED_KEYS[body.key];
  if (!rule) {
    return c.json({ error: `Unknown setting: ${body.key}` }, 400);
  }

  const num = Number(body.value);
  if (!Number.isInteger(num) || num < rule.min || num > rule.max) {
    return c.json({ error: `Value must be an integer between ${rule.min} and ${rule.max}` }, 400);
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(body.key, String(num), now)
    .run();

  return c.json({ key: body.key, value: String(num) });
});

export default app;
