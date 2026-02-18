import { Hono } from "hono";
import type { HonoEnv, ProjectRow, AgentRow } from "../types";

const app = new Hono<HonoEnv>();

// GET / — list all projects
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM projects ORDER BY created_at DESC"
  ).all<ProjectRow>();

  const projects = (rows.results || []).map((p) => ({
    name: p.name,
    created_at: p.created_at,
    config: p.config ? JSON.parse(p.config) : {},
  }));

  return c.json({ projects });
});

// POST / — create a new project
app.post("/", async (c) => {
  const body = await c.req.json<{ name: string; working_dir?: string }>().catch(() => null);
  if (!body?.name) {
    return c.json({ error: "Project name required" }, 400);
  }

  const name = body.name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!name) {
    return c.json({ error: "Invalid project name" }, 400);
  }

  const now = new Date().toISOString();
  const config: Record<string, unknown> = {};
  if (body.working_dir?.trim()) {
    config.working_dir = body.working_dir.trim();
  }

  try {
    await c.env.DB.prepare(
      "INSERT INTO projects (name, created_at, config) VALUES (?, ?, ?)"
    )
      .bind(name, now, JSON.stringify(config))
      .run();
  } catch (err: any) {
    if (err.message?.includes("UNIQUE")) {
      return c.json({ error: "Project already exists" }, 409);
    }
    throw err;
  }

  // Create default agent
  const agentId = `${name}/default`;
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO agents (id, project_name, agent_name, created_at) VALUES (?, ?, 'default', ?)"
  )
    .bind(agentId, name, now)
    .run();

  return c.json({ name, created_at: now }, 201);
});

// GET /:name/agents — list agents for a project
app.get("/:name/agents", async (c) => {
  const projectName = c.req.param("name");

  const rows = await c.env.DB.prepare(
    "SELECT * FROM agents WHERE project_name = ? ORDER BY created_at ASC"
  )
    .bind(projectName)
    .all<AgentRow>();

  return c.json({ agents: rows.results || [] });
});

// POST /:name/agents — create a new agent for a project
app.post("/:name/agents", async (c) => {
  const projectName = c.req.param("name");
  const body = await c.req.json<{ agent_name: string }>().catch(() => null);

  if (!body?.agent_name) {
    return c.json({ error: "Agent name required" }, 400);
  }

  const agentName = body.agent_name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!agentName) {
    return c.json({ error: "Invalid agent name" }, 400);
  }

  // Check project exists
  const project = await c.env.DB.prepare(
    "SELECT name FROM projects WHERE name = ?"
  )
    .bind(projectName)
    .first<ProjectRow>();

  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  const now = new Date().toISOString();
  const agentId = `${projectName}/${agentName}`;

  try {
    await c.env.DB.prepare(
      "INSERT INTO agents (id, project_name, agent_name, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(agentId, projectName, agentName, now)
      .run();
  } catch (err: any) {
    if (err.message?.includes("UNIQUE")) {
      return c.json({ error: "Agent already exists" }, 409);
    }
    throw err;
  }

  return c.json({ id: agentId, project_name: projectName, agent_name: agentName, created_at: now }, 201);
});

// PATCH /:name — update project config
app.patch("/:name", async (c) => {
  const projectName = c.req.param("name");
  const body = await c.req.json<{ config?: Record<string, unknown> }>().catch(() => null);

  if (!body) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const project = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE name = ?"
  )
    .bind(projectName)
    .first<ProjectRow>();

  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  if (body.config) {
    const existingConfig = project.config ? JSON.parse(project.config) : {};
    const mergedConfig = { ...existingConfig, ...body.config };
    await c.env.DB.prepare(
      "UPDATE projects SET config = ? WHERE name = ?"
    )
      .bind(JSON.stringify(mergedConfig), projectName)
      .run();
  }

  return c.json({ ok: true });
});

// DELETE /:name — delete a project and its agents
app.delete("/:name", async (c) => {
  const projectName = c.req.param("name");

  await c.env.DB.prepare("DELETE FROM agents WHERE project_name = ?")
    .bind(projectName)
    .run();

  const { meta } = await c.env.DB.prepare("DELETE FROM projects WHERE name = ?")
    .bind(projectName)
    .run();

  if (!meta.changes) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json({ ok: true });
});

export default app;
