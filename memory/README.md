# pa-test-1 Memory DB Manager

This directory contains the SQL graph memory system used by `pa-test-1`.

## What this manages

- Active runtime DB (used by hooks): `~/.octybot/test/memory.db`
- Profile DBs (project copy): `pa-test-1/memory/dbs/*.db`
- Profile DBs (test copy): `~/.octybot/test/profiles/*.db`
- Restore points (project copy): `pa-test-1/memory/snapshots/<profile>/*.db`
- Restore points (test copy): `~/.octybot/test/snapshots/<profile>/*.db`

## Commands

Run from repo root:

```bash
bun pa-test-1/memory/db-manager.ts help
```

Claude Code slash command plugin:

```text
/octybot help
/octybot memory help
/octybot memory list
/octybot memory active
/octybot memory load <profile>
/octybot memory unload
/octybot memory freeze list
/octybot memory freeze load <snapshot-name>
/octybot memory freeze create <snapshot-name>
/octybot <anything> <anything> help
```

Examples:

```text
/octybot memory list
/octybot memory active
/octybot memory load noisy-large
/octybot memory freeze create yt-demo-2
/octybot memory freeze list
/octybot memory freeze load yt-demo-2
```

List available DB profiles:

```bash
bun pa-test-1/memory/db-manager.ts list
```

Show active loaded profile and active DB stats:

```bash
bun pa-test-1/memory/db-manager.ts active
```

Load a profile into active runtime DB:

```bash
bun pa-test-1/memory/db-manager.ts load small-baseline
bun pa-test-1/memory/db-manager.ts load noisy-large
```

Unload active DB (clears `~/.octybot/test/memory.db`):

```bash
bun pa-test-1/memory/db-manager.ts unload
```

Create a restore point for current loaded profile:

```bash
bun pa-test-1/memory/db-manager.ts freeze create pre-demo
```

List restore points for current profile:

```bash
bun pa-test-1/memory/db-manager.ts freeze list
```

Restore a restore point back into active DB:

```bash
bun pa-test-1/memory/db-manager.ts freeze load pre-demo
```

Use a specific profile for freeze/restore/snapshots:

```bash
bun pa-test-1/memory/db-manager.ts freeze create baseline noisy-large
bun pa-test-1/memory/db-manager.ts freeze list noisy-large
bun pa-test-1/memory/db-manager.ts freeze load baseline noisy-large
```

Initialize profile storage with current small active DB:

```bash
bun pa-test-1/memory/db-manager.ts init-profiles
```

Generate a large noisy graph DB and register it as `noisy-large`:

```bash
bun pa-test-1/memory/db-manager.ts build-noisy-large
```

One-shot setup:

```bash
bun pa-test-1/memory/db-manager.ts bootstrap
```

## Notes

- `build-noisy-large` runs `GRAPH_ONLY=1 bun pa-test-1/generate-bulk.ts`, so it only regenerates a graph DB.
- It does not require or modify the old pure-embed benchmark DBs.
- Profiles are mirrored in both project and test locations so both dev and test workflows can use them.
