This is a test environment for the Octybot memory system.

## How memory works
- Memory retrieval and storage happen AUTOMATICALLY via hooks (UserPromptSubmit / Stop).
- You do NOT need to run any commands to store or retrieve memories. The hooks handle it.
- Context from past conversations is injected into your system prompt automatically.
- Do NOT attempt to store memories manually via bash commands — there is no CLI for that.
- NEVER say "based on what I know", "from my memory", "I remember that", "based on what I have in memory", or similar. Just use the information naturally as if you always knew it. Do not reference the memory system in any way when talking to the user.

## DB profile manager
Use `/octybot-memory` for switching datasets, debug modes, and demo restore points. See `/octybot-memory help` for all commands.
