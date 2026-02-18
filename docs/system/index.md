# System Documentation

This directory contains the technical reference for Octybot's internals. Each document covers one subsystem in depth — architecture, data flows, schemas, and key code paths.

## Documents

| Document | What it covers |
|----------|---------------|
| [architecture-simple.md](architecture-simple.md) | Concise orientation — start here if you're new to the codebase |
| [architecture.md](architecture.md) | Complete system reference — topology, message lifecycle, infrastructure, config |
| [worker-api.md](worker-api.md) | Cloudflare Worker — all routes, request/response shapes, D1 schema |
| [agent-service.md](agent-service.md) | Agent service — polling, process pool, streaming, pairing |
| [pwa.md](pwa.md) | PWA frontend — modules, state, dependency injection, voice/TTS |
| [delegation.md](delegation.md) | Inter-agent delegation — message bus, registry, runtime, delegate flow |
| [../memory.md](../memory.md) | Memory system — retrieval/storage pipelines, graph DB, safety nets, curation |

## Which doc should I read?

**New to the codebase?** Start with [architecture-simple.md](architecture-simple.md) for the 2-minute overview, then [architecture.md](architecture.md) for the full picture.

**Working on a specific subsystem?**

| If you're working on... | Read |
|------------------------|------|
| Memory retrieval, storage, embeddings, curation | [../memory.md](../memory.md) |
| Worker API routes, D1 database, JWT auth | [worker-api.md](worker-api.md) |
| Agent polling, Claude process pool, streaming | [agent-service.md](agent-service.md) |
| Mobile chat UI, voice, TTS, hands-free mode | [pwa.md](pwa.md) |
| Multi-agent messaging, agent spawning | [delegation.md](delegation.md) |
| Deployment, setup, global install | [architecture.md](architecture.md) (Infrastructure section) |

## docs/system vs docs/design

These directories serve different purposes:

- **`docs/system/`** — current-state technical reference. APIs, architecture, data flows, schemas, how things work *exactly right now*. If the code disagrees with a system doc, the system doc is wrong.

- **`docs/design/`** — design docs, vision, philosophy, user stories, and aspirational architecture. These describe *where we're going* and *why we make certain choices*. They may describe things that aren't built yet, or principles that guide future work.

## Design documents

| Document | What it covers |
|----------|---------------|
| `docs/design/parity-principle.md` | Core philosophy: CLI and PWA must mirror each other. Everything works in Claude Code; the PWA is a mobile interface to the same system. |
| `docs/design/agent-architecture.md` | Target multi-agent architecture (aspirational). Describes the design that informed the delegation system. Some parts are implemented, some are future plans. |
