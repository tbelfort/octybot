# Phase 2: Bot → Agent

**Risk:** Low-Medium — touches many files but each change is a simple rename.
**Depends on:** Phase 1 (so we're editing clean, small files).
**Validation:** All endpoints work, PWA loads, memory hooks fire, curation benchmark passes.

## Goal

Replace the "bot" concept with "agent" everywhere. Create `agents.json` as the single source of truth for agent definitions. No new features — just terminology and schema alignment.

## 2.1 — Rename in Memory Config

**File:** `memory/config.ts` (176 lines)

| Old | New |
|-----|-----|
| `active_bot` | `active_agent` |
| `OCTYBOT_BOT` env var | `OCTYBOT_AGENT` |
| `getActiveBot()` | `getActiveAgent()` |
| `setActiveBot()` | `setActiveAgent()` |
| `BOT_NAME` | `AGENT_NAME` |
| `OctybotConfig.active_bot` | `OctybotConfig.active_agent` |

**Backwards compat:** Read `OCTYBOT_BOT` as fallback for one release cycle:
```typescript
export function getActiveAgent(): string {
  return process.env.OCTYBOT_AGENT || process.env.OCTYBOT_BOT || readConfigField("active_agent") || "default";
}
```

### Steps

1. Rename in `config.ts`.
2. Update all importers (hooks, install-global, db-manager, etc.).
3. Update `config.json` template in `install-global.ts`.

## 2.2 — Rename in Data Paths

**Current:** `~/.octybot/data/<project>/<bot>/memory.db`
**New:** `~/.octybot/data/<project>/<agent>/memory.db`

No actual file moves needed — existing installs still work because the path comes from `getActiveAgent()` which defaults to "default".

**File:** `memory/install-global.ts`

| Old | New |
|-----|-----|
| `data/${project}/${bot}/` | `data/${project}/${agent}/` |
| `active_bot: "default"` | `active_agent: "default"` |

## 2.3 — Rename in Agent Index

**File:** `src/agent/index.ts` (942 lines)

| Old | New |
|-----|-----|
| `config.active_bot` | `config.active_agent` |
| `OCTYBOT_BOT: cmdBot` | `OCTYBOT_AGENT: cmdAgent` |

## 2.4 — Rename in Worker

**Files:** Worker routes and types.

### New Migration: `0008_bot_to_agent.sql`

```sql
-- Rename bot columns to agent
ALTER TABLE conversations RENAME COLUMN bot_name TO agent_name;

-- Rename bots table to agents (SQLite doesn't support RENAME TABLE well, so recreate)
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO agents (id, project_name, agent_name, created_at)
  SELECT id, project_name, bot_name, created_at FROM bots;
DROP TABLE bots;

-- Update settings
UPDATE settings SET key = 'active_agent' WHERE key = 'active_bot';
```

### Route Changes

| File | Old | New |
|------|-----|-----|
| `routes/projects.ts` | `GET /:name/bots` | `GET /:name/agents` |
| `routes/projects.ts` | `POST /:name/bots` | `POST /:name/agents` |
| `routes/projects.ts` | `bot_name` everywhere | `agent_name` |
| `routes/conversations.ts` | `bot_name` in create/list | `agent_name` |
| `routes/settings.ts` | `active_bot` in STRING_KEYS | `active_agent` |
| `types.ts` | `bot_name: string` | `agent_name: string` |

## 2.5 — Rename in PWA

**File:** `src/pwa/app.js`

Global find-replace:
- `bot` → `agent` (in variable names, API calls, UI labels)
- `Bot` → `Agent` (in UI text)
- `bots` → `agents` (in API paths)

**File:** `src/pwa/index.html`
- Update any "Bot" labels in headings/sections.

## 2.6 — Create `agents.json`

**File:** `~/.octybot/projects/<name>/agents.json`

Created by `bin/setup-project.ts` when scaffolding a project:

```json
{
  "agents": {
    "main": {
      "name": "Main Agent",
      "description": "Primary agent — receives messages from phone",
      "tools": [],
      "connections": []
    }
  }
}
```

### Changes to `bin/setup-project.ts`

1. Create `agents.json` with default Main Agent.
2. Create `agents/main/` directory instead of project root as the working dir.
3. Put `CLAUDE.md` and `.claude/settings.json` inside `agents/main/`.
4. Update `install-global.ts` to copy the new structure.

### Migration for Existing Installs

Add to `install-global.ts`:
- If `~/.octybot/projects/<name>/agents.json` doesn't exist, create it with a "main" agent.
- If project has old-style flat structure (CLAUDE.md at root), move it to `agents/main/`.

## 2.7 — Rename in Hooks

**Files:** `memory/hooks/on-prompt.ts`, `memory/hooks/on-stop.ts`

| Old | New |
|-----|-----|
| `OCTYBOT_BOT` | `OCTYBOT_AGENT` |
| `getActiveBot()` | `getActiveAgent()` |
| Any "bot" references in debug output | "agent" |

## 2.8 — Rename in Tests

**File:** `tests/pwa.spec.ts`

| Old | New |
|-----|-----|
| `active_bot` | `active_agent` |
| "switching bot" | "switching agent" |

## 2.9 — Update CLAUDE.md Template

The CLAUDE.md template installed in each project's agent directory:

Replace:
- "bot" → "agent"
- "bots" → "agents"
- "active_bot" → "active_agent"

## Checklist

- [ ] `config.ts` renamed
- [ ] `install-global.ts` renamed + creates agents.json
- [ ] `setup-project.ts` creates agent dirs
- [ ] `src/agent/index.ts` renamed
- [ ] Worker migration `0008_bot_to_agent.sql` applied
- [ ] Worker routes renamed
- [ ] Worker types renamed
- [ ] PWA renamed
- [ ] Hooks renamed
- [ ] Tests updated
- [ ] CLAUDE.md template updated
- [ ] Curation benchmark passes 36/36
- [ ] Deploy and verify end-to-end
