# Claude Code Skills

Skills extend what Claude Code can do. A skill is a folder with a `SKILL.md` file and optional supporting files. Claude sees skill descriptions in its context and invokes them autonomously when relevant.

## Where skills live

| Location   | Path                                       | Applies to         |
|------------|--------------------------------------------|--------------------|
| Personal   | `~/.claude/skills/<name>/SKILL.md`         | All your projects  |
| Project    | `.claude/skills/<name>/SKILL.md`           | This project only  |
| Enterprise | Managed settings                           | All org users      |

When skills share a name, higher-priority locations win: enterprise > personal > project.

## SKILL.md format

Every skill needs a `SKILL.md` with YAML frontmatter and markdown instructions:

```yaml
---
name: my-skill
description: What this skill does and when to use it
---

Instructions Claude follows when the skill is invoked.
```

## Frontmatter reference

| Field                      | Required    | Description                                                                 |
|----------------------------|-------------|-----------------------------------------------------------------------------|
| `name`                     | No          | Display name. Defaults to directory name. Becomes `/slash-command`.          |
| `description`              | Recommended | What the skill does. Claude uses this to decide when to load it.            |
| `user-invocable`           | No          | `false` = hidden from `/` menu, Claude-only. Default: `true`.               |
| `disable-model-invocation` | No          | `true` = only user can invoke via `/name`. Default: `false`.                |
| `allowed-tools`            | No          | Tools Claude can use without permission when skill is active.               |
| `context`                  | No          | `fork` = run in isolated subagent context.                                  |
| `agent`                    | No          | Subagent type when `context: fork` (`Explore`, `Plan`, `general-purpose`).  |
| `argument-hint`            | No          | Hint shown during autocomplete (e.g. `[filename]`).                         |

## Invocation control

| Frontmatter                      | User can invoke | Claude can invoke |
|----------------------------------|-----------------|-------------------|
| (default)                        | Yes             | Yes               |
| `disable-model-invocation: true` | Yes             | No                |
| `user-invocable: false`          | No              | Yes               |

## Progressive loading

Skills use three-level loading:
1. **Level 1** — YAML metadata always loaded (description tells Claude when to activate)
2. **Level 2** — Full SKILL.md loaded when invoked
3. **Level 3** — Supporting files loaded on demand

## Supporting files

Skills can include a directory of supporting files:

```
my-skill/
├── SKILL.md           # Main instructions (required)
├── template.md        # Template for Claude to fill in
├── examples/
│   └── sample.md      # Example output
└── scripts/
    └── helper.py      # Script Claude can execute
```

Reference supporting files from SKILL.md so Claude knows when to load them.

## String substitutions

| Variable               | Description                            |
|------------------------|----------------------------------------|
| `$ARGUMENTS`           | All arguments passed when invoking     |
| `$ARGUMENTS[N]`        | Specific argument by 0-based index     |
| `$N`                   | Shorthand for `$ARGUMENTS[N]`          |
| `${CLAUDE_SESSION_ID}` | Current session ID                     |

## Dynamic context injection

The `` !`command` `` syntax runs shell commands before the skill content is sent to Claude:

```yaml
---
name: pr-summary
description: Summarize changes in a pull request
context: fork
agent: Explore
---

PR diff: !`gh pr diff`
Changed files: !`gh pr diff --name-only`

Summarize this pull request...
```

Commands execute first, output replaces the placeholder, Claude sees the final result.

## How Octybot uses skills

Agent-to-agent communication uses Claude Code skills. When you connect agent A to agent B with `octybot agent connect A B`, a skill is created at:

```
<A's working dir>/.claude/skills/ask-B/SKILL.md
```

The skill:
- Has `user-invocable: false` (Claude-only, not a user command)
- Has `allowed-tools: Bash(bun *)` (can run the delegation script)
- Description matches the target agent's description from `agent.json`
- Instructions tell Claude to run `bun ~/.octybot/delegation/delegate.ts B "<request>"`

Claude sees the skill description in its context. When a user's question matches (e.g. "who is dave at wobs?" matches a WOBS expert skill), Claude invokes the skill and delegates automatically.

## Skills vs commands

Commands (`.claude/commands/`) are user-invocable slash commands — the user types `/command-name`. Skills (`.claude/skills/`) can be both user-invocable and Claude-autonomous. Skills are recommended over commands because they support:
- Supporting files directory
- `user-invocable: false` for Claude-only skills
- Progressive loading (description always in context, full content loaded on demand)

Existing `.claude/commands/` files still work. If a skill and command share the same name, the skill takes precedence.

## Source

https://code.claude.com/docs/en/skills
