/**
 * Admin agent — spawns Claude Code Opus to analyze tools and generate skills.
 * The admin agent workspace lives at ~/.octybot/admin_agent/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join, basename } from "path";
import { OCTYBOT_HOME } from "../../memory/config";

const ADMIN_DIR = join(OCTYBOT_HOME, "admin_agent");
const WORKSPACE = join(ADMIN_DIR, "workspace");

const ADMIN_CLAUDE_MD = `# Octybot Admin Agent

You are an admin agent for Octybot. You analyze tools and generate Claude Code skills.

## Your job
When given a tool to analyze:
1. Read the tool code thoroughly
2. Understand its purpose, inputs, outputs, and dependencies
3. Write a skill file (.md) that another Claude Code agent can use
4. Test the tool if possible (--help, dry-run, etc.)
5. Write the skill to the workspace directory

## Skill format
Skills are markdown files used as Claude Code slash commands. They should contain:
- A YAML frontmatter block with: description, argument-hint, allowed-tools
- What the tool does (1-2 sentences)
- When to use it
- How to invoke it (exact command with path)
- Arguments and options
- Example usage
- Error handling notes

## Example skill format

\`\`\`markdown
---
description: Brief description of what this tool does
argument-hint: <required-args> [optional-args]
allowed-tools: Bash
---

# Tool Name

One-line description of what the tool does.

## When to use
Describe when this tool is appropriate.

## Usage
\\\`\\\`\\\`bash
bun ~/.octybot/tools/tool-name.py <args>
\\\`\\\`\\\`

## Arguments
- \`arg1\` — description
- \`--flag\` — description

## Examples
\\\`\\\`\\\`bash
bun ~/.octybot/tools/tool-name.py example-usage
\\\`\\\`\\\`
\`\`\`
`;

/** Ensure the admin agent workspace exists with CLAUDE.md and settings. */
export function ensureAdminAgent(): void {
  mkdirSync(WORKSPACE, { recursive: true });

  const claudeMd = join(ADMIN_DIR, "CLAUDE.md");
  writeFileSync(claudeMd, ADMIN_CLAUDE_MD);

  // Create .claude/settings.json with no hooks (admin agent doesn't need memory)
  const claudeDir = join(ADMIN_DIR, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, "settings.json");
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, JSON.stringify({}, null, 2) + "\n");
  }
}

/** Clean up the admin agent workspace. */
export function cleanWorkspace(): void {
  if (existsSync(WORKSPACE)) {
    rmSync(WORKSPACE, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
  }
}

export interface SkillGenerationResult {
  success: boolean;
  skillContent?: string;
  description?: string;
  error?: string;
}

/**
 * Run the admin agent to analyze a tool and generate a skill.
 * Copies the tool to the workspace, spawns Claude Code Opus, reads the generated skill.
 */
export async function generateSkill(
  toolPath: string,
  toolName: string,
  toolExt: string,
): Promise<SkillGenerationResult> {
  ensureAdminAgent();

  // Copy tool to workspace
  const workspaceToolPath = join(WORKSPACE, `${toolName}${toolExt}`);
  const toolContent = readFileSync(toolPath, "utf-8");
  writeFileSync(workspaceToolPath, toolContent);

  const taskPrompt = `Analyze the tool at workspace/${toolName}${toolExt}.

1. Read the tool code and understand what it does
2. Write a Claude Code skill file (slash command .md) that tells an agent how to use this tool
3. The skill should explain: what the tool does, when to use it, how to invoke it, what args it takes
4. The tool will be installed at ~/.octybot/tools/${toolName}${toolExt} — use that path in the skill
5. Test that the tool can be invoked (try running it with --help or similar)
6. Write the skill to workspace/${toolName}.md

The skill format should be a markdown file that Claude Code can use as a slash command.
Include YAML frontmatter with description, argument-hint, and allowed-tools fields.`;

  try {
    const proc = Bun.spawn(
      [
        "claude",
        "-p",
        "--model", "opus",
        "--output-format", "json",
        "--no-session-persistence",
        "--dangerously-skip-permissions",
      ],
      {
        stdin: new TextEncoder().encode(taskPrompt),
        stdout: "pipe",
        stderr: "pipe",
        cwd: ADMIN_DIR,
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return {
        success: false,
        error: `Admin agent exited with code ${exitCode}: ${stderr || stdout}`,
      };
    }

    // Read the generated skill
    const skillPath = join(WORKSPACE, `${toolName}.md`);
    if (!existsSync(skillPath)) {
      return {
        success: false,
        error: "Admin agent did not generate a skill file",
      };
    }

    const skillContent = readFileSync(skillPath, "utf-8");

    // Try to extract description from the agent's JSON output
    let description: string | undefined;
    try {
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("{")) {
          const parsed = JSON.parse(trimmed);
          if (parsed.result) {
            // Extract first sentence as description
            description = parsed.result.split(".")[0] + ".";
            break;
          }
        }
      }
    } catch {}

    // Fall back to extracting description from skill frontmatter
    if (!description) {
      const descMatch = skillContent.match(/^description:\s*(.+)$/m);
      if (descMatch) description = descMatch[1].trim();
    }

    return { success: true, skillContent, description };
  } catch (err) {
    return {
      success: false,
      error: `Failed to run admin agent: ${err}`,
    };
  }
}
