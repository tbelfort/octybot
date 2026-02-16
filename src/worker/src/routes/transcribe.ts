import { Hono } from "hono";
import type { HonoEnv } from "../types";

const app = new Hono<HonoEnv>();

const MAX_SIZE = 5 * 1024 * 1024; // 5MB

app.post("/", async (c) => {
  const contentLength = parseInt(c.req.header("content-length") || "0", 10);
  if (contentLength > MAX_SIZE) {
    return c.json({ error: "Audio too large (max 5MB)" }, 413);
  }

  const contentType = c.req.header("content-type") || "audio/webm";
  const audioBuffer = await c.req.arrayBuffer();

  if (audioBuffer.byteLength === 0) {
    return c.json({ error: "Empty audio" }, 400);
  }
  if (audioBuffer.byteLength > MAX_SIZE) {
    return c.json({ error: "Audio too large (max 5MB)" }, 413);
  }

  const ext = contentType.includes("mp4") ? "mp4" : "webm";
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: contentType }), `audio.${ext}`);
  form.append("model", "gpt-4o-transcribe");
  form.append("response_format", "text");
  form.append("language", "en");

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${c.env.OPENAI_API_KEY}` },
    body: form,
  });

  if (!resp.ok) {
    const status = resp.status;
    const body = await resp.text();
    console.error("OpenAI transcription error:", status, body);
    if (status === 429) return c.json({ error: "Rate limited, try again" }, 429);
    return c.json({ error: "Transcription failed" }, 502);
  }

  const text = (await resp.text()).trim();

  // Log cost: gpt-4o-transcribe ~$0.60/M input tokens, estimate from audio size
  // Rough estimate: 1 second of audio ≈ 50 tokens, 1MB webm ≈ 60s
  const estimatedSeconds = audioBuffer.byteLength / 16000; // rough bytes-to-seconds
  const estimatedTokens = estimatedSeconds * 50;
  const cost = (estimatedTokens * 0.60) / 1_000_000;
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      "INSERT INTO usage_logs (category, input_units, output_units, cost_usd, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind("transcribe", audioBuffer.byteLength, text.length, cost, new Date().toISOString()).run().catch(() => {})
  );

  return c.json({ text });
});

export default app;
