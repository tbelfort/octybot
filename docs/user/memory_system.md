# AI Memory System Design

A semantic memory system that gives an AI genuine, persistent knowledge about a user, their business, people, and processes — retrievable through natural conversation without the user needing to repeat themselves.

---

## Table of Contents

1. [The Problem](#the-problem)
2. [Embedding Models & Vector Storage](#embedding-models--vector-storage)
3. [Why Pure Vector Search Fails](#why-pure-vector-search-fails)
4. [Why Squire's Approach Falls Short](#why-squires-approach-falls-short)
5. [Entity-Centric Memory Architecture](#entity-centric-memory-architecture)
6. [Entity Disambiguation](#entity-disambiguation)
7. [Conversational Entity Tracking](#conversational-entity-tracking)
8. [The Middleware Layer](#the-middleware-layer)
9. [Reference Types](#reference-types)
10. [Recency Boost, Not Decay](#recency-boost-not-decay)
11. [Infrastructure & Costs](#infrastructure--costs)
12. [What Exists vs What Needs Building](#what-exists-vs-what-needs-building)
13. [Potential Architecture](#potential-architecture)
14. [Open Questions](#open-questions)

---

## The Problem

A user says in January 2023:

> "The company is Wolf of Blog Street, also known as WOBS. We do link building. These are the tools we use, this is where we store things, and Peter is one of our writers."

Three years later they say:

> "Check if Peter's content is passing as human."

The system must:
1. Know who "Peter" is (a writer at WOBS) — said once, years ago
2. Know there's a process for checking if content is human (taught at some point)
3. Deliver both pieces of context to the LLM so it can act

No current system handles this well.

---

## Embedding Models & Vector Storage

### Cloudflare Vectorize (Recommended Storage)

Already in our CF ecosystem. Pricing is negligible at our scale.

| | Free (Workers Free) | Paid ($5/mo Workers plan) |
|---|---|---|
| Queried vector dimensions | 30M/month | 50M/month, then $0.01/1M |
| Stored vector dimensions | 5M | 10M, then $0.05/100M |
| Max dimensions per vector | 1,536 | 1,536 |
| Max vectors per index | 10M | 10M |
| Indexes per account | 100 | 50,000 |

**Cost at scale (100M words):** ~260K vectors at 1024 dims = $0.13/month storage. ~49K queries/day free.

### Embedding Model Comparison

Sorted by value for semantic memory search:

| Model | Dims | Context | $/M tokens | Quality (MTEB) | Notes |
|-------|------|---------|-----------|----------------|-------|
| CF `bge-m3` | 1024 | 8K | $0.012 | ~64 | Runs on Workers AI, ~9M tokens/day FREE |
| CF `qwen3-embedding-0.6b` | 1024 | 32K | $0.012 | TBD | Newest, instruction-aware |
| Voyage `voyage-4-lite` | 1024 | 32K | $0.02 | Good | 200M tokens free to start |
| OpenAI `text-embedding-3-small` | 1536 | 8K | $0.02 | 62.3 | Cheap, flexible dims |
| Voyage `voyage-4` | 1024 | 32K | $0.06 | Very Good | Best quality/price ratio |
| OpenAI `text-embedding-3-large` | 3072 | 8K | $0.065 | 64.6 | Exceeds CF 1536 dim limit |
| Cohere `embed-v4` | 1536 | — | $0.12 | 65.2 | Multimodal |
| Voyage `voyage-4-large` | 1024 | 32K | $0.12 | Best (RTEB leader) | State of the art |

**Recommendation:** Start with `bge-m3` on Workers AI (near-zero cost, fully integrated). Upgrade to `voyage-4` ($0.06/M) if quality is insufficient.

### ColBERT / Late Interaction

ColBERT stores one vector per token (not per chunk) and uses MaxSim scoring for fine-grained token-level matching. Architecturally superior but:

- Incompatible with Cloudflare Vectorize (needs multi-vector-per-document)
- 10-25x more storage than single-vector
- Modern dense models (Voyage-4-large) have surpassed ColBERTv2 through scale
- Best used as a reranker in a two-stage pipeline, not primary retrieval

**Verdict:** Not needed for our use case. Single-vector dense embeddings with entity-based retrieval will outperform pure ColBERT because the intelligence is in the retrieval logic, not the embedding architecture.

---

## Why Pure Vector Search Fails

Given 260K vectors (100M words of memory), the query "Check if Peter's content is passing as human" returns the top-K most similar chunks. Problems:

1. **Foundational knowledge gets buried.** "Peter is a writer at WOBS" (said once in 2023) competes against hundreds of more recent, more directly similar mentions of Peter. "Peter submitted 8 articles Tuesday" is more similar to the query than "Peter is a writer" but less useful.

2. **Process instructions get buried.** "How to check if content is human" competes against every memory mentioning "content" or "human." It may land at position 15 instead of position 1.

3. **No co-retrieval guarantee.** You need BOTH who Peter is AND the checking process in the context window. Pure vector search has one axis (similarity), so these two pieces compete for the same top-K slots instead of entering through separate retrieval paths.

4. **No importance weighting.** A process definition you were explicitly taught ranks the same as a casual mention of the same topic. Everything is equal.

---

## Why Squire's Approach Falls Short

[Squire](https://github.com/RidgetopAi/squire) is a personal AI memory system with a biologically-inspired architecture. Analyzed in detail for reference.

### What Squire Does Well

- **Salience scoring at ingestion** — regex heuristics (no LLM) score 0-10 on temporal urgency, relationships, action language, explicit marking, self-reference, complexity. Instructions like "you need to learn this" score high.
- **Memory tiers** — hypothesis (unconfirmed) vs solid (validated). Only solid memories surface in retrieval. Memories promote via repeated mention (embedding similarity >= 0.80 boosts confidence).
- **Multi-factor retrieval scoring** — `score = salience * w1 + similarity * w2 + recency * w3 + strength * w4`
- **Entity extraction** — regex + LLM hybrid, entity graph with SIMILAR/ENTITY/SUMMARY edges
- **Story Engine** — "Generate Not Retrieve": classifies narrative intent, gathers evidence, expands via graph BFS, synthesizes a story rather than returning chunks
- **Expression safety filter** — LLM-based post-retrieval gate: "Would mentioning this feel natural?" Fail-open design.
- **Token-budgeted context** — categories (high_salience 40%, relevant 35%, recent 25%) prevent any type from dominating

### Where Squire Fails

1. **Memory decay destroys foundational knowledge.** "Peter is a writer" decays over time. After consolidation cycles without reinforcement, strength drops to 0.3 and it gets outranked by recent trivia. The foundational knowledge rots.

2. **Recency/frequency scoring is wrong for disambiguation.** Squire boosts recently/frequently mentioned entities. But if you suddenly mention a Peter you haven't talked about in years, recency and frequency actively sabotage retrieval — they'd surface the wrong Peter.

3. **Weak embedding model.** Uses `nomic-embed-text` (768 dims) via local Ollama. Significantly weaker than Voyage-4-large or even bge-m3 on retrieval benchmarks.

4. **No hybrid search, no reranker.** Compensates with salience weighting, but still misses cases where keyword matching would trivially succeed.

### What to Borrow from Squire

- Salience scoring (the concept, not necessarily the implementation)
- Entity extraction and graph structure
- Multi-factor retrieval scoring (but with recency BOOST, not decay)
- Token-budgeted context assembly
- The principle that retrieval should have multiple independent paths (entity, similarity, salience)

---

## Entity-Centric Memory Architecture

### Core Principle

Memories belong to entities. Retrieval starts by identifying which entities are relevant, then pulling memories through entity membership — not just vector similarity.

### The Entity Model

```
Entity:
  id
  name
  type                  → person | org | project | place | system | process | concept
  aliases               → ["WOBS", "Wolf of Blog Street"]
  parent_entity_id      → org hierarchy (Peter belongs_to WOBS)
  profile_summary       → living text summary of everything known
  profile_embedding     → embed(profile_summary), updated when new memories arrive
  context_tags          → ["writing", "content", "blog"] for Peter the writer
```

### Entity Types

- **People:** Peter, Dave, Tom, client contacts
- **Organizations:** WOBS, client companies
- **Projects:** Anderson order, Falcon PA
- **Places:** Newark office, Linode US-East
- **Systems/Tools:** Airtable, SharePoint, WordPress
- **Processes:** "How to check if content is human," onboarding flow
- **Concepts:** Link building, SEO, AI detection (abstract themes)

### Memory-Entity Links

Every memory is tagged to the entities it's about:

```
Input: "The company is Wolf of Blog Street, also known as WOBS.
        We do link building. Peter is one of our writers."

Extract entities:
  → WOBS (org, aliases: ["Wolf of Blog Street"])
  → Peter (person, role: writer, belongs_to: WOBS)

Extract memories:
  → "WOBS does link building" → tagged to: [WOBS]
  → "Peter is a writer at WOBS" → tagged to: [Peter, WOBS]
```

### Entity Profiles

Each entity maintains a living profile — a natural language summary of everything the system knows, plus an embedding of that summary. Updated incrementally when new memories arrive.

```
Peter (WOBS Writer):
  profile: "Peter is a content writer at WOBS. Writes blog articles
            for client orders. Submits batches weekly. Quality has
            been consistent."
  profile_embedding: embed(profile)  → vector(1024)
```

The profile embedding is what disambiguation searches against.

---

## Entity Disambiguation

### The Problem

500 Peters in memory. User says "Check if Peter's content is passing as human." Which Peter?

### The Solution: Pure Context

Disambiguation must be **purely contextual**. Not frequency (what if you mention a different Peter 100x more?). Not recency (what if you haven't mentioned this Peter in years?). Only: **which Peter fits the semantic context of what's being said?**

Example: A user says "talking about Peter, and mosshead." They instantly resolve to a specific Peter from 20 years ago. Zero recency. Zero frequency. Mentioned literally never before in this system. But "mosshead" is uniquely tied to that Peter's profile.

### Disambiguation Algorithm

```
Query: "Check if Peter's content is passing as human"

1. Extract "Peter" → ambiguous, multiple candidates
2. Extract query context (minus entity name): "content is passing as human"
3. For each Peter candidate:
     score = cosine_similarity(
       embed("content is passing as human"),
       peter_profile_embedding
     )
4. Peter (WOBS writer) profile contains "writes articles, content creator"
   → score: 0.82
5. Peter (client CTO) profile contains "manages tech team"
   → score: 0.31
6. Gap > threshold → resolved to Peter the writer
7. If gap < threshold → ask user: "Which Peter?"
```

### Key Design Principles

1. **Frequency and recency are irrelevant.** They're patterns about user behavior, not entity identity. Disambiguation is an identity problem.
2. **The entity profile is the catch-all.** Entities resolve through named lookup (aliases). Attributes resolve through profile embedding similarity. Nicknames, quirks, inside references — all in the profile.
3. **Fail loudly, don't guess silently.** If the top two candidates are within a confidence threshold, ask the user. Humans do this too — "Wait, which Peter?"

---

## Conversational Entity Tracking

### The Problem

Each message in a conversation may reference different entities. The system needs to track which entities are "active" (relevant to current context) and which have faded.

```
Message 1: "Let's talk about WOBS"           → active: [WOBS: 0.99]
Message 2: "How's Peter doing?"              → active: [WOBS: 0.92, Peter: 0.99]
Message 3: "What about his last batch?"      → active: [WOBS: 0.89, Peter: 0.95]
Message 4: "And the Anderson order?"         → active: [WOBS: 0.85, Anderson: 0.99, Peter: 0.6]
Message 5: "Is it on track?"                → active: [WOBS: 0.82, Anderson: 0.95, Peter: 0.3]
```

### Entity Scope Layers

Entities operate at different levels of stickiness:

- **Scene** — broadest context (WOBS). Set early, persists until explicitly changed.
- **Topic** — current focus within the scene (Peter, then Anderson order). Changes with conversation flow.
- **Mention** — referenced once, not the focus (Dave in "Dave told me about it"). Fades immediately.

### Per-Turn Scoring

Each turn, every active entity gets a relevance score based on the **content of that message** — not frequency, not recency across all time, but semantic fit to the current conversational context.

### What Exists (Research)

Entity salience in documents is well-studied. Cross-encoders (DeBERTa/ModernBERT) hit F1 82.1 on news articles. But:

- **No model exists for per-turn conversational entity tracking.** All salience models work on single documents.
- **LLMs are bad at this.** GPT-4o zero-shot scores Spearman 0.229 on graded entity salience. Purpose-built cross-encoders score 0.540.
- **Coreference resolution is solved** (Maverick, 500M params, SOTA) — resolves "his" → "Peter."
- **Centering Theory** (Grosz et al., 1995) provides the theoretical framework: backward-looking center (what the utterance is about) and forward-looking centers (ranked entities, subject > object > other).

### Model Options

**Option A: Heuristic pipeline (no training, works now)**
- spaCy NER for entity detection
- Maverick coref for pronoun resolution ("his" → Peter)
- Embedding similarity between message and entity profiles
- Decay per turn when not mentioned
- Gets ~60-70% accuracy

**Option B: Fine-tuned ModernBERT (best quality, needs training)**
- ModernBERT-base (149M params, 8K context)
- Input: conversation + entity name + entity profile
- Output: relevance score 0-1 per entity per turn
- Training data: LLM-generated silver labels (5-10K conversations, $50-200 API cost)
- ~5 minutes to train on GPU
- Cannot run on CF Workers AI (no custom models), needs HuggingFace Inference Endpoints or self-hosted ONNX

**Option C: Embedding-only (simplest, weakest)**
- `cosine_similarity(embed(message), embed(entity_profile))` per turn
- No coref, no NER, no structural awareness
- Quick to implement, misses pronouns and implicit references

**Recommended path:** Start with Option A (heuristic pipeline), use it alongside LLM-generated labels to build training data, then train the ModernBERT model (Option B) for production quality.

---

## The Middleware Layer

Every user input passes through a middleware layer before the LLM sees it:

```
User input
    |
    v
+-----------------------------+
|  1. PARSE                   |
|     Extract all references  |
|     from the input          |
+-------------+---------------+
              |
              v
+-----------------------------+
|  2. RESOLVE                 |
|     Disambiguate each       |
|     reference to a specific |
|     entity/memory           |
+-------------+---------------+
              |
              v
+-----------------------------+
|  3. RETRIEVE                |
|     Pull memories for each  |
|     resolved reference      |
+-------------+---------------+
              |
              v
+-----------------------------+
|  4. ASSEMBLE                |
|     Merge, deduplicate,     |
|     budget tokens, format   |
+-------------+---------------+
              |
              v
    Context + User input --> LLM
```

### Step 1: PARSE

Extract all references from the input. Identifies:
- Explicit entities ("Peter", "WOBS")
- Implicit entities from conversational context (WOBS implied if we've been discussing it)
- Attributes ("content", "articles")
- Concepts ("passing as human" → AI detection)
- Implicit process references ("check" implies a known process exists)

This is an LLM call. Regex catches obvious entities but implicit reference detection needs reasoning.

### Step 2: RESOLVE

For each extracted reference, find what it points to:
- Named entities → entity lookup (name/alias match)
- Ambiguous entities → disambiguation via profile embedding similarity against query context
- Implicit references → conversational context + entity tracking state
- Concepts → concept/process search

### Step 3: RETRIEVE

Pull memories through multiple independent paths:
- **Entity path:** all memories tagged to resolved entities
- **Process path:** process memories matching the query intent
- **Concept path:** semantic search for abstract topics
- **Conversational context path:** recent discussion adds relevant surrounding memories

Multiple paths guarantee co-retrieval — the instruction about checking AI content enters through semantic similarity while Peter's role enters through entity tagging. They don't compete for the same top-K slots.

### Step 4: ASSEMBLE

Merge all retrieval paths. Deduplicate. Rank by relevance. Apply token budgets per category. Format as natural context for the LLM.

---

## Reference Types

All the ways things can be identified and linked in natural language:

| Type | Examples | Resolution Method |
|------|----------|------------------|
| **Entities** | Peter, WOBS, Anderson order | Entity lookup (name/alias) |
| **Attributes** | "likes blue", "writer", "on holiday" | Stored in entity profiles, matched via profile embedding |
| **Relationships** | "Peter works for WOBS", "Anderson is a client" | Edges in entity graph |
| **Processes** | "How to check if content is human" | Tagged as process entities, retrieved by concept similarity |
| **Events** | "Peter submitted articles Tuesday" | Timestamped memories tagged to entities |
| **Concepts** | Link building, SEO, AI detection | Abstract topics, matched via semantic similarity |
| **Implicit references** | "that thing we discussed", "the usual process", "do the same for Sarah" | Requires conversational context + entity tracking state |

---

## Recency Boost, Not Decay

### The Problem with Decay

Squire decays old memories. "Peter is a writer at WOBS" said in January 2023 loses strength over time. After consolidation cycles without reinforcement, it drops to 0.3 and gets outranked by recent trivia. Foundational knowledge rots.

### The Alternative: Boost Recent, Don't Punish Old

Foundational knowledge isn't less important because it's old — it's MORE important because everything else depends on it.

```
base_score = similarity * w1 + salience * w2

recency_boost = if (days_ago < 7)   -> +0.15
                if (days_ago < 30)  -> +0.08
                if (days_ago < 90)  -> +0.03
                else                -> +0.00

final_score = base_score + recency_boost
```

"Peter is a writer at WOBS" from Jan 2023 keeps its full base score forever. "Peter submitted 8 articles Tuesday" gets a temporary recency bump. Recent stuff surfaces higher right now, but doesn't push foundational knowledge out — it just temporarily outranks it when relevant.

---

## Infrastructure & Costs

### Target Stack: Cloudflare

| Layer | Implementation |
|-------|---------------|
| Entity extraction | Worker + LLM call at ingestion |
| Entity storage | D1 (entities, aliases, profiles, relationships) |
| Memory storage | Vectorize (embeddings + entity_ids as metadata) |
| Memory-entity links | D1 junction table or Vectorize namespace per entity |
| Entity tracking | Worker (per-turn scoring logic) |
| Disambiguation | Worker (embed query context, compare to entity profiles) |
| Recency boost | Worker (computed at query time from created_at) |
| Query decomposition | Worker + LLM (extract entities, multi-path retrieval) |

### Cost Estimates

**At 100M words (~130M tokens, ~260K vectors at 1024 dims):**

| Cost | Amount |
|------|--------|
| Embedding (one-time, bge-m3) | $1.56 |
| Embedding (one-time, voyage-4-large) | $15.60 |
| Vectorize storage (monthly) | $0.13 |
| Vectorize queries (monthly, 100/day) | $0.00 (under free tier) |
| Workers paid plan | $5.00/month |
| D1 storage | Included |

**Total ongoing: ~$5.13/month** for 100M words of memory with 49K free queries/day.

### Scaling

At 1M words: 16 cents to embed, then free to store and query.
At 100M words: $15.60 to embed, $0.13/month storage.
At 1B words: ~$156 to embed, ~$1.30/month storage.

Vector search remains sub-10ms regardless of scale up to 10M vectors per index.

---

## What Exists vs What Needs Building

### EXISTS (ready to use)

- **Cloudflare Vectorize** — vector storage with metadata filtering, namespaces
- **Cloudflare Workers AI** — bge-m3 embeddings at near-zero cost
- **Voyage AI** — state-of-the-art embeddings via API
- **spaCy NER** — entity extraction from text
- **Maverick** — SOTA coreference resolution (500M params, "his" → "Peter")
- **Google Cloud NL API** — per-document entity salience scoring

### EXISTS (needs training/adaptation)

- **Cross-encoder entity salience** — DeBERTa/ModernBERT architecture, proven F1 82.1 on news. Never applied to conversation turns.
- **Training datasets** — GUM-SAGE (213 docs, graded 0-5, includes conversation genre), NYT-Salience (100K binary), WN-Salience (7K binary)
- **Knowledge distillation** — compress large model to ~82M params (DistilRoBERTa) with minimal quality loss

### DOES NOT EXIST (needs building)

- Per-turn conversational entity relevance scoring model
- Dialogue-specific training dataset with per-turn entity relevance scores
- A middleware layer that decomposes queries into typed references, resolves each independently, and assembles multi-path retrieval results
- Entity profile management (living summaries with embedding updates)

### Key Research Finding

LLMs perform poorly at entity salience scoring (GPT-4o Spearman 0.229). Purpose-built cross-encoders dramatically outperform (0.540+). This task needs a specialized model, not prompt engineering.

---

## Potential Architecture

```
                    User Input
                         |
                         v
              +---------------------+
              |   ENTITY TRACKER    |  <-- per-turn relevance scores
              |   (ModernBERT or    |      for all active entities
              |    heuristic)       |
              +----------+----------+
                         |
                         v
              +---------------------+
              |   QUERY PARSER      |  <-- extract entities, attributes,
              |   (LLM call)        |      concepts, implicit refs
              +----------+----------+
                         |
                         v
              +---------------------+
              |   ENTITY RESOLVER   |  <-- disambiguate via profile
              |   (embedding sim)   |      embedding similarity
              +----------+----------+
                         |
              +----------+----------+
              |                     |
              v                     v
     +----------------+    +----------------+
     | ENTITY PATH    |    | SEMANTIC PATH  |
     | Pull memories  |    | Vector search  |
     | by entity tags |    | by similarity  |
     | (D1 + Vectorize|    | (Vectorize)    |
     | metadata)      |    |                |
     +-------+--------+    +-------+--------+
              |                     |
              v                     v
              +---------------------+
              |   ASSEMBLER         |  <-- merge, deduplicate,
              |   (Worker logic)    |      rank, token budget
              +----------+----------+
                         |
                         v
              +---------------------+
              |   Context + Input   |
              |       --> LLM       |
              +---------------------+
```

### Phase 1: MVP (heuristic entity tracking)

1. Entity extraction via LLM at ingestion time
2. Entity profiles in D1 with profile embeddings in Vectorize
3. Memory-entity links in D1
4. At query time: NER + coref + embedding similarity for disambiguation
5. Two-path retrieval: entity-tagged + semantic similarity
6. Recency boost (not decay)
7. Token-budgeted context assembly

### Phase 2: Trained Model

1. Collect conversation data from Phase 1 usage
2. Generate silver labels with LLM teacher (entity relevance per turn)
3. Fine-tune ModernBERT-base (149M params) on dialogue entity salience
4. Deploy as ONNX on edge (Fly.io / HuggingFace Inference Endpoints)
5. Replace heuristic entity tracker with trained model

### Phase 3: Advanced

- Story Engine (narrative synthesis from graph-traversed evidence)
- Process/instruction tagging (distinct from regular memories)
- Belief tracking (confidence, evidence, contradictions)
- Living summaries per entity (incrementally updated)
- Multi-hop graph traversal for complex queries

---

## Open Questions

1. **Where does entity extraction run?** LLM call at ingestion is most accurate but adds latency and cost. Could a fine-tuned NER model handle most cases with LLM fallback?

2. **Profile embedding update frequency?** Every new memory triggers a re-embed of the entity profile? Or batch update during a consolidation cycle?

3. **How many entity profiles can we realistically maintain?** Each needs a living summary + embedding. At 10K entities, that's 10K embeddings to store and potentially compare against during disambiguation.

4. **Conversational entity tracking deployment.** If the ModernBERT model can't run on CF Workers AI, where does it live? Added latency of an external call vs. heuristic-only on CF.

5. **Memory deduplication.** If someone says "Peter is a writer" three times across three conversations, do we store three memories or merge them? Squire uses reinforcement (similarity >= 0.80 boosts confidence). What's our approach?

6. **Process/instruction memories.** Should these be a distinct type with higher base salience? "How to check if content is human" is categorically different from "Peter submitted articles Tuesday" — it's a reusable procedure, not an event.

7. **What triggers context retrieval?** Every message? Only when the entity tracker detects a relevant entity? Only when the LLM requests it via tool use?

8. **Hierarchical vector search.** At massive scale (billions of vectors), tiered search (topic summaries → document summaries → chunks) reduces search space. At what scale does this become necessary?
