---
description: Octybot memory manager — profiles, modes, and memory deletion
argument-hint: <list|active|load|dev-mode|verbose|delete> [args]
allowed-tools: Bash
---

# Octybot Memory Command

Use this command for memory DB management, debug modes, and memory deletion.

## Usage

### Debug Modes
- `/octybot-memory dev-mode enable [file]` — enable dev mode, traces appended to file (default: `~/.octybot/test/debug/dev-trace.log`). Use `tail -f <file>` in another terminal.
- `/octybot-memory dev-mode disable` — disable dev mode
- `/octybot-memory dev-mode` — toggle (backward compat)
- `/octybot-memory verbose` — toggle verbose mode (shows stored memories with session IDs)
- `/octybot-memory trace` — show the latest pipeline trace

### Memory Deletion
- `/octybot-memory delete <session-id>` — delete a stored memory by its session ID (shown in verbose mode)
- `/octybot-memory delete 3 5 7` — delete multiple memories at once

### DB Profiles
- `/octybot-memory list`
- `/octybot-memory active`
- `/octybot-memory load small-baseline`
- `/octybot-memory load noisy-large`
- `/octybot-memory unload`
- `/octybot-memory freeze list`
- `/octybot-memory freeze load <snapshot-name> [profile]`
- `/octybot-memory freeze create <snapshot-name> [profile]`
- `/octybot-memory build-noisy-large`
- `/octybot-memory bootstrap`
- `/octybot-memory help`

## Execution Rules

1. Always run exactly one Bash command:
   - `bash memory/octybot-command.sh memory $ARGUMENTS`
2. The wrapper handles all routing and prints help on invalid routes.

## Notes

- This command manages the SQL graph/vector DB profiles (`nodes`, `edges`, `embeddings`).
- Debug modes (dev-mode, verbose) toggle flag files in `~/.octybot/test/debug/`.
- Memory deletion uses the verbose-mode manifest to map session IDs to real node IDs.
