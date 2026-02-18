# Phase 5: CLI & Polish

**Risk:** Low — user-facing only, no core logic changes.
**Depends on:** Phase 2 (agent model), Phase 4 (message bus & runtime).
**Validation:** All CLI commands work. PWA shows agents. Setup scaffolds new agents correctly.

## Goal

Build the `octybot` CLI for managing projects and agents. Update the PWA to show agents instead of bots. Polish the setup and scaffolding flow.

## 5.1 — `octybot` CLI (`bin/octybot.ts`)

Single entry point for all management commands.

```typescript
#!/usr/bin/env bun

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "setup":       await setup(args);       break;
  case "project":     await project(args);     break;
  case "agent":       await agent(args);       break;
  case "status":      await status(args);      break;
  case "deploy":      await deploy(args);      break;
  case "help":        printHelp();             break;
  default:            printHelp();             break;
}
```

### Commands

#### `octybot setup`
First-time setup. Wraps existing `setup.ts` logic.
- Installs global `~/.octybot/` structure
- Deploys worker
- Creates default project if none exists

#### `octybot project list`
Lists all projects in `~/.octybot/projects/`.

#### `octybot project create <name>`
Creates a new project. Wraps `bin/setup-project.ts`.
- Creates `~/.octybot/projects/<name>/`
- Creates `agents.json` with default Main Agent
- Creates `agents/main/` directory with CLAUDE.md

#### `octybot project switch <name>`
Sets active project in `~/.octybot/config.json`.

#### `octybot agent list [--project <name>]`
Lists agents in the active (or specified) project.
```
$ octybot agent list
Project: personal

  main        Main Agent              0 tools   2 connections   running
  airtable    Airtable Agent          1 tool    0 connections   idle
  github      GitHub Agent            1 tool    0 connections   stopped
```

#### `octybot agent add <key>`
Interactive agent scaffolding:
1. Prompts for name, description
2. Creates `agents/<key>/` directory
3. Creates `CLAUDE.md` and `.claude/settings.json`
4. Asks which tools to assign (from `~/.octybot/tools/`)
5. Asks which agents to connect to
6. Updates `agents.json`

#### `octybot agent remove <key>`
Removes an agent:
1. Confirms with user
2. Kills agent process if running (via runtime)
3. Removes from `agents.json`
4. Optionally deletes agent directory and memory data

#### `octybot agent connect <from> <to>`
Adds a connection between agents:
1. Updates `agents.json` — adds `to` to `from`'s connections
2. Generates the `/ask-<to>` slash command in `from`'s `.claude/commands/`

#### `octybot agent disconnect <from> <to>`
Removes a connection. Reverse of connect.

#### `octybot status`
Shows system health:
```
$ octybot status
Octybot v1.0.0

Project: personal
Worker:  https://octybot-worker.tbelfort.workers.dev (healthy)
Service: running (PID 12345, uptime 2d 4h)

Agents:
  main        running   3 messages processed today
  airtable    idle      last active 2h ago
  github      stopped

Memory:
  main        1,247 nodes   memory.db 8.2 MB
  airtable      89 nodes   memory.db 0.4 MB
```

#### `octybot deploy`
Wraps existing `deploy.ts`:
1. `bun src/memory/install-global.ts`
2. Deploy worker
3. Deploy PWA
4. Restart service

### Steps

1. Create `bin/octybot.ts` with command routing.
2. Implement `setup`, `project list`, `project create`, `project switch`.
3. Implement `agent list`, `agent add`, `agent remove`.
4. Implement `agent connect`, `agent disconnect`.
5. Implement `status`, `deploy`.
6. Add `"bin"` entry to `package.json` for global install.
7. Test all commands.

## 5.2 — Agent Scaffolding (`bin/scaffold-agent.ts`)

When `octybot agent add` creates a new agent, the scaffolding:

### Directory Structure Created

```
~/.octybot/projects/<project>/agents/<key>/
  CLAUDE.md
  .claude/
    settings.json
    commands/
      ask-<connected-agent>.md   (one per connection)
```

### Generated CLAUDE.md Template

```markdown
# {AGENT_NAME}

{DESCRIPTION}

## Your Role
You are the {AGENT_NAME} for the {PROJECT_NAME} project. You process requests
sent to you by other agents and respond with results.

## Tools Available
{TOOL_LIST or "No tools assigned."}

## How to Use Tools
{For each tool, a brief usage guide generated from the tool's docstring}

## Memory
Your memory is stored in `~/.octybot/data/{PROJECT}/{KEY}/memory.db`.
You remember context from previous conversations automatically.

## Communication
{CONNECTION_INSTRUCTIONS or "You have no connections to other agents."}
```

