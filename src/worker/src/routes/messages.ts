import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { HonoEnv, MessageRow, ChunkRow, ConversationRow } from "../types";

const app = new Hono<HonoEnv>();

// GET /messages/pending — agent polls for work
app.get("/pending", async (c) => {
  // Find oldest pending assistant message
  const msg = await c.env.DB.prepare(
    "SELECT * FROM messages WHERE role = 'assistant' AND status = 'pending' ORDER BY created_at ASC LIMIT 1"
  ).first<MessageRow>();

  if (!msg) {
    return new Response(null, { status: 204 });
  }

  // Get the user message that triggered it (most recent user msg before this assistant msg)
  const userMsg = await c.env.DB.prepare(
    "SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' AND created_at <= ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(msg.conversation_id, msg.created_at)
    .first<{ content: string }>();

  // Get conversation for session ID and model
  const conv = await c.env.DB.prepare(
    "SELECT claude_session_id, model FROM conversations WHERE id = ?"
  )
    .bind(msg.conversation_id)
    .first<{ claude_session_id: string | null; model: string }>();

  const model = conv?.model || "opus";

  // Mark as streaming
  await c.env.DB.prepare(
    "UPDATE messages SET status = 'streaming', updated_at = ? WHERE id = ?"
  )
    .bind(new Date().toISOString(), msg.id)
    .run();

  return c.json({
    message_id: msg.id,
    conversation_id: msg.conversation_id,
    user_content: userMsg?.content ?? "",
    claude_session_id: conv?.claude_session_id ?? null,
    model,
  });
});

// POST /messages/:id/chunks — agent posts response chunks
app.post("/:id/chunks", async (c) => {
  const msgId = c.req.param("id");
  const body = await c.req.json<{
    sequence: number;
    text: string;
    type?: string;
    is_final?: boolean;
  }>();

  const now = new Date().toISOString();
  const chunkType = body.type || "text";

  await c.env.DB.prepare(
    "INSERT INTO chunks (message_id, sequence, text, type, is_final, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(msgId, body.sequence, body.text, chunkType, body.is_final ? 1 : 0, now)
    .run();

  if (body.is_final) {
    // Assemble full content from text chunks only
    const { results: allChunks } = await c.env.DB.prepare(
      "SELECT text FROM chunks WHERE message_id = ? AND type = 'text' ORDER BY sequence ASC"
    )
      .bind(msgId)
      .all<{ text: string }>();

    const fullContent = (allChunks ?? []).map((ch) => ch.text).join("");

    await c.env.DB.prepare(
      "UPDATE messages SET content = ?, status = 'done', updated_at = ? WHERE id = ?"
    )
      .bind(fullContent, now, msgId)
      .run();
  }

  return c.json({ ok: true });
});

// POST /messages/:id/session — agent sets claude session ID
app.post("/:id/session", async (c) => {
  const msgId = c.req.param("id");
  const body = await c.req.json<{ session_id: string }>();

  // Get conversation ID from message
  const msg = await c.env.DB.prepare(
    "SELECT conversation_id FROM messages WHERE id = ?"
  )
    .bind(msgId)
    .first<{ conversation_id: string }>();

  if (!msg) return c.json({ error: "Message not found" }, 404);

  await c.env.DB.prepare(
    "UPDATE conversations SET claude_session_id = ?, updated_at = ? WHERE id = ?"
  )
    .bind(body.session_id, new Date().toISOString(), msg.conversation_id)
    .run();

  return c.json({ ok: true });
});

// POST /messages/:id/error — agent reports error
app.post("/:id/error", async (c) => {
  const msgId = c.req.param("id");
  const body = await c.req.json<{ error: string }>();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    "UPDATE messages SET content = ?, status = 'error', updated_at = ? WHERE id = ?"
  )
    .bind(body.error || "Unknown error", now, msgId)
    .run();

  return c.json({ ok: true });
});

// GET /messages/:id/stream — SSE for phone to stream response
app.get("/:id/stream", async (c) => {
  const msgId = c.req.param("id");

  return streamSSE(c, async (stream) => {
    let lastSeq = -1;
    const startTime = Date.now();
    const TIMEOUT = 60_000;

    while (Date.now() - startTime < TIMEOUT) {
      const { results: chunks } = await c.env.DB.prepare(
        "SELECT sequence, text, type, is_final FROM chunks WHERE message_id = ? AND sequence > ? ORDER BY sequence ASC"
      )
        .bind(msgId, lastSeq)
        .all<{ sequence: number; text: string; type: string; is_final: number }>();

      if (chunks && chunks.length > 0) {
        for (const chunk of chunks) {
          await stream.writeSSE({
            event: "chunk",
            data: JSON.stringify({
              sequence: chunk.sequence,
              text: chunk.text,
              type: chunk.type || "text",
              is_final: !!chunk.is_final,
            }),
          });
          lastSeq = chunk.sequence;

          if (chunk.is_final) {
            await stream.writeSSE({ event: "done", data: "" });
            return;
          }
        }
      }

      // Check if message errored
      const msg = await c.env.DB.prepare(
        "SELECT status FROM messages WHERE id = ?"
      )
        .bind(msgId)
        .first<{ status: string }>();

      if (msg?.status === "error") {
        await stream.writeSSE({
          event: "error",
          data: "Message processing failed",
        });
        return;
      }

      await stream.sleep(300);
    }

    // Timeout
    await stream.writeSSE({ event: "error", data: "Stream timeout" });
  });
});

export default app;
