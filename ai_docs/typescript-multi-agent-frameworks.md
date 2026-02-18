# TypeScript Multi-Agent Frameworks — Survey (Feb 2026)

## Landscape Overview

TypeScript officially surpassed Python in GitHub's 2025 language report. While Python still dominates the AI agent ecosystem, JavaScript/TypeScript is the fastest-growing alternative. Here are the major frameworks.

---

## 1. Anthropic Claude Agent SDK

**Package**: `@anthropic-ai/claude-agent-sdk`
**Type**: Official SDK from Anthropic
**GitHub**: [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript)

### What It Is
The same agent runtime that powers Claude Code, made programmable. Provides built-in tools, automatic context management, session persistence, subagent orchestration, and MCP extensibility.

### Multi-Agent Pattern
- **Subagents**: Define specialized agents with custom prompts, tool restrictions, and model overrides
- **Hub-and-spoke**: Parent agent delegates to subagents via the Task tool; subagents report results back
- **No peer-to-peer**: Subagents cannot communicate with each other directly
- **Agent Teams** (experimental): Multi-session orchestration with peer-to-peer messaging via TeammateTool

### Key Features
- `query()` function with async generator streaming
- `AgentDefinition` type for programmatic subagent creation
- Hooks: PreToolUse, PostToolUse, SubagentStart, SubagentStop, etc.
- Custom MCP tool creation with `tool()` and `createSdkMcpServer()`
- Session resume with full conversation history
- File checkpointing and rewinding
- Permission system with custom `canUseTool` handler
- Sandbox settings for secure execution

### Best For
- Extending Claude Code with custom orchestration
- Building on the same runtime that powers Claude Code
- Projects already using Claude as the LLM

### Limitations
- Tightly coupled to Claude (not model-agnostic)
- Subagents can't spawn sub-subagents
- Agent Teams is experimental

---

## 2. Mastra

