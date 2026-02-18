---
description: Ask {{AGENT_NAME}} — {{AGENT_DESCRIPTION}}
argument-hint: <task description>
allowed-tools: Bash
---

# Ask {{AGENT_NAME}}

**What this agent does:** {{AGENT_DESCRIPTION}}

## Instructions

Run the delegation command with the user's task:

```bash
bun {{OCTYBOT_HOME}}/delegation/delegate.ts {{AGENT_NAME}} "$ARGUMENTS"
```

Wait for the response and relay the result back to the user.

If the delegation fails, tell the user what went wrong.