### Generated .claude/settings.json

```json
{
  "permissions": {
    "allow": [
      "Bash(bun:*)",
      "Bash(python3:*)"
    ]
  }
}
```

Permissions are generated based on assigned tools (Python tools get python3 permission, etc.).

### Steps

1. Create `bin/scaffold-agent.ts`.
2. Create `templates/agent-claude.md` — the CLAUDE.md template with `{PLACEHOLDERS}`.
3. Create `templates/agent-settings.json` — the settings template.
4. Wire into `octybot agent add`.
5. Test: scaffold an agent, verify it can be spawned by Claude.

## 5.3 — PWA Updates

Update the PWA to show agents instead of bots. Mostly terminology + one new view.

### Terminology Changes

Global find-replace in `src/pwa/app.js` and `src/pwa/index.html`:

| Old | New |
|-----|-----|
| "Bot" | "Agent" |
| "bot" | "agent" |
| "bots" | "agents" |
| "Switch Bot" | "Switch Agent" |
| "active_bot" | "active_agent" |
| `/bots` API paths | `/agents` API paths |

### New: Agent List View

Add a simple agents view to the settings panel:

```
┌─────────────────────────┐
│ Agents                  │
│                         │
│ ● Main Agent            │
│   2 connections, 0 tools│
│                         │
│ ○ Airtable Agent        │
│   0 connections, 1 tool │
│                         │
│ ○ GitHub Agent          │
│   0 connections, 1 tool │
│                         │
│ [Switch] [Details]      │
└─────────────────────────┘
```

- Green dot (●) = currently active agent
- Shows connection count and tool count
- "Switch" changes active agent
- "Details" shows agent config (read-only for now)

### New: Agent Status Indicator

In the chat header, show which agent is active:

```
┌─────────────────────────┐
│ 🤖 Main Agent      ● ▲ │
│─────────────────────────│
│ ...messages...          │
```

### API Changes

Update PWA API calls to match renamed worker routes:
- `GET /projects/:name/bots` → `GET /projects/:name/agents`
- `POST /projects/:name/bots` → `POST /projects/:name/agents`
- All `bot_name` fields → `agent_name`

### Steps

1. Rename all bot → agent in `app.js` and `index.html`.
2. Update API paths.
3. Add agent list view to settings panel.
4. Add agent status indicator in chat header.
5. Test on mobile.

## 5.4 — Setup Flow Polish

Update `setup.ts` to use the new agent model.

### Changes

1. Replace "bot" terminology in all prompts and output.
2. Create default `agents.json` during project creation.
3. Create `agents/main/` directory structure.
4. Run `octybot agent connect` for any configured connections.

### Backwards Compatibility

For existing installs:
1. Detect old-style flat structure (CLAUDE.md at project root, no `agents/` dir).
2. Auto-migrate: move CLAUDE.md → `agents/main/CLAUDE.md`, create `agents.json`.
3. Print migration notice.

### Steps

1. Update `setup.ts` — rename prompts, create agent structure.
2. Update `memory/install-global.ts` — migration logic for existing installs.
3. Test fresh install end-to-end.
4. Test migration from old structure.

## 5.5 — Documentation

Update all user-facing docs:

| File | Changes |
|------|---------|
| `CLAUDE.md` | Update paths, add agent concepts |
| `README.md` | Already updated (done in docs phase) |
| `docker/CLAUDE-INSTALL.md` | Update for new structure |
| `memory/README.md` | Update for MemoryEngine |

### Steps

1. Update each file.
2. Verify all paths and examples are correct.

## Final State After Phase 5

```
bin/
  octybot.ts             (CLI entry point)
  scaffold-agent.ts      (agent directory scaffolding)
  setup-project.ts       (updated for agents)
templates/
  agent-claude.md        (CLAUDE.md template)
  agent-settings.json    (settings.json template)
  ask-agent.md           (delegation skill template, from Phase 4)
src/pwa/
  app.js                 (agent terminology, agent list view)
  index.html             (agent terminology, header indicator)
  style.css              (agent list styles)
```

## End-to-End User Flow

After all 5 phases, the complete user experience:

```bash
# 1. First-time setup
octybot setup
# → installs ~/.octybot/, deploys worker, creates default project

# 2. Add an agent
octybot agent add airtable
# → prompts for name, description, tools, connections
# → creates agents/airtable/ with CLAUDE.md, settings

# 3. Connect agents
octybot agent connect main airtable
# → main can now delegate to airtable via /ask-airtable

# 4. Use it
# From phone: "Get Q1 budget from Airtable"
# Main Agent receives message → delegates to Airtable Agent → response

# 5. Check status
octybot status
# → shows all agents, their state, message counts
```
