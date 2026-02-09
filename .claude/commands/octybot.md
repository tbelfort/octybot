---
description: Octybot memory profile manager (SQL graph DB)
argument-hint: [help] | memory <list|active|load|unload|freeze>
allowed-tools: Bash
---

# Octybot Command

Use this command for SQL graph memory profile management.

## Usage

- `/octybot help`
- `/octybot memory help`
- `/octybot memory list`
- `/octybot memory active`
- `/octybot memory load small-baseline`
- `/octybot memory load noisy-large`
- `/octybot memory unload`
- `/octybot memory freeze list`
- `/octybot memory freeze load <snapshot-name> [profile]`
- `/octybot memory freeze create <snapshot-name> [profile]`
- `/octybot memory build-noisy-large`
- `/octybot memory bootstrap`
- `/octybot <anything> <anything> help`

## Execution Rules

1. Always run exactly one Bash command:
   - `bash memory/octybot-command.sh $ARGUMENTS`
2. The wrapper handles:
   - `/octybot help`
   - `/octybot memory help`
   - Any route that ends with `help`
3. If the route is invalid, the wrapper prints a short error and help.

## Notes

- This command manages the SQL graph/vector DB profiles (`nodes`, `edges`, `embeddings`).
- It does not use the agent JSON memory plugin in `src/agent/plugins/memory.ts`.
