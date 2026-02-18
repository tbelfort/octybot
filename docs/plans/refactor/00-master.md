# Octybot Refactor — Master Plan

## Current State

7,477 lines across 20 key files. Working system, but grown organically.

### What's Wrong

| Problem | Where | Impact |
|---------|-------|--------|
| `layer2.ts` is 1,509 lines | `memory/layer2.ts` | Hardest file to work in. Retrieve, store, curate, assemble, follow-up, planning — all in one file |
| `reportCosts()` duplicated | `hooks/on-prompt.ts:275`, `hooks/on-stop.ts:155` | Identical function in two files |
| `run()` helper duplicated | `service.ts:47`, `deploy.ts:49` | Same spawn-and-capture pattern |
| "Bot" concept is dead weight | `config.ts`, `install-global.ts`, worker routes, PWA | Bot = memory namespace. New model: agent = memory + tools + connections |
| Memory tightly coupled to hooks | `hooks/on-prompt.ts`, `hooks/on-stop.ts` | Can't use memory outside hook lifecycle. No way for a new agent to instantiate memory |
| No inter-agent communication | `bin/agent-runner.ts` is one-shot | No persistent bus, no message queue, no way for agents to talk |
| Config scattered | `config.json`, `.env`, `wrangler.toml`, `settings.json` | 4 places to look, 3 different formats |
| DB path resolution repeated | `config.ts:68`, `install-global.ts:240`, `setup-project.ts` | Same "where is memory.db" logic in 3 places |
| No agent registry | nowhere | No way to list agents, their tools, or their connections |
| Prompts hardcoded inline | `layer1.ts`, `layer2.ts` | System prompts buried in business logic, hard to tune |

### What's Right (Don't Break These)

- Memory pipeline works (100% hit rate at 20K scale)
- Split retrieve/store pipelines (parallel, fast)
- Hook integration is clean (JSON in/out)
- Worker is stateless, scales fine
- PWA is zero-dependency
- Process pooling (pre-warm) eliminates cold starts
- Cost tracking is comprehensive
- Idempotent setup/deploy/install

## Target Architecture

```
~/.octybot/
  config.json                         # global: worker URL, active project
  core/                               # NEW: shared modules
    memory.ts                         #   MemoryEngine class
    bus.ts                            #   SQLite message queue
    registry.ts                       #   Agent registry (reads agents.json)
    runtime.ts                        #   Agent lifecycle (spawn, kill, health)
    costs.ts                          #   Cost reporting (extracted from hooks)
    shell.ts                          #   Shell helpers (extracted from deploy/service)
  tools/                              # Python scripts (.py)
  data/<project>/<agent>/             # per-agent: memory.db, debug/, snapshots/
  projects/<name>/
    agents.json                       # agent definitions + connections
    agents/
      main/                           # Main Agent working dir
        CLAUDE.md
        .claude/settings.json
      airtable/                       # another agent
        CLAUDE.md
        .claude/settings.json
  bin/                                # agent runner, service, deploy, CLI
```

### Agent Model (One Type)

```json
{
  "agents": {
    "main": {
      "name": "Main Agent",
      "description": "Primary agent — receives messages from phone",
      "tools": [],
      "connections": ["airtable", "github"]
    },
    "airtable": {
      "name": "Airtable Agent",
      "description": "Manages Airtable",
      "tools": ["airtable.py"],
      "connections": []
    }
  }
}
```

Every agent: 1 memory store, 0+ tools, 0+ connections.

## Phases

| Phase | Name | Scope | Risk | Dependencies |
|-------|------|-------|------|-------------|
| 1 | [Split & Clean](./01-split-and-clean.md) | Reorganize memory/ into smaller files, extract shared utils | Low — pure refactor, no behavior change | None |
| 2 | [Bot → Agent](./02-bot-to-agent.md) | Rename bot to agent everywhere, create agents.json | Low-Medium — touches config, worker, PWA | Phase 1 |
| 3 | [Memory Engine](./03-memory-engine.md) | Extract MemoryEngine class, thin hook wrappers | Medium — core memory pipeline changes | Phase 1 |
| 4 | [Message Bus](./04-message-bus.md) | SQLite queue, agent registry, agent runtime | Medium — new system, but isolated | Phase 2, 3 |
| 5 | [CLI & Polish](./05-cli-and-polish.md) | `octybot` CLI, agent scaffolding, PWA updates | Low — user-facing only | Phase 2, 4 |

