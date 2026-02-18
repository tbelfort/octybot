# Octybot Memory System

## Philosophy

Octybot is infrastructure around Claude Code, not a replacement for it. The memory system is a **Claude Code hook** — it gives Claude persistent memory across sessions by intercepting every prompt, retrieving relevant context, and injecting it before Claude processes the message. The goal is to make Claude Code better, and to encourage people to use Claude Code.

## Stack

- **Embeddings:** Voyage 4 Large ($0.12/M tokens, 200M free, 1024 dims)
- **Vector storage:** Cloudflare Vectorize
- **Structured storage:** Cloudflare D1 (SQLite, graph model)
- **Middleware LLM (mem):** Qwen3-30B-A3B on Workers AI (free tier: ~580 messages/day)
- **Runtime:** Cloudflare Worker (existing)
- **Integration:** Claude Code `UserPromptSubmit` hook

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code (terminal or Octybot agent)                │
│                                                         │
│  User types prompt                                      │
│       │                                                 │
│       ▼                                                 │
│  UserPromptSubmit hook fires ──────────────────────┐    │
│       │                                            │    │
│       │  POST /memory/query                        │    │
│       │  { prompt, session_id }                     │    │
│       │                                            ▼    │
│       │                              ┌──────────────┐   │
│       │                              │  CF Worker   │   │
│       │                              │              │   │
│       │                              │  mem (Qwen3) │   │
│       │                              │  D1 (graph)  │   │
│       │                              │  Vectorize   │   │
│       │                              │  Voyage 4    │   │
│       │                              └──────┬───────┘   │
│       │                                     │           │
│       │  { additionalContext: "<memory>..." }│           │
│       │◄────────────────────────────────────┘           │
│       │                                                 │
│       ▼                                                 │
│  Claude sees: memory context + original prompt          │
│       │                                                 │
│       ▼                                                 │
│  Claude responds                                        │
│       │                                                 │
│       ▼                                                 │
│  Stop hook fires ─────────────────────────────────┐    │
│       │                                            │    │
│       │  POST /memory/store                        │    │
│       │  { prompt, response, session_id }          │    │
│       │                              ┌─────────────┘    │
│       │                              ▼                  │
│       │                      CF Worker stores           │
│       │                      new memories               │
│       ▼                                                 │
│  Done                                                   │
└─────────────────────────────────────────────────────────┘
```

**Two hooks, one memory system:**

| Hook | When | What it does |
|---|---|---|
| `UserPromptSubmit` | Before Claude sees the prompt | Calls `/memory/query` — runs extraction, intent, retrieval. Returns `additionalContext` with relevant memories. |
| `Stop` | After Claude finishes responding | Calls `/memory/store` — sends the prompt + response for the post-response pipeline to extract and store new memories. |

**Two entry points, same API:**

| Client | How it connects |
|---|---|
| **Claude Code (terminal)** | Hooks in `.claude/settings.json` call the worker API directly |
| **Octybot (phone → agent)** | Agent hits the same worker API before/after spawning Claude |

The memory system doesn't know or care whether the user is typing in a terminal or sending a message from their phone. It's one API.

### Hook Configuration

```json
// .claude/settings.json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun ~/.octybot/hooks/memory-retrieve.ts",
            "timeout": 10000,
            "statusMessage": "Retrieving memories..."
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun ~/.octybot/hooks/memory-store.ts",
            "timeout": 15000
          }
        ]
      }
    ]
  }
}
```

### Graph Database

D1 with four node types, each with a corresponding vector index in Vectorize.

```
D1 (graph)                    Vectorize (semantic search)
┌──────────┐                  ┌──────────────────┐
│ entities │ ──embedding──→   │ entity profiles  │
│ facts    │ ──embedding──→   │ fact embeddings  │
│ events   │ ──embedding──→   │ event embeddings │
│ opinions │ ──embedding──→   │ opinion embeds   │
│ edges    │                  └──────────────────┘
└──────────┘
```

Nodes have attributes (columns/JSON). Edges are typed relationships between any two nodes.

---

## Middleware Pipeline

Two layers. Layer 1 is a single LLM call that classifies the message. Layer 2 is an agentic loop with tools that retrieves and/or stores memories until it has enough context.

```
User prompt
     │
     ▼
