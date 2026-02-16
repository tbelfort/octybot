import { Hono } from "hono";
import type { HonoEnv, ConversationRow, MessageRow } from "../types";

const app = new Hono<HonoEnv>();

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

// GET /conversations — list all
app.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM conversations ORDER BY updated_at DESC"
  ).all<ConversationRow>();

  return c.json({ conversations: results ?? [] });
});

// POST /conversations — create new
app.post("/", async (c) => {
  const body = await c.req.json<{ title?: string }>().catch(() => ({ title: undefined }));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const title = body.title || "New Chat";

  await c.env.DB.prepare(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
  )
    .bind(id, title, now, now)
    .run();

  return c.json({ id, title, created_at: now }, 201);
});

// GET /conversations/:id — get with messages
app.get("/:id", async (c) => {
  const id = c.req.param("id");

  const conv = await c.env.DB.prepare(
    "SELECT * FROM conversations WHERE id = ?"
  )
    .bind(id)
    .first<ConversationRow>();

  if (!conv) return c.json({ error: "Conversation not found" }, 404);

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

  const conv = await c.env.DB.prepare(
    "SELECT id FROM conversations WHERE id = ?"
  )
    .bind(id)
    .first();

  if (!conv) return c.json({ error: "Conversation not found" }, 404);

  // Delete chunks for all messages in conversation
  await c.env.DB.prepare(
    "DELETE FROM chunks WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)"
  )
    .bind(id)
    .run();

  await c.env.DB.prepare("DELETE FROM messages WHERE conversation_id = ?")
    .bind(id)
    .run();

  await c.env.DB.prepare("DELETE FROM conversations WHERE id = ?")
    .bind(id)
    .run();

  return c.json({ deleted: true });
});

// PATCH /conversations/:id — rename conversation
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ title?: string }>().catch(() => ({}));
  const title = body.title?.trim();

  if (!title) return c.json({ error: "title is required" }, 400);

  const conv = await c.env.DB.prepare(
    "SELECT id FROM conversations WHERE id = ?"
  )
    .bind(id)
    .first();

  if (!conv) return c.json({ error: "Conversation not found" }, 404);

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

  const conv = await c.env.DB.prepare(
    "SELECT id FROM conversations WHERE id = ?"
  )
    .bind(convId)
    .first();

  if (!conv) return c.json({ error: "Conversation not found" }, 404);

  const body = await c.req.json<{ content: string }>();
  if (!body.content?.trim()) {
    return c.json({ error: "content is required" }, 400);
  }

  const now = new Date().toISOString();
  const userMsgId = crypto.randomUUID();
  const assistantMsgId = crypto.randomUUID();

  // Create user message (done)
  await c.env.DB.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(userMsgId, convId, "user", body.content.trim(), "done", now, now)
    .run();

  // Create pending assistant message
  await c.env.DB.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(assistantMsgId, convId, "assistant", "", "pending", now, now)
    .run();

  // Update conversation timestamp
  await c.env.DB.prepare(
    "UPDATE conversations SET updated_at = ? WHERE id = ?"
  )
    .bind(now, convId)
    .run();

  return c.json(
    {
      user_message_id: userMsgId,
      assistant_message_id: assistantMsgId,
    },
    201
  );
});

export default app;
