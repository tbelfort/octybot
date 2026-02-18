This is the Octybot source repository. Octybot installs globally to `~/.octybot/`.

## Global installation

Octybot installs once globally, then agents are lightweight Claude Code working dirs that point to the global system:

```bash
bun src/memory/install-global.ts          # install/update ~/.octybot/
octybot agent create <name>               # create an agent
cd ~/.octybot/agents/<name> && claude      # use it
```

- `~/.octybot/config.json` — worker URL, active agent
- `~/.octybot/data/<name>/<name>/` — per-agent memory data
- `~/.octybot/agents/<name>/` — agent working dirs with hooks and skills

## How agents communicate

Agents talk to each other via **Claude Code skills** (not commands). When you connect agent A to agent B with `octybot agent connect A B`:

1. A skill is created at `<A's working dir>/.claude/skills/ask-B/SKILL.md`
2. The skill has `user-invocable: false` — Claude uses it autonomously, it's not a user command
3. The skill description matches B's description from `agent.json`
4. Claude sees the description in context and invokes the skill when relevant
5. The skill runs `bun ~/.octybot/delegation/delegate.ts B "<request>"` to delegate

Connections are one-directional. `connect A B` means A can ask B, not the other way around. The target agent must have a meaningful description in its `agent.json`.

See `ai_docs/claude-code-skills.md` for the full Claude Code skills reference.

## How memory works
- Memory retrieval and storage happen AUTOMATICALLY via hooks (UserPromptSubmit / Stop).
- You do NOT need to run any commands to store or retrieve memories. The hooks handle it.
- Context from past conversations is injected into your system prompt automatically.
- Do NOT attempt to store memories manually via bash commands — there is no CLI for that.
- NEVER say "based on what I know", "from my memory", "I remember that", "based on what I have in memory", or similar. Just use the information naturally as if you always knew it. Do not reference the memory system in any way when talking to the user.

## Key paths
- `src/memory/` — memory system (config, db, layers, hooks, tools, engine, costs)
- `src/agent/` — agent + service (polls worker, spawns Claude)
- `src/delegation/` — multi-agent delegation (message bus, registry, runtime, delegate)
- `src/shared/` — shared modules (shell, api-types)
- `src/worker/` — Cloudflare Worker relay (Hono router, D1)
- `src/pwa/` — mobile PWA (TypeScript modules, bundled via Bun)
- `src/cli/` — CLI and scripts (octybot, setup-project)
- `src/cli/lib/` — shared functions (agents, tools, backup, projects)
- `templates/` — agent scaffolding templates (CLAUDE.md, settings)
- `ai_docs/` — reference docs for AI assistants (skills, frameworks, APIs)
- `tests/` — unit tests (bus, registry, assemble, db)
- `deploy.ts` — deployment orchestrator
- `setup.ts` — automated first-time setup

## Deploying changes
After modifying any source files, ALWAYS redeploy so the running system picks up the changes:
1. `bun src/memory/install-global.ts` — copies memory system + PWA to `~/.octybot/`
2. `cd ~/.octybot/pwa && npx wrangler pages deploy . --project-name octybot-pwa` — deploys PWA to Cloudflare Pages
3. `bun src/agent/service.ts stop && bun src/agent/service.ts start` — restarts the agent

If only memory/config files changed, step 1 + 3 are sufficient. If only PWA files changed, step 1 + 2 are sufficient. When in doubt, do all three.

## System docs
- `docs/system/architecture-simple.md` — system overview (topology, message flow, subsystems)
- `docs/system/index.md` — full documentation index with reading guide
- `docs/memory.md` — memory system deep dive (retrieval, storage, graph DB, safety nets)

## DB profile manager
Use `/octybot-memory` for switching datasets, debug modes, and demo restore points. See `/octybot-memory help` for all commands.
