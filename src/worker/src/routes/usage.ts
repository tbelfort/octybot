import { Hono } from "hono";
import type { HonoEnv } from "../types";

const app = new Hono<HonoEnv>();

const MAX_BATCH_ENTRIES = 50;

// POST / — batch log usage entries (from memory hooks)
app.post("/", async (c) => {
  let body: { entries?: Array<{ category: string; input_units?: number; output_units?: number; cost_usd: number }> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const entries = body.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return c.json({ error: "Missing entries array" }, 400);
  }

  if (entries.length > MAX_BATCH_ENTRIES) {
    return c.json({ error: `Too many entries (max ${MAX_BATCH_ENTRIES})` }, 400);
  }

  const now = new Date().toISOString();
  const stmt = c.env.DB.prepare(
    "INSERT INTO usage_logs (category, input_units, output_units, cost_usd, created_at) VALUES (?, ?, ?, ?, ?)"
  );

  const batch = entries.map((e) =>
    stmt.bind(e.category, e.input_units || 0, e.output_units || 0, e.cost_usd, now)
  );

  await c.env.DB.batch(batch);
  return c.json({ ok: true, inserted: entries.length });
});

// GET /daily — last 30 days grouped by date + category
app.get("/daily", async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT
      date(created_at) as date,
      category,
      SUM(input_units) as input_units,
      SUM(output_units) as output_units,
      SUM(cost_usd) as cost_usd,
      COUNT(*) as count
    FROM usage_logs
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY date(created_at), category
    ORDER BY date DESC, category
  `).all();

  return c.json({ rows: rows.results });
});

// GET /monthly — last 12 months grouped by month + category
app.get("/monthly", async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT
      strftime('%Y-%m', created_at) as month,
      category,
      SUM(input_units) as input_units,
      SUM(output_units) as output_units,
      SUM(cost_usd) as cost_usd,
      COUNT(*) as count
    FROM usage_logs
    WHERE created_at >= datetime('now', '-12 months')
    GROUP BY strftime('%Y-%m', created_at), category
    ORDER BY month DESC, category
  `).all();

  return c.json({ rows: rows.results });
});

export default app;
