# The Parity Principle: CLI and PWA Must Mirror Each Other

## Core Philosophy

Everything in Octybot can be run locally in Claude Code. The PWA is a replication of what we can already do there — not the other way around. The CLI is the source of truth; the PWA is a mobile-friendly mirror.

This means:

- **Agents and skills created via the PWA must also work directly in Claude Code** (via hooks, skills, and CLAUDE.md)
- **Agents and skills created via the CLI must also appear and work in the PWA**
- **Any feature added to one side must be implemented on the other** (with one exception: voice)

The two methods are not separate products. They are two interfaces to the same system. A user should be able to start a conversation on their phone, switch to Claude Code on their Mac, and pick up exactly where they left off — with the same memory, same agents, same tools.

## What the PWA Is

The PWA is a persistent Claude Code session manager accessible from your phone. When you type a message in the PWA:

1. It goes to the Cloudflare Worker
2. The Agent service picks it up
3. It spawns (or resumes) a Claude Code CLI process
4. Claude Code runs with all the same hooks, memory, CLAUDE.md, and tools that it would have if you were typing directly in the terminal

There is no separate "PWA mode" or "phone mode." The PWA is Claude Code — just with a mobile UI on top.

## The Rule

**The CLI must be able to do everything that the PWA can do.**

| Capability | PWA | CLI |
|-----------|-----|-----|
| Create agents | Settings → Agents → New | `octybot agent create <name>` |
| Switch active agent | Sidebar agent selector | `octybot agent switch <name>` or `config.json` |
| Memory backup/restore | Settings → Agents → agent → Snapshot/Restore | `/octybot-memory freeze create/load <name>` |
| Memory clear | Settings → Agents → agent → Clear | `/octybot-memory delete-all` |
| Toggle memory | Settings → Agents → agent → toggle | `memory-disabled` flag file or `/octybot-memory` |
| Delegate to agents | Chat naturally (agent decides) | Automatic via `.claude/skills/ask-<agent>/` |
| View conversations | Sidebar | (conversations are in D1, accessible via Worker API) |
| Voice input | Mic button | N/A (voice is PWA-only) |
| Text-to-speech | TTS button / handsfree | N/A (voice is PWA-only) |
| Hands-free mode | Handsfree overlay | N/A (voice is PWA-only) |

## The One Exception: Voice

Voice input (speech-to-text), text-to-speech, and hands-free mode are **PWA-only features**. They exist because you're using Octybot from your phone, where typing is inconvenient and speaking is natural. These features don't make sense in a terminal environment.

Everything else must work in both interfaces.

## Why This Matters

1. **Agents should understand the system** — when an agent reads the codebase, it should understand that the PWA and CLI are mirrors. Adding a feature to the PWA without a CLI equivalent (or vice versa) is a bug, not a TODO.

2. **Testing** — if something works in the PWA but not in Claude Code directly, the system is broken. The hooks, memory, and delegation should behave identically regardless of how the Claude Code session was started.

3. **Extensibility** — new capabilities (tools, integrations, workflows) should be designed CLI-first, then surfaced in the PWA. The PWA should never be the only way to access a feature.

## Implementation Implications

When building a new feature:

1. **Start with the CLI** — make it work in Claude Code via hooks, skills, or direct commands
2. **Then add the PWA surface** — create the UI that calls the same underlying system (usually via Worker API → Agent service → CLI)
3. **Test both paths** — verify the feature works identically in both interfaces

When modifying an existing feature:

1. **Check both sides** — if you change how agents work in the PWA, make sure the CLI still works correctly
2. **Keep the Worker as the sync point** — the Worker's D1 database is the shared state between CLI and PWA
3. **Don't create PWA-only state** — if the PWA needs to track something, it should go through the Worker so the CLI can access it too