### Dependency Graph

```
Phase 1 (Split & Clean)
    ├──→ Phase 2 (Bot → Agent)
    │       └──→ Phase 4 (Message Bus) ──→ Phase 5 (CLI & Polish)
    └──→ Phase 3 (Memory Engine)
                └──→ Phase 4 (Message Bus)
```

## Principles

1. **Each phase ships independently.** No phase leaves the system broken.
2. **Tests before refactor.** If a module doesn't have tests, write them first, then refactor.
3. **No new features during cleanup.** Phase 1-2 are pure reorganization. New capabilities start in Phase 4.
4. **Preserve the benchmarks.** Memory pipeline must pass 36/36 curation benchmarks after every phase.
5. **Rename, don't alias.** When bot → agent, delete the old name. No backwards-compat shims.

## File Inventory

### Memory System (4,403 lines)

| File | Lines | Phase | Action |
|------|-------|-------|--------|
| `memory/layer2.ts` | 1,509 | 1 | Split into retrieve.ts, store.ts, curate.ts, assemble.ts, follow-up.ts |
| `memory/tools.ts` | 526 | 1 | Split into retrieve-tools.ts, store-tools.ts |
| `memory/db.ts` | 457 | 1 | Split into db-crud.ts, db-queries.ts |
| `memory/hooks/on-prompt.ts` | 304 | 3 | Thin wrapper around MemoryEngine |
| `memory/hooks/on-stop.ts` | 182 | 3 | Thin wrapper around MemoryEngine |
| `memory/layer1.ts` | 280 | 1 | Extract prompts to prompts.ts |
| `memory/debug.ts` | 294 | 1 | Keep as-is (already clean) |
| `memory/workers-ai.ts` | 221 | 1 | Keep as-is |
| `memory/types.ts` | 180 | 1 | Add node type constants, agent types |
| `memory/config.ts` | 176 | 2 | Rename bot → agent |
| `memory/voyage.ts` | 101 | — | Keep as-is |
| `memory/vectors.ts` | 88 | 1 | Extract searchByText() helper |
| `memory/usage-tracker.ts` | 85 | 1 | Keep as-is |

### Agent & Infrastructure (3,074 lines)

| File | Lines | Phase | Action |
|------|-------|-------|--------|
| `src/agent/index.ts` | 942 | 2, 4 | Rename bot refs; later, add multi-agent routing |
| `setup.ts` | 626 | 2 | Rename bot → agent in setup flow |
| `src/agent/service.ts` | 563 | 1 | Extract run() to core/shell.ts |
| `memory/install-global.ts` | 428 | 2 | Rename bot → agent in directory creation |
| `deploy.ts` | 190 | 1 | Extract run() to core/shell.ts |
| `bin/setup-project.ts` | 179 | 2 | Rename bot → agent, create agents.json |
| `bin/agent-runner.ts` | 146 | 4 | Replace with bus-based delegation |

### Worker (not counted above — separate npm package)

| Area | Phase | Action |
|------|-------|--------|
| `routes/projects.ts` | 2 | Rename bots → agents |
| `routes/conversations.ts` | 2 | Rename bot_name → agent_name |
| `routes/settings.ts` | 2 | Rename active_bot → active_agent |
| `types.ts` | 2 | Rename bot fields |
| `migrations/` | 2 | New migration: rename columns |

### PWA

| Area | Phase | Action |
|------|-------|--------|
| `app.js` | 2, 5 | Rename bot → agent throughout; later, agent management UI |
| `index.html` | 2, 5 | Rename labels |
