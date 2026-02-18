/**
 * Octybot — Cloudflare Worker relay
 *
 * Sits between the phone PWA and the home Mac agent.
 * Stores conversations/messages in D1, relays via polling + SSE.
 *
 * Routes:
 *   GET  /                            — health check (no auth)
 *   POST /devices/register            — agent registers, gets pairing code
 *   GET  /devices/:id/status          — agent polls until paired
 *   POST /devices/pair                — PWA submits code, gets JWT
 *   GET  /conversations               — list conversations
 *   POST /conversations               — create conversation
 *   GET  /conversations/:id           — get conversation + messages
 *   DELETE /conversations/:id         — delete conversation
 *   POST /conversations/:id/messages  — send user message
 *   GET  /messages/pending            — agent polls for work
 *   POST /messages/:id/chunks         — agent posts chunks
 *   POST /messages/:id/session        — agent sets session ID
 *   POST /messages/:id/error          — agent reports error
 *   GET  /messages/:id/stream         — SSE stream for phone
 *
 * Model tier names (opus/sonnet/haiku) are passed through to the
 * Claude CLI as-is — no API-based model resolution needed.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { HonoEnv } from "./types";
import { jwtAuth } from "./middleware/auth";
import { requireOpenAIKey } from "./middleware/openai";
import deviceRoutes from "./routes/devices";
import conversationRoutes from "./routes/conversations";
import messageRoutes from "./routes/messages";
import transcribeRoutes from "./routes/transcribe";
import ttsRoutes from "./routes/tts";
import usageRoutes from "./routes/usage";
import settingsRoutes from "./routes/settings";
import memoryRoutes from "./routes/memory";
import projectRoutes from "./routes/projects";

const app = new Hono<HonoEnv>();

// CORS — allow Pages domain + localhost
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "*";
      if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return origin;
      if (/^https:\/\/(octybot-pwa\.pages\.dev|[a-f0-9]+\.octybot-pwa\.pages\.dev)$/.test(origin)) return origin;
      return "";
    },
    exposeHeaders: ["X-Refresh-Token"],
  })
);

// Health check (no auth)
app.get("/", (c) => c.json({ service: "octybot", status: "ok" }));

// Device pairing routes (public, no auth)
app.route("/devices", deviceRoutes);

// JWT auth for all protected routes
app.use("/conversations/*", jwtAuth);
app.use("/messages/*", jwtAuth);
app.use("/transcribe", jwtAuth, requireOpenAIKey);
app.use("/tts", jwtAuth, requireOpenAIKey);
app.use("/usage/*", jwtAuth);
app.use("/usage", jwtAuth);
app.use("/settings/*", jwtAuth);
app.use("/settings", jwtAuth);
app.use("/memory/*", jwtAuth);
app.use("/memory", jwtAuth);
app.use("/projects/*", jwtAuth);
app.use("/projects", jwtAuth);

// Mount authenticated routes
app.route("/conversations", conversationRoutes);
app.route("/messages", messageRoutes);
app.route("/transcribe", transcribeRoutes);
app.route("/tts", ttsRoutes);
app.route("/usage", usageRoutes);
app.route("/settings", settingsRoutes);
app.route("/memory", memoryRoutes);
app.route("/projects", projectRoutes);

// 404
app.notFound((c) => c.json({ error: "Not found" }, 404));

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