┌─────────────────────────────────────┐
│  LAYER 1: Classification (1 call)   │
│                                     │
│  Stage 1: Extractions               │
│  Stage 2: Intents                   │
│  Stage 3: Decide retrieve/store     │
│                                     │
│  Output: extractions + intents +    │
│          operation decision          │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  LAYER 2: Agentic Memory Loop       │
│                                     │
│  Input: extractions, intents,       │
│         user prompt, graph snapshot  │
│                                     │
│  Has TOOLS to query the graph and   │
│  vector store. Runs in a loop       │
│  until it decides it has enough     │
│  context.                           │
│                                     │
│  Also handles storage if needed.    │
│                                     │
│  Output: assembled memory context   │
└──────────────┬──────────────────────┘
               │
               ▼
        additionalContext
        returned to Claude
```

---

### Layer 1: Classification

A single LLM call (Qwen3-30B-A3B). Fast, cheap. Runs on every prompt.

#### Stage 1: Extractions

The mem parses the message and extracts all referenced knowledge.

| Extraction Type | Description | Example from "Check if Peter's content is passing as human" |
|---|---|---|
| **Entities** | Named or implied things | `Peter` (person, ambiguous) |
| **Implied facts** | Things that must be true for the message to make sense | "Peter produces content", "a method exists to check if content is human" |
| **Events** | Things that happened | *(none in this message)* |
| **Opinions** | Subjective evaluations | *(none)* |
| **Concepts** | Abstract topics or domains | "AI detection", "content authenticity" |
| **Implied processes** | Known procedures the message assumes exist | "how to check if content is human-written" |

#### Stage 2: Intents

The mem classifies what the memory system needs to do to support this message.

| Intent | Description | Example |
|---|---|---|
| **action** | User wants something executed | "Check if Peter's content is passing as human" |
| **information** | User wants to know something | "What does WOBS do?" |
| **status** | User wants current state of something | "How's the Anderson order going?" |
| **process** | User needs a stored procedure | "How do I deploy to production?" |
| **recall** | User wants to retrieve a past event or conversation | "What did we decide about pricing?" |
| **comparison** | User wants things evaluated against each other | "Is Peter faster than Dave?" |
| **verification** | User wants to confirm if something is true | "Does Peter work for WOBS?" |
| **instruction** | User is teaching the system — store, don't retrieve | "From now on, always check AI detection before submitting" |
| **correction** | User is fixing existing knowledge | "No, Peter moved to the Anderson team" |
| **opinion** | User wants an assessment or judgment | "What do you think of Peter's recent work?" |
| **planning** | User wants to think through or plan something | "How should we handle the Q4 content push?" |
| **delegation** | User wants autonomous multi-step handling | "Sort out Peter's overdue articles" |

A single message can have multiple intents. "Check if Peter's content is passing as human" is both **action** + **process**.

#### Stage 3: Decide Operations

Based on the intents, the mem decides what memory operations are needed: **retrieve**, **store**, or both. If extractions are empty (e.g. "Thanks", "Ok"), skip entirely — no Layer 2 needed.

| Intent | Retrieve | Store | Why |
|---|---|---|---|
| **action** | Yes | No | Needs entity context + process steps to act on |
| **information** | Yes | No | Needs to find and return stored knowledge |
| **status** | Yes | No | Needs recent events and current state |
| **process** | Yes | No | Needs stored procedures |
| **recall** | Yes | No | Needs past events/conversations |
| **comparison** | Yes | No | Needs context on all compared entities |
| **verification** | Yes | No | Needs facts to confirm or deny |
| **instruction** | No | Yes | User is teaching — store as new fact (high salience) |
| **correction** | Yes | Yes | Find the wrong memory, supersede it, store the fix |
| **opinion** | Yes | Maybe | Needs context; may store the user's expressed opinion |
| **planning** | Yes | No | Needs context on entities/projects involved |
| **delegation** | Yes | No | Needs full context to act autonomously |

---

### Layer 2: Agentic Memory Loop

An LLM with tools that queries the memory graph in a loop until it has enough context. Could be the same model (Qwen3-30B-A3B) or a more capable one.

**Input to Layer 2:**
- The user's original prompt
- Extractions from Layer 1 (entities, facts, concepts, etc.)
- Intents from Layer 1 (action, process, etc.)
- Operation decision (retrieve, store, or both)
- A **graph snapshot**: the extracted entities and their immediate relationships, so the agent can see the shape of the graph and decide where to look

**The agent then uses tools to search, evaluate results, and loop:**

#### Tools

| Tool | Description | Example call |
|---|---|---|
| `search_entity` | Find entity by name/alias, return profile + type + immediate edges | `search_entity({ name: "Peter" })` |
| `get_relationships` | Get all edges from an entity, with target summaries | `get_relationships({ entity_id: "peter-uuid" })` |
| `search_facts` | Semantic search facts, optionally scoped to entity and/or time | `search_facts({ query: "content quality", entity_id: "peter-uuid" })` |
| `search_events` | Search events with optional entity/time/type filters | `search_events({ query: "submitted articles", entity_id: "peter-uuid", days: 30 })` |
| `search_processes` | Find procedures/instructions by topic | `search_processes({ query: "checking if content is human" })` |
| `get_instructions` | Find behavioral rules, optionally filtered by topic | `get_instructions({ topic: "content" })` |
| `store_memory` | Store a new memory node + edges (for instruction/correction/opinion intents) | `store_memory({ type: "fact", content: "...", entity_ids: [...], salience: 0.9 })` |
| `supersede_memory` | Mark an existing memory as superseded and store the replacement | `supersede_memory({ old_id: "...", new_content: "...", entity_ids: [...] })` |
| `done` | Signal the loop is complete, return assembled context | `done({ context: "assembled memory block" })` |

#### Agentic Loop Example

Input: "Check if Peter's content is passing as human" (intents: action + process)

```
Turn 1: "I need to know who Peter is"
         → search_entity({ name: "Peter" })
         → Result: Peter, content writer at WOBS, ambiguous: false (only one Peter)

