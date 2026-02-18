import { Hono } from "hono";
import type { HonoEnv, SettingsRow } from "../types";

const app = new Hono<HonoEnv>();

const NUMERIC_KEYS: Record<string, { min: number; max: number }> = {
  process_idle_timeout_hours: { min: 1, max: 168 },
  process_pool_max: { min: 1, max: 10 },
  memory_enabled: { min: 0, max: 1 },
};

const STRING_KEYS = new Set(["active_project", "active_agent"]);
const STRING_MAX_LENGTH = 64;

// Path keys: allow filesystem paths (slashes, dots, tildes) and empty values (to clear)
const PATH_KEYS = new Set(["snapshot_dir", "snapshot_dir_effective"]);
const PATH_MAX_LENGTH = 512;

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

  const numericRule = NUMERIC_KEYS[body.key];
  const isStringKey = STRING_KEYS.has(body.key);
  const isPathKey = PATH_KEYS.has(body.key);

  if (!numericRule && !isStringKey && !isPathKey) {
    return c.json({ error: `Unknown setting: ${body.key}` }, 400);
  }

  let sanitized: string;

  if (numericRule) {
    const num = Number(body.value);
    if (!Number.isInteger(num) || num < numericRule.min || num > numericRule.max) {
      return c.json({ error: `Value must be an integer between ${numericRule.min} and ${numericRule.max}` }, 400);
    }
    sanitized = String(num);
  } else if (isPathKey) {
    const str = String(body.value ?? "").trim();
    if (str.length > PATH_MAX_LENGTH) {
      return c.json({ error: `Path must be at most ${PATH_MAX_LENGTH} characters` }, 400);
    }
    sanitized = str;
  } else {
    const str = String(body.value).trim();
    if (!str || str.length > STRING_MAX_LENGTH) {
      return c.json({ error: `Value must be a non-empty string up to ${STRING_MAX_LENGTH} characters` }, 400);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(str)) {
      return c.json({ error: "Value must contain only alphanumeric characters, hyphens, and underscores" }, 400);
    }
    sanitized = str;
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(body.key, sanitized, now)
    .run();

  return c.json({ key: body.key, value: sanitized });
});

export default app;
