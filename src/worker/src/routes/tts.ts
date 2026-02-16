import { Hono } from "hono";
import type { HonoEnv } from "../types";

const app = new Hono<HonoEnv>();

const MAX_TEXT = 4096;

app.get("/", (c) => {
  return c.json({ ok: true });
});

app.post("/", async (c) => {
  let body: { text?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const text = body.text;
  if (!text || typeof text !== "string" || !text.trim()) {
    return c.json({ error: "Missing text" }, 400);
  }
  if (text.length > MAX_TEXT) {
    return c.json({ error: `Text too long (max ${MAX_TEXT} chars)` }, 413);
  }

  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "coral",
      input: text.trim(),
      response_format: "mp3",
    }),
  });

  if (!resp.ok) {
    const status = resp.status;
    const body = await resp.text();
    console.error("OpenAI TTS error:", status, body);
    if (status === 429) return c.json({ error: "Rate limited, try again" }, 429);
    return c.json({ error: "TTS failed" }, 502);
  }

  // Log cost: gpt-4o-mini-tts $0.60/M input chars + $12.00/M output audio tokens
  // Estimate ~150 audio tokens per sentence, ~1 sentence per 80 chars
  const charCount = text.trim().length;
  const estimatedSentences = Math.max(1, Math.ceil(charCount / 80));
  const estimatedAudioTokens = estimatedSentences * 150;
  const cost = (charCount * 0.60 + estimatedAudioTokens * 12.00) / 1_000_000;
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      "INSERT INTO usage_logs (category, input_units, output_units, cost_usd, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind("tts", charCount, estimatedAudioTokens, cost, new Date().toISOString()).run().catch(() => {})
  );

  return new Response(resp.body, {
    headers: { "Content-Type": "audio/mpeg" },
  });
});

export default app;
