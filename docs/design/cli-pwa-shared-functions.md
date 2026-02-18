# Shared Functions: CLI and Agent Use the Same Code

## Principle

**PWA → Worker → Agent → shared functions ← CLI**

Core logic lives in importable modules under `src/cli/lib/`. Both the CLI (`octybot`) and the Agent service (`src/agent/`) import the same functions. There is no code duplication between them.

## Why

Before this architecture, the CLI (`octybot.ts`) contained inline implementations of agent CRUD, and the Agent service (`memory-commands.ts`) had its own separate implementations. Changes to one required manual sync to the other — a maintenance trap.

## How It Works

```
src/cli/lib/
  projects.ts    # createAgent, listAgents, switchAgent, deleteAgent, getAgentDir, readAgentConfig
  agents.ts      # connectAgents, disconnectAgents
  backup.ts      # getBackupDir, setBackupDir
  tools.ts       # installTool, addToolToAgent, removeToolFromAgent, listTools
  tools-db.ts    # SQLite DB for tool ↔ skill ↔ agent mappings
  admin-agent.ts # Spawns Claude Code Opus to generate skills from tools
```

### CLI Path

```
User runs: octybot agent create foo
  → src/cli/octybot.ts (thin wrapper)
  → src/cli/lib/projects.ts::createAgent("foo")
```

### Agent Path (PWA command)

```
User taps "New Agent" in PWA
  → Worker receives command
  → Agent service polls /memory/commands/pending
  → src/agent/memory-commands.ts
  → src/cli/lib/projects.ts::createAgent("foo")
```

### Same function, two entry points

The `createAgent()` function does the actual work: creates directories, writes `agent.json`, sets up hooks, updates config. The CLI and Agent are both thin wrappers that parse their inputs and call this function.

## Rules

1. **All business logic goes in `src/cli/lib/`** — never inline logic in the CLI router or agent command handler
2. **CLI commands are thin wrappers** — parse args, call lib function, format output
3. **Agent commands are thin wrappers** — parse PWA command payload, call lib function, post result
4. **Functions should be pure where possible** — take explicit arguments, don't read `process.argv`
5. **Shared functions must not depend on CLI or Agent internals** — they import from `src/memory/config.ts` and `src/shared/` only