Turn 2: "What are Peter's relationships? Need context."
         → get_relationships({ entity_id: "peter-uuid" })
         → Result: works_for → WOBS, works_on → Anderson order, ...

Turn 3: "This is an action about content checking. I need the process."
         → search_processes({ query: "checking if content passes as human" })
         → Result: "AI detection process: run content through [tool], check score > 0.8..."

Turn 4: "Any recent events about Peter's content?"
         → search_events({ query: "content", entity_id: "peter-uuid", days: 30 })
         → Result: "Peter submitted 8 articles for Anderson order, Tuesday"

Turn 5: "Any rules I should know about for this task?"
         → get_instructions({ topic: "content" })
         → Result: "Always check AI detection before submitting to client"

Turn 6: "I have enough context."
         → done({ context: "..." })
```

The key difference from a static pipeline: **the agent decides when it has enough**. If Turn 3 returned nothing (no stored process), it might try a broader search. If Turn 1 returned multiple Peters, it would disambiguate before continuing. If it discovers Peter recently changed teams, it follows that thread. The loop is self-correcting.

#### Loop Constraints

- **Max turns:** Cap at ~8 tool calls to prevent runaway loops (configurable)
- **Timeout:** Must complete within the hook timeout (10s default, configurable)
- **Cost budget:** Each turn costs neurons. At ~580 messages/day free, the loop budget matters. Average 4-5 tool calls per message is sustainable.

#### Store Operations

When the intent requires storage (instruction, correction, opinion), Layer 2 uses `store_memory` and `supersede_memory` tools:

| Intent | What Layer 2 does |
|---|---|
| **instruction** | 1. `get_instructions({ topic })` — check for conflicts |
| | 2. If conflict: `supersede_memory({ old_id, new_content })` |
| | 3. If new: `store_memory({ type: "fact", subtype: "instruction", salience: high })` |
| **correction** | 1. `search_facts/search_entity` — find the wrong memory |
| | 2. `supersede_memory({ old_id, new_content })` |
| | 3. Entity profile auto-updates on supersede |
| **opinion** | 1. `store_memory({ type: "opinion", content, entity_ids })` |

### Post-Response Pipeline (Stop hook)

Triggered by the Claude Code `Stop` hook after Claude finishes responding. The hook sends both the user's prompt and Claude's response to `POST /memory/store`.

This is a **separate pipeline** because Claude's output is a different source of truth:
- The user's words are first-person knowledge ("Peter works for WOBS") — high confidence, source: `user`.
- Claude's words are agent output ("I checked the content and it passed") — needs different attribution, source: `claude`.

The mem processes both the user message and Claude's response, but handles them differently:

| Source | What's extracted | Confidence | Examples |
|---|---|---|---|
| **User message** | New entities, facts, instructions, corrections, opinions | High (1.0) | "Peter works for WOBS", "Always check AI detection first" |
| **Claude response** | Actions taken, outcomes, decisions made, results found | Medium (0.7) | "Checked Peter's 8 articles — all passed AI detection" |

Claude-sourced memories are stored as events with `source: "claude"` so retrieval can distinguish them (e.g. "Previously, Claude reported that...").

**TODO:** Design the full post-response extraction pipeline. Key questions:
1. What from Claude's response is worth storing vs noise? (Not every response contains memorable knowledge)
2. Should the user be able to confirm/reject what gets stored?
3. How to handle multi-turn conversations — store after each response, or batch at session end?

---

## Knowledge Taxonomy

### Node Types

Everything stored in the graph is one of four node types.

#### 1. Entities

Named, referenceable things. Each has a type, canonical name, aliases, and a living profile summary.

| Entity Type | Subtypes | Examples |
|---|---|---|
| **People** | colleague, client, friend, family, contractor, public figure | Peter, my mum, Dave |
| **Organizations** | company, team, department, client org, vendor | WOBS, the marketing team |
| **Projects** | client project, internal, personal, order, campaign | Anderson order, site redesign |
| **Places** | office, city, region, venue, server/datacenter | Newark office, US-East Linode |
| **Systems & Tools** | app, platform, API, database, internal tool, hardware | Airtable, WordPress, the CRM |
| **Processes** | workflow, checklist, rule, policy, convention, template | "how to check if content is human", deploy process |
| **Documents** | document, spreadsheet, report, email, URL, repo | the pricing sheet, that Slack thread |
| **Concepts** | skill, domain, technology, methodology | link building, SEO, AI detection |
| **Events (named)** | meeting, deadline, milestone, incident, holiday, release | Monday standup, the outage last week |
| **Accounts** | account, subscription, API key reference, login | our Cloudflare account |

#### 2. Facts

Atomic statements of truth. Often involve multiple entities.

| Fact Type | Examples |
|---|---|
| **Definitional** | "WOBS does link building for clients" |
| **Causal** | "We switched to WordPress because Squarespace was too slow" |
| **Conditional** | "If an order is over $500, it needs manager approval" |
| **Comparative** | "Peter is faster than Dave but less thorough" |
| **Negations** | "Peter does NOT do editing, only writing" |
| **Instructions** | "Always check with me before contacting clients" |

#### 3. Events

Timestamped occurrences.

| Event Type | Examples |
|---|---|
| **Actions** | "Peter submitted 8 articles on Tuesday" |
| **Decisions** | "We decided to drop the Anderson account" |
| **Conversations** | "Discussed pricing with Anderson — they want a discount" |
| **Incidents** | "Site went down for 2 hours on March 3" |
| **Outcomes** | "Anderson order completed, client happy" |

#### 4. Opinions

Subjective evaluations. Always attributed (usually to the user).

| Opinion Type | Examples |
|---|---|
| **User opinions** | "I don't trust the new CRM" |
| **Assessments** | "Dave is the best person for client calls" |
| **Preferences** | "I'd rather use Notion than Confluence" |

---

### Attributes

Properties stored on nodes (columns or JSON fields).

| Attribute Type | What it captures | Examples |
|---|---|---|
| **Identity** | Name, aliases, nicknames, abbreviations | "WOBS = Wolf of Blog Street" |
| **Role & Function** | Job title, responsibility, purpose | "Peter is a content writer" |
| **Status & State** | Current condition (changes over time) | "Peter is on holiday until Friday" |
| **Traits** | Enduring qualities, personality, tendencies | "Peter is very reliable" |
| **Preferences** | What someone/something favors | "Peter prefers Google Docs over Word" |
| **Quantitative** | Counts, rates, sizes, costs, scores | "Peter writes ~8 articles per week" |
| **Temporal** | Dates, durations, schedules | "Peter started January 2023" |
| **Contact & Location** | Email, phone, address, timezone, URLs | "WOBS is based in Newark" |

---

### Relationships (Edges)

Typed edges between any two nodes. Stored once, queryable from both sides.

| Category | Edge Types |
|---|---|
| **Organizational** | employs/works_for, manages/reports_to, member_of/has_member, owns/owned_by, client_of/serves |
| **Project** | works_on/has_contributor, responsible_for/assigned_to, depends_on/blocks, part_of/contains |
| **Social** | knows/associated_with, related_to, introduced_by |
| **Spatial** | located_at/houses, near/adjacent_to |
| **Tool/System** | uses/used_by, hosted_on/hosts, integrates_with |
| **Conceptual** | about/has_topic, requires_skill, instance_of |
| **Causal** | caused_by/led_to, supersedes/superseded_by |

---

### Metadata (per node)

| Field | Type | Purpose |
|---|---|---|
| `id` | uuid | Primary key |
| `node_type` | enum | entity, fact, event, opinion |
| `content` | text | The atomic statement or profile summary |
| `embedding` | vector(1024) | Voyage 4 Large embedding |
| `salience` | float 0-1 | Importance (instructions = high, casual = low) |
| `confidence` | float 0-1 | Certainty (explicit = 1.0, inferred = 0.6) |
| `source_message_id` | uuid | Which conversation created this |
| `created_at` | timestamp | When stored |
| `valid_from` | timestamp? | When this became true |
| `valid_until` | timestamp? | When this expired (null = still true) |
| `superseded_by` | uuid? | Points to replacement if corrected |
| `attributes` | json | Type-specific attributes |

---

## Summary

| Layer | Count |
|---|---|
| Node types | 4 (entities, facts, events, opinions) |
| Entity types | 10 |
| Fact types | 6 (including instructions) |
| Event types | 5 |
| Opinion types | 3 |
| Attribute types | 8 |
| Relationship types | 7 categories |
| Extraction types | 6 (entities, implied facts, events, opinions, concepts, implied processes) |
| Intent types | 12 (action, information, status, process, recall, comparison, verification, instruction, correction, opinion, planning, delegation) |
| Metadata fields | 12 per node |

---

## Open Decisions

1. **Vectorize topology** — one index with metadata filtering on `node_type`, or 4 separate indexes?
2. **Process/instruction salience** — auto-high, or purely determined by mem?
3. **Corrections and superseding** — soft-delete + new node, or keep both with `superseded_by` edge?
4. **Memory deduplication** — store once with reinforcement, or store all and deduplicate at retrieval?
5. **Entity disambiguation** — certainty scoring layer (noted as TODO)
6. **Memory creation pipeline** — when and how new memories are stored (noted as TODO)
