---
description: Delegate a task to a skill agent
argument-hint: <skill-agent-name> <task description>
allowed-tools: Bash
---

# Delegate to Skill Agent

Run a task using a specialized skill agent. Skill agents are Claude Code instances
with tools and instructions for specific capabilities.

## Usage
Run: `bun ~/.octybot/bin/agent-runner.ts <skill-agent-name> "<task>"`

## Available Skill Agents
Run `ls ~/.octybot/skill_agents/` to see available agents.

## How it works
The agent runner spawns a one-shot Claude Code process in the skill agent's folder.
The agent has its own CLAUDE.md with instructions for using the associated tool.
It runs the task, then returns the result.

## Example
User says: "Query Airtable for Q1 budget data"
→ Run: `bun ~/.octybot/bin/agent-runner.ts airtable "Query for Q1 budget data"`
