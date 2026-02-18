---
description: Ask the {{AGENT_NAME}} agent to handle a task
argument-hint: <task description>
allowed-tools: Bash
---

# Ask {{AGENT_NAME}}

Delegate a task to the **{{AGENT_NAME}}** agent ({{AGENT_DESCRIPTION}}).

## Instructions

Run the delegation command with the user's task:

```bash
bun {{OCTYBOT_HOME}}/delegation/delegate.ts {{AGENT_NAME}} "$ARGUMENTS"
```

Wait for the response and relay the result back to the user.

If the delegation fails, tell the user what went wrong.
