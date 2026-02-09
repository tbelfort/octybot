This is a test environment for the Octybot memory system.
Memory hooks are active — context from past conversations is injected automatically.

Use DB profile manager for switching datasets and demo restore points:
- Slash command plugin: `/octybot help`, `/octybot memory ...`
- `bun pa-test-1/memory/db-manager.ts list`
- `bun pa-test-1/memory/db-manager.ts active`
- `bun pa-test-1/memory/db-manager.ts load small-baseline`
- `bun pa-test-1/memory/db-manager.ts load noisy-large`
- `bun pa-test-1/memory/db-manager.ts freeze list`
- `bun pa-test-1/memory/db-manager.ts freeze create <snapshot-name>`
- `bun pa-test-1/memory/db-manager.ts freeze load <snapshot-name>`
