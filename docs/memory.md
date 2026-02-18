# How Memory Works

Octybot gives Claude Code agents permanent memory. You mention your sister's name once, and the agent knows it from then on — across conversations, across sessions, forever.

This document explains the full system: what's stored, how retrieval works, how storage works, and how it all connects to Claude Code without Claude knowing it exists.

## The Big Picture

Memory runs entirely outside of Claude Code. Two Claude Code hooks do the work:

- **`UserPromptSubmit`** (before Claude sees the message) — retrieves relevant context from the memory database and injects it into Claude's system prompt
- **`Stop`** (after Claude responds) — extracts new information from the exchange and stores it

Claude never calls the memory system. It doesn't know it exists. From Claude's perspective, relevant context just appears in `<memory>` tags at the top of the conversation, and new information from the conversation gets captured after the fact.

All memory LLM calls use GPT-OSS-120B (a cheap open-source model via OpenRouter) — not Claude. Claude is only used for the actual conversation with the user.

```
User message
    │
    ▼
┌─────────────────────────────────────────────┐
│  UserPromptSubmit Hook (on-prompt.ts)       │
│                                              │
│  OSS-120B classifies → plans search →        │
│  searches graph DB → curates results         │
│                                              │
│  Output: <memory>...context...</memory>      │
└──────────────────┬──────────────────────────┘
                   │ injected into system prompt
                   ▼
┌─────────────────────────────────────────────┐
│  Claude Code                                 │
│  Sees the memory context as if it always     │
│  knew it. Responds to the user.              │
└──────────────────┬──────────────────────────┘
                   │ conversation transcript
                   ▼
┌─────────────────────────────────────────────┐
│  Stop Hook (on-stop.ts)                      │
│                                              │
│  OSS-120B classifies the user's message →    │
│  extracts facts/events/instructions →        │
│  stores new nodes in the graph DB            │
└─────────────────────────────────────────────┘
```

## The Database

Each agent gets its own SQLite database at `~/.octybot/data/<project>/<agent>/memory.db`. It's a graph database built on three tables:

### Nodes

Everything in memory is a node. There are six types:

| Type | What it stores | Example |
|------|---------------|---------|
| `entity` | People, organizations, tools, projects, places | "Peter — content writer at WOBS, writes 8 articles/week" |
| `fact` | Concrete, specific information | "Anderson account is a SaaS company paying £200/article" |
| `event` | Things that happened | "Dave missed the Brightwell deadline on March 3rd" |
| `instruction` | Rules, procedures, how-tos | "All articles must score 75+ on Surfer before publishing" |
| `opinion` | Subjective views and preferences | "I think Dave needs more training on medical content" |
| `plan` | Future scheduled things | "Anderson delivery due next Friday, 20 articles" |

Each node has:
- **content** — the actual text (stored verbatim from what the user said)
- **subtype** — more specific classification (e.g., fact/definitional, instruction/rule, instruction/process, event/action)
- **salience** — importance multiplier (default 1.0, higher = more important)
- **scope** — how broadly the node applies (0.0 = entity-specific, 0.5 = team-wide, 1.0 = universal rule). Primarily used for instructions.
- **source** — "user" (from what you said) or "claude" (inferred)
- **superseded_by** — if this node was replaced by a newer version, points to the replacement

### Edges

Edges connect nodes to each other. They represent relationships.

```
[entity: Peter] --works_for--> [entity: WOBS]
[entity: Peter] --works_on--> [entity: Anderson account]
[fact: "Peter writes 8 articles/week"] --about--> [entity: Peter]
[instruction: "All articles need Surfer 75+"] --applies_to--> [entity: WOBS]
```

### Embeddings

