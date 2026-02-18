import { Hono } from "hono";
import type { HonoEnv, MemoryCommandRow } from "../types";

const app = new Hono<HonoEnv>();

const VALID_COMMANDS = new Set(["status", "backup", "freeze", "restore", "list", "clear", "browse_dir"]);
const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

// POST /command — PWA submits a memory command
app.post("/command", async (c) => {
  const body = await c.req.json<{
    command: string;
    args?: Record<string, unknown>;
    project?: string;
    agent?: string;
  }>().catch(() => null);
  if (!body || !VALID_COMMANDS.has(body.command)) {
    return c.json({ error: `Invalid command: ${body?.command || ""}` }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Include project/agent context in args so agent can target the right DB
  const args: Record<string, unknown> = { ...(body.args || {}) };
  if (body.project) args._project = body.project;
  if (body.agent) args._agent = body.agent;
  const argsJson = Object.keys(args).length > 0 ? JSON.stringify(args) : null;

  // Cancel older pending commands of the same type (prevent queue flooding)
  await c.env.DB.prepare(
    "UPDATE memory_commands SET status = 'error', result = '\"Superseded by newer command\"', updated_at = ? WHERE command = ? AND status IN ('pending', 'running') AND id != ?"
  )
    .bind(now, body.command, id)
    .run();

  await c.env.DB.prepare(
    "INSERT INTO memory_commands (id, command, args, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)"
  )
    .bind(id, body.command, argsJson, now, now)
    .run();

  return c.json({ id, command: body.command, status: "pending" }, 201);
});

// GET /commands/pending — Agent polls for next command
app.get("/commands/pending", async (c) => {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

  // Auto-expire stale pending/running commands older than 2 minutes
  await c.env.DB.prepare(
    "UPDATE memory_commands SET status = 'error', result = '\"Expired — agent did not respond\"', updated_at = ? WHERE status IN ('pending', 'running') AND created_at < ?"
  )
    .bind(now, cutoff)
    .run();

  const row = await c.env.DB.prepare(
    "SELECT * FROM memory_commands WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
  ).first<MemoryCommandRow>();

  if (!row) {
    return c.body(null, 204);
  }

  await c.env.DB.prepare(
    "UPDATE memory_commands SET status = 'running', updated_at = ? WHERE id = ?"
  )
    .bind(now, row.id)
    .run();

  return c.json({
    id: row.id,
    command: row.command,
    args: row.args ? JSON.parse(row.args) : null,
  });
});

// POST /commands/:id/result — Agent posts result
app.post("/commands/:id/result", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ status: string; result: unknown }>().catch(() => ({
    status: "error",
    result: "Invalid payload",
  }));

  const validStatus = body.status === "done" || body.status === "error";
  if (!validStatus) {
    return c.json({ error: "Status must be 'done' or 'error'" }, 400);
  }

  const now = new Date().toISOString();
  const { meta } = await c.env.DB.prepare(
    "UPDATE memory_commands SET status = ?, result = ?, updated_at = ? WHERE id = ?"
  )
    .bind(body.status, JSON.stringify(body.result), now, id)
    .run();

  if (!meta.changes) {
    return c.json({ error: "Command not found" }, 404);
  }

  return c.json({ ok: true });
});

// GET /commands/:id — PWA polls for result
app.get("/commands/:id", async (c) => {
  const id = c.req.param("id");

  const row = await c.env.DB.prepare(
    "SELECT * FROM memory_commands WHERE id = ?"
  )
    .bind(id)
    .first<MemoryCommandRow>();

  if (!row) {
    return c.json({ error: "Command not found" }, 404);
  }

  return c.json({
    id: row.id,
    command: row.command,
    status: row.status,
    result: row.result ? JSON.parse(row.result) : null,
  });
});

export default app;