**Package**: `mastra`
**Website**: [mastra.ai](https://mastra.ai/)
**GitHub**: [mastra-ai/mastra](https://github.com/mastra-ai/mastra)
**License**: Apache 2.0
**Backing**: YC-funded, from the Gatsby team

### What It Is
Full-stack TypeScript AI framework for building agents, workflows, RAG, and evaluations. The most complete "all-in-one" framework in the TypeScript ecosystem.

### Multi-Agent Pattern
- Workflow graphs that can suspend/resume
- Multi-agent workflows with shared memory
- Short-term and long-term memory systems across threads and sessions
- Integrates with Next.js, Express, Hono

### Key Features
- Agents with memory (short-term and long-term)
- Workflow engine with suspend/resume
- RAG pipelines with vector database support
- Evaluation framework (evals)
- 40+ third-party integrations (Slack, GitHub, Notion, etc.)
- Model-agnostic (OpenAI, Anthropic, custom)
- Built-in playground for testing

### Best For
- Full-stack AI applications with multiple agents
- Teams wanting a complete framework (not just orchestration)
- Projects needing integrations with third-party services

### Limitations
- Large framework footprint
- Opinionated architecture
- May be overkill for simple agent-to-agent messaging

---

## 3. VoltAgent

**Package**: `@voltagent/core`
**Website**: [voltagent.dev](https://voltagent.dev/)
**GitHub**: [VoltAgent/voltagent](https://github.com/VoltAgent/voltagent)

### What It Is
Open-source AI agent engineering platform with a focus on multi-agent supervisor patterns and workflow orchestration.

### Multi-Agent Pattern
- **Supervisor Agent**: Central coordinator delegates to specialized agents
- **Chain API**: Declarative workflow composition with `createWorkflowChain()` and `andAgent()`
- **Shared Memory**: Context persists across multiple agent interactions
- **Dynamic Agent Selection**: Supervisor routes tasks based on context

### Key Features
```typescript
const agent = new Agent({
  name: "coordinator",
  model: openai("gpt-4o-mini"),
  tools: [toolArray],
});
```
- Unified provider switching (OpenAI, Anthropic, custom)
- Persistent memory management
- Pause/Resume for long-running workflows
- Real-time observability (VoltOps cloud dashboard)
- RAG support with 40+ connectors
- TypeScript/Zod schema support for type safety

### Best For
- Enterprise multi-agent systems with supervisor orchestration
- Teams wanting strong observability and monitoring
- Projects needing pause/resume for human-in-the-loop workflows

### Limitations
- Supervisor pattern may not fit all architectures
- Cloud observability component (VoltOps) is not open source
- Relatively new (fewer production deployments)

---

## 4. OpenAI Agents SDK (TypeScript)

**Package**: `@openai/agents`
**Website**: [openai.github.io/openai-agents-js](https://openai.github.io/openai-agents-js/)
**Stars**: 2,100 | **Weekly Downloads**: 128K

### What It Is
Official OpenAI framework for multi-agent workflows and voice agents. The TypeScript equivalent of their Python Agents SDK.

### Multi-Agent Pattern
- Agent handoffs: agents can transfer control to other agents
- Runner: orchestrates agent execution with tool calling
- Guardrails: input/output validation for safety

### Best For
- OpenAI-ecosystem applications
- Voice agent development
- Teams standardized on OpenAI models

### Limitations
- Tightly coupled to OpenAI
- Less mature than Python version

---

## 5. Google Agent Development Kit (ADK)

**Release**: December 2025
**Stars**: 581 | **Weekly Downloads**: 5K

### What It Is
Google's open-source, code-first framework for building AI agents. Launched for TypeScript in late 2025.

### Multi-Agent Pattern
- Code-first agent composition
- Integrates with Google Cloud services
- Emphasis on testability and debugging

### Best For
- Google Cloud-integrated systems
- Teams wanting Google's agent architecture

### Limitations
- Very new (Dec 2025 launch)
- Smaller community than alternatives
- Google Cloud ecosystem focus

---

## 6. Vercel AI SDK

**Package**: `ai`
**Website**: [sdk.vercel.ai](https://sdk.vercel.ai/)
**Most Downloaded**: TypeScript AI framework overall

### What It Is
Streaming-first SDK for building AI-powered user interfaces. Not specifically a multi-agent framework, but widely used for AI applications.

### Key Features
- Streaming chat responses
- React Server Components support
- Edge runtime support
- Model-agnostic (OpenAI, Anthropic, Google, etc.)
- Tool calling support

### Best For
- AI-powered web UIs and chat interfaces
- Next.js / React applications
- Projects needing streaming responses

### Not Ideal For
- Backend multi-agent orchestration
- Agent-to-agent communication
- Complex workflow management

---

## 7. PraisonAI

**Website**: [docs.praison.ai](https://docs.praison.ai/docs/js/typescript)

### What It Is
Production-ready multi-agent framework for TypeScript. Aims to be the TypeScript equivalent of CrewAI/AutoGen.

### Best For
- Teams familiar with Python multi-agent frameworks wanting TypeScript
- Task automation with multiple agents

---

## Decision Matrix

| Framework | Multi-Agent | Model Agnostic | Memory | Workflows | Deps | Maturity |
|-----------|-------------|----------------|--------|-----------|------|----------|
| Claude Agent SDK | Subagents + Teams | No (Claude) | Via hooks | Via subagents | Low | High |
| Mastra | Shared memory | Yes | Built-in | Built-in | High | Medium |
| VoltAgent | Supervisor | Yes | Built-in | Chain API | Medium | Low |
| OpenAI Agents | Handoffs | No (OpenAI) | Limited | Runner | Low | Medium |
| Google ADK | Code-first | Mostly Google | Limited | Built-in | Medium | Low |
| Vercel AI SDK | Not focused | Yes | No | No | Low | High |

---

## Recommendation for Octybot

**Primary: Claude Agent SDK** — Octybot already uses Claude Code, so the Agent SDK is the natural fit for orchestrating Claude-based agents. Use the `agents` option in `query()` to define specialized subagents.

**Supplementary: Custom SQLite queue** — For persistent inter-process communication between independent long-running agents (which the Agent SDK doesn't cover), use a lightweight SQLite message queue.

**Not recommended**: Full frameworks like Mastra or VoltAgent add too much overhead for Octybot's use case. They're designed for building complete AI applications from scratch, not augmenting an existing Claude Code system.

---

## Sources

- [Claude Agent SDK TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Mastra](https://mastra.ai/)
- [VoltAgent](https://voltagent.dev/)
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/)
- [Google ADK for TypeScript](https://developers.googleblog.com/introducing-agent-development-kit-for-typescript-build-ai-agents-with-the-power-of-a-code-first-approach/)
- [Vercel AI SDK](https://sdk.vercel.ai/)
- [Top 5 TypeScript AI Agent Frameworks 2026](https://techwithibrahim.medium.com/top-5-typescript-ai-agent-frameworks-you-should-know-in-2026-5a2a0710f4a0)
