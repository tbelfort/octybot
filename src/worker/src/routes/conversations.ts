import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { HonoEnv, ConversationRow, MessageRow } from "../types";

const app = new Hono<HonoEnv>();

async function getConvOrThrow(db: D1Database, id: string): Promise<ConversationRow> {
  const conv = await db.prepare("SELECT * FROM conversations WHERE id = ?").bind(id).first<ConversationRow>();
  if (!conv) throw new HTTPException(404, { message: "Conversation not found" });
  return conv;
}

// GET /conversations/process/stop-requests — agent checks which conversations need process stopped
app.get("/process/stop-requests", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id FROM conversations WHERE process_stop_requested = 1"
  ).all<{ id: string }>();

  return c.json({ conversation_ids: (results ?? []).map((r) => r.id) });
});

// POST /conversations/process/clear-all — agent startup: reset all stale process state
app.post("/process/clear-all", async (c) => {
  await c.env.DB.prepare(
    "UPDATE conversations SET process_status = NULL, process_stop_requested = 0 WHERE process_status IS NOT NULL OR process_stop_requested = 1"
  ).run();

  return c.json({ cleared: true });
});

// GET /conversations — list all (optionally filtered by project)
app.get("/", async (c) => {
  const project = c.req.query("project");
  let results: ConversationRow[];

  if (project) {
    const resp = await c.env.DB.prepare(
      "SELECT * FROM conversations WHERE project_name = ? ORDER BY updated_at DESC"
    ).bind(project).all<ConversationRow>();
    results = resp.results ?? [];
  } else {
    const resp = await c.env.DB.prepare(
      "SELECT * FROM conversations ORDER BY updated_at DESC"
    ).all<ConversationRow>();
    results = resp.results ?? [];
  }

  return c.json({ conversations: results });
});

// POST /conversations — create new
app.post("/", async (c) => {
  const body = await c.req.json<{ title?: string; project_name?: string; agent_name?: string }>().catch(() => ({ title: undefined, project_name: undefined, agent_name: undefined }));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const title = body.title || "New Chat";
  const projectName = body.project_name || "default";
  const agentName = body.agent_name || "default";

  await c.env.DB.prepare(
    "INSERT INTO conversations (id, title, project_name, agent_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(id, title, projectName, agentName, now, now)
    .run();

  return c.json({ id, title, project_name: projectName, agent_name: agentName, created_at: now }, 201);
});

// GET /conversations/:id — get with messages
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const conv = await getConvOrThrow(c.env.DB, id);

  const { results: messages } = await c.env.DB.prepare(
    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
  )
    .bind(id)
    .all<MessageRow>();

  return c.json({ ...conv, messages: messages ?? [] });
});

// DELETE /conversations/:id — delete conversation + messages + chunks
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await getConvOrThrow(c.env.DB, id);

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM chunks WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)").bind(id),
    c.env.DB.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM conversations WHERE id = ?").bind(id),
  ]);

  return c.json({ deleted: true });
});

// PATCH /conversations/:id — rename conversation
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ title?: string }>().catch(() => ({}));
  const title = body.title?.trim();

  if (!title) return c.json({ error: "title is required" }, 400);

  await getConvOrThrow(c.env.DB, id);

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?"
  )
    .bind(title, now, id)
    .run();

  return c.json({ id, title, updated_at: now });
});

// PATCH /conversations/:id/process — agent reports process status
app.patch("/:id/process", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ status: string | null }>().catch(() => ({ status: null }));

  await c.env.DB.prepare(
    "UPDATE conversations SET process_status = ?, process_stop_requested = 0 WHERE id = ?"
  )
    .bind(body.status, id)
    .run();

  return c.json({ ok: true });
});

// POST /conversations/:id/process/stop — PWA requests process stop
app.post("/:id/process/stop", async (c) => {
  const id = c.req.param("id");

  await c.env.DB.prepare(
    "UPDATE conversations SET process_stop_requested = 1, process_status = NULL WHERE id = ?"
  )
    .bind(id)
    .run();

  return c.json({ ok: true });
});

// POST /conversations/:id/messages — send user message
app.post("/:id/messages", async (c) => {
  const convId = c.req.param("id");
  await getConvOrThrow(c.env.DB, convId);

  const body = await c.req.json<{ content: string }>();
  if (!body.content?.trim()) {
    return c.json({ error: "content is required" }, 400);
  }

  const now = new Date().toISOString();
  const userMsgId = crypto.randomUUID();
  const assistantMsgId = crypto.randomUUID();

  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(userMsgId, convId, "user", body.content.trim(), "done", now, now),
    c.env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(assistantMsgId, convId, "assistant", "", "pending", now, now),
    c.env.DB.prepare(
      "UPDATE conversations SET updated_at = ? WHERE id = ?"
    ).bind(now, convId),
  ]);

  return c.json(
    {
      user_message_id: userMsgId,
      assistant_message_id: assistantMsgId,
    },
    201
  );
});

export default app;
