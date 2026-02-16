---
description: Octybot memory manager — profiles, modes, and memory deletion
argument-hint: <search|delete|show|delete-entity|update|list|active|load|dev-mode|verbose> [args]
allowed-tools: Bash
---

# Octybot Memory Command

Use this command for memory DB management, debug modes, and memory search/deletion.

## Memory Search & Deletion

When the user asks you to forget, remove, or delete something from memory:

1. **Search first** to find the node ID(s):
   - `bash memory/octybot-command.sh memory search <keywords>`
   - This returns matching nodes with their IDs
2. **Confirm with the user** which node(s) to delete (show them what was found)
3. **Delete** the confirmed node(s):
   - `bash memory/octybot-command.sh memory delete <node-id> [node-id ...]`

If the memory was recently shown in context (from the hook), you can see the node ID directly in the `(id: ...)` tag — no search needed.

### Examples
- User says "forget the Brightwell deadline":
  1. `bash memory/octybot-command.sh memory search brightwell deadline`
  2. Show the user the matching node(s)
  3. `bash memory/octybot-command.sh memory delete <id>`

- User says "delete that" (referring to something just shown in context):
  1. Find the ID from the `<memory>` context block
  2. `bash memory/octybot-command.sh memory delete <id>`

## Entity-Level Operations

For managing everything about a specific entity (person, project, etc.):

- **"What do you know about X"** → `bash memory/octybot-command.sh memory show X`
- **"Delete what you know about X"** → `show X` first to preview, then `bash memory/octybot-command.sh memory delete-entity X`
- **"Update X's role"** → `show X` to find the fact node ID, then `bash memory/octybot-command.sh memory update <fact-id> "new content"`

### Commands
- `show <entity-name>` — displays entity + all connected facts/events/plans/instructions
- `delete-entity <entity-name>` — deletes entity + all exclusively-connected nodes (shared nodes are unlinked)
- `update <node-id> <new content>` — supersedes a node with new content and re-embeds it

## Debug Modes
- `/octybot-memory dev-mode enable [file]` — enable dev mode, traces appended to file
- `/octybot-memory dev-mode disable` — disable dev mode
- `/octybot-memory dev-mode` — toggle (backward compat)
- `/octybot-memory verbose` — toggle verbose mode
- `/octybot-memory trace` — show the latest pipeline trace

## DB Profiles
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
- `/octybot-memory show <entity-name>`
- `/octybot-memory delete-entity <entity-name>`
- `/octybot-memory update <node-id> <new content>`
- `/octybot-memory help`

## Execution Rules

1. Always run via Bash:
   - `bash memory/octybot-command.sh memory $ARGUMENTS`
2. The wrapper handles all routing and prints help on invalid routes.

## Notes

- Memory retrieval and storage happen AUTOMATICALLY via hooks. You do NOT need to store memories manually.
- This command is only for: searching, deleting, DB profiles, and debug modes.
- The SQL graph/vector DB stores nodes, edges, and embeddings.