Every node gets a vector embedding (1024 dimensions, from Voyage AI's `voyage-4` model). These are stored as blobs and used for semantic similarity search — so searching for "content quality checks" finds the instruction about Surfer scores even if the exact words don't match.

## Retrieval Pipeline

When a message comes in, the `UserPromptSubmit` hook decides what context to retrieve. There are two paths:

### Path 1: Full Pipeline (first message or new conversation)

This is the main pipeline. It runs when there's no conversation state — either it's the very first message, or the Claude Code session ID changed (indicating a new conversation).

```
User message
    │
    ▼
Layer 1: Classification (OSS-120B)
    │  Extracts entities, facts, events, intents
    │  Decides: retrieve=true/false, store=true/false
    │
    ▼
Layer 1.5: Search Planning (OSS-120B)
    │  Classifies query complexity (simple fact / entity lookup / rule-process / multi-part)
    │  Generates a search strategy in natural language
    │
    ▼
Layer 2: Agentic Tool Loop (OSS-120B)
    │  LLM calls search tools in a loop until it has enough context:
    │    search_entity, get_relationships, search_facts,
    │    search_events, search_processes, get_instructions
    │  Calls "done" when satisfied
    │
    ▼
Safety Nets (deterministic, no LLM)
    │  #1: Embedding search for top instruction nodes (with template dedup)
    │  #2: Broad embedding search across all node types
    │  #3: High-scope (>=0.8) global instructions auto-injected
    │
    ▼
Assembly (deterministic)
    │  Collects all node IDs from tool results
    │  Ranks by cosine score, groups by type
    │  Applies per-type caps (15 entities, 30 facts, 15 instructions, etc.)
    │
    ▼
Curation (OSS-120B, per-section in parallel)
    │  Each section (entities, instructions, facts, events, plans)
    │  gets its own curation call: "Given this query, copy verbatim
    │  only the records that help answer it"
    │
    ▼
Output: curated context string → injected as <memory> tags
```

**Why so many layers?** Each layer solves a different problem:

- **L1** decides whether to search at all (a "thanks" message doesn't need retrieval)
- **L1.5** plans the search so the tool loop doesn't waste calls on the wrong things
- **L2** does the actual searching — it's an LLM with tools, not a fixed algorithm, so it can follow chains of relationships ("find Peter → get his projects → get facts about those projects")
- **Safety nets** catch what the LLM missed — they're pure embedding search, no LLM involved, so they're fast and deterministic
- **Curation** filters out noise — the assembly step is deliberately greedy (collect everything that might be relevant), and curation is the precision layer that cuts it down to what actually matters for this specific query

**Why an LLM tool loop instead of just embedding search?** Pure embedding search works for simple queries ("Who is Peter?") but fails on relational queries ("Who reviews the articles that Peter writes for Anderson?"). That requires chaining: find Peter → find Anderson → find their relationship → find the review process. An LLM with tools can follow that chain. The safety nets handle the cases where embedding search alone would have been sufficient.

### Path 2: Follow-up Pipeline (within a conversation)

When previous turns exist in the conversation state (up to 5 are kept), a lighter pipeline runs instead.

Claude Code already has the full conversation in its context window, including `<memory>` tags from previous turns. The follow-up pipeline's job isn't pronoun resolution or context tracking — Claude handles that fine on its own. Its job is deciding **whether the memory system needs to be queried again at all**.

```
User message + conversation state (last 5 turns)
    │
    ▼
Follow-up Analysis (OSS-120B, single call)
    │  Receives: previous prompts, entity names, brief context summaries
    │  Decides: retrieval_needed? storage_needed?
    │  If yes: which specific tool calls to make
    │
    ▼
Targeted Retrieval (if needed)
    │  Executes only the specific tool calls the LLM requested
    │  Broadening fallback for uncovered node types
    │
    ▼
Output: context string (no curation — results are already focused)
```

The conversation state is a lightweight shadow of what Claude already knows — just the prompt text, entity names, and a 400-character summary of what memory found. It's stored in `.conversation-state.json` next to the memory database.

**When the follow-up pipeline returns null** (it can't figure out what to do), it falls back to the full pipeline.

**New conversation detection:** The conversation state resets (and Path 1 runs) only when the Claude Code session ID changes — meaning a genuinely new conversation started. There is no time-based cutoff. If you send a message hours after the last one but within the same session, the memory system still has the last 5 turns of context.

## Storage Pipeline

Storage runs in the `Stop` hook, after Claude has responded. It looks at the user's most recent message (not Claude's response — Claude echoes back what memory already knows).

```
User's message (from transcript)
    │
    ▼
Layer 1: Classification (OSS-120B)
    │  Same classifier as retrieval
    │  Extracts entities, facts, events, opinions
    │  Checks intents for "instruction" or "correction"
    │
    ▼ (if storable content exists)
    │
    ├──► Instruction Extractor (OSS-120B)
    │    │  Specialized prompt for finding rules, procedures, tool usage
    │    │  Assigns subtype (rule/process/tool_usage) and scope (0-1)
    │    │
    │    ▼
    ├──► Storage Filter (OSS-120B)
    │    │  Receives L1 extractions + already-extracted instructions
    │    │  Decides what's genuinely worth storing permanently
    │    │  Filters out: small talk, tautologies, common sense
    │    │
    │    ▼
    │  Combined store items (instructions from extractor + non-instructions from filter)
    │
    ▼
Layer 2: Store Loop (OSS-120B with tools)
    │  LLM searches for existing entities to link to,
    │  then calls store_memory for each item
    │  Tools: search_entity, search_facts, store_memory, supersede_memory
    │
    ▼
Force-Store Safety Net (deterministic)
    │  Checks that every filtered item was actually stored
    │  If the LLM missed any, stores them directly without LLM
    │
    ▼
Reconciliation (OSS-120B)
    │  For newly stored instructions only:
    │  Embeds the new instruction, finds similar existing ones
    │  Classifies each as: KEEP, SUPERSEDES, or CONTRADICTION
    │  SUPERSEDES → old node gets replaced
    │  CONTRADICTION → surfaces to Claude as <memory-action-needed>
    │  so it can ask the user to clarify
```

**Why instruction extraction is separate from the storage filter:** Instructions need specialized handling — scope assignment (how broadly does this rule apply?), subtype classification (is it a rule, a process, tool usage?), and deduplication against the existing instruction set. The storage filter handles the simpler types (facts, events, opinions) and is told about already-extracted instructions so it doesn't duplicate them.

**Supersession:** When you say "actually, articles need to score 80+ on Surfer now" and there's an existing instruction saying "75+", the reconciliation step detects this, marks the old node as superseded, and creates a new one. The old node still exists in the database but is excluded from future searches.

**Contradictions:** When the system detects a potential conflict it can't resolve automatically (e.g., two instructions that seem to disagree but both might be valid), it surfaces it to Claude via `<memory-action-needed>` tags, prompting Claude to ask the user for clarification.

## How Retrieval and Storage Run Together

For messages that need both retrieval and storage (e.g., "Peter moved to the Brightwell project — what's the status there?"), the two pipelines run in **parallel** via `Promise.all`:

```
User message
    │
    ├──► Retrieve pipeline (full)  ──► context for Claude
    │
    └──► Store pipeline            ──► new nodes in DB
```

The retrieval result gets injected into Claude's prompt. The storage result updates the database for future conversations.

## Safety Nets

The retrieval pipeline has three deterministic safety nets that run after the LLM tool loop but before assembly. They exist because the LLM tool loop can miss things — it might search for the wrong entity name, or stop too early, or not think to search for instructions.

### Safety Net #1: Instruction Pre-fetch

Embeds the user's query, does a pure cosine similarity search against all instruction nodes. Returns the top 15, with **template deduplication**: at scale (thousands of similar instructions like "For [Client X], always check Y"), bulk templates flood the results. The dedup normalizes entity names to `_`, groups by pattern, and allows max 2 per template. Fetches 10x candidates then dedupes down.

### Safety Net #2: Broad Embedding Fallback

Same embedding search but across all node types (entities, facts, events, etc.). Returns the top 20 results. Catches anything the LLM's targeted searches missed.

### Safety Net #3: Global Instruction Auto-Inject

Fetches all instructions with `scope >= 0.8` (universal rules like "always do X before publishing"). Checks each against the query vector with a very low cosine bar (0.15) — these are important enough that they should surface for almost any related query. Results get a score floor of 0.6 so they compete with bulk noise in the assembly ranking.

## Curation

After assembly collects everything (generously — it keeps up to 15 entities, 30 facts, 15 instructions, etc.), the curation layer filters it down. Each section gets its own LLM call in parallel:

- "People & things" (entities)
- "Instructions & rules"
- "Facts"
- "Events"
- "Upcoming plans"

The curation prompt says: given this query, copy only the records that help answer it. **Verbatim** — no summarizing, no rephrasing. If a record isn't relevant, omit it entirely. This is important because the curation model is cheap (OSS-120B), and asking it to summarize risks losing critical details. Verbatim copying is a much simpler task that cheap models handle well.

## Scope vs. Salience

The database has both `salience` and `scope` on nodes, but they serve different purposes:

- **Salience** — how important this node is in absolute terms (default 1.0). Not currently used in retrieval ranking; exists for future use.
- **Scope** — how broadly this node applies (0.0–1.0). Only meaningfully used for instructions:
  - `1.0` — universal rule (applies to everything)
  - `0.5` — tool-wide or team-wide
  - `0.2` — entity-specific (only matters for one client/person)

Scope drives two behaviors:
1. **Safety net #3** uses `scope >= 0.8` to find global instructions worth auto-injecting
2. **Assembly sorting** uses cosine score as the primary sort for instructions, with scope as a tiebreaker when scores are within 0.05 of each other

## The Models

| Layer | Model | Purpose | Cost |
|-------|-------|---------|------|
| L1 (classify) | GPT-OSS-120B via OpenRouter | Classify message, extract entities/facts | ~$0.001/msg |
| L1.5 (plan + filter) | GPT-OSS-120B via OpenRouter | Search strategy, storage filter, instruction extraction | ~$0.001/msg |
| L2 (retrieve + store) | GPT-OSS-120B via OpenRouter | Agentic tool loop for searching/storing | ~$0.002/msg |
| Curation | GPT-OSS-120B via OpenRouter | Per-section context filtering | ~$0.001/msg |
| Reconciliation | GPT-OSS-120B via OpenRouter | Detect contradictions/supersessions | ~$0.001/msg (store-only) |
| Embeddings | Voyage 4 via voyageai.com | 1024-dim vectors for semantic search | Free (200M tokens) |
| Conversation | Claude (via Claude Code) | Actual user-facing responses | Claude Code subscription |

A typical message that triggers both retrieval and storage costs about $0.003–0.006 total in OpenRouter + Voyage API calls. The LLM calls are the main cost; embeddings are effectively free.

## Debug Traces

When debug mode is enabled (`/octybot dev-mode`), the memory system writes detailed pipeline traces to `~/.octybot/data/<project>/<agent>/debug/`. Each trace is a JSON file containing the full pipeline execution: user prompt, L1 classification, search plan, all tool calls and results, and the final curated context.

**Privacy note:** Debug traces contain the full text of user prompts and all retrieved memory context. This may include personally identifiable information (PII), sensitive facts, or private details stored in the memory graph. Traces are written to the local filesystem only and are never transmitted externally, but be aware of this if sharing debug files or if the device is accessible to others.

## File Structure

```
memory/
  config.ts          # paths, API keys, model names
  types.ts           # all TypeScript interfaces
  prompts.ts         # all LLM system prompts
  constants.ts       # numeric limits, safety net thresholds

  layer1.ts          # L1 classification
  layer2.ts          # orchestrator — runs retrieve + store in parallel
  retrieve.ts        # L1.5 planning + L2 retrieve loop + safety nets
  store.ts           # instruction extraction + storage filter + L2 store loop + reconciliation
  follow-up.ts       # conversation-aware follow-up pipeline
  assemble.ts        # deterministic context assembly from tool results
  curate.ts          # per-section LLM curation (Method B: verbatim copy)
  tool-loop.ts       # generic LLM tool loop runner
  retrieve-tools.ts  # retrieval tool definitions + handler
  store-tools.ts     # storage tool definitions + handler
  format.ts          # node formatting + debug logging

  db-core.ts         # SQLite singleton, schema, parse utilities
  db-crud.ts         # create/get/delete/supersede nodes and edges
  db-queries.ts      # relationship queries, fact/event/instruction searches
  vectors.ts         # embedding storage + cosine similarity search
  voyage.ts          # Voyage AI embedding API client
  workers-ai.ts      # OpenRouter API client (chat completions)

  state.ts           # conversation state persistence (follow-up pipeline)
  constants.ts       # all numeric limits and safety net thresholds

  hooks/
    on-prompt.ts     # UserPromptSubmit hook — retrieval entry point
    on-stop.ts       # Stop hook — storage entry point

core/
  memory.ts          # MemoryEngine class — wraps the pipeline with a clean API
  costs.ts           # shared cost reporting
```
