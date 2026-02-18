# Entity-Search-First Problem

## The Issue

The retrieval strategy tells L2 to always start by finding entities, then follow relationships, then scope searches by entity_id. This works great for queries where the target entity is obvious:

- "Who is Peter?" -> search_entity("Peter") -> done
- "What's special about Meridian Health?" -> search_entity("Meridian") -> relationships -> scoped facts -> done

But it breaks for **policy/rule queries** where the relevant entity isn't mentioned or obvious.

## Example: R27 "What happens when a writer misses a deadline?"

The answer lives in this instruction node:

> "When a writer misses a deadline, immediately notify the client through Lisa and offer expedited delivery within 24 hours."

This node is linked via edge to **Lisa's entity** (because she's the one you notify). The graph:

```
[instruction: "When a writer misses a deadline..."] --about--> [entity: Lisa]
```

### What L2 did (wrong):

1. `search_entity("writer")` -> found Peter (senior content writer)
2. `get_relationships(Peter)` -> works_for WOBS, writes_for Anderson...
3. `search_facts(entity_id=Peter, "missed deadline")` -> nothing (instruction is linked to Lisa, not Peter)
4. `search_facts(entity_id=WOBS, "deadline missed")` -> revenue fact (wrong)
5. `search_processes("missed deadline process")` -> nothing (it's subtype "instruction", not "tool_usage")
6. Gave up. Never found the answer.

### What L2 should have done:

- Called `get_instructions("deadline")` — this searches by subtype (instruction/tool_usage) regardless of entity linkage
- Or called `search_facts` without entity_id scoping — an unscoped semantic search for "missed deadline" would have found it
- Or searched for Lisa (but there's no reason to from this query)

## Root Cause

Entity-first retrieval assumes the query contains or implies the right entity to anchor on. For policies/rules, the entity linkage is about *who's involved in the process*, not *what the query is about*. The query asks about deadlines, but the answer is linked to Lisa.

## Patterns Where This Fails

1. **Policy queries**: "What are the rules for X?" — rules may be linked to the enforcer, not the subject
2. **Process queries**: "What happens when Y?" — the process may be linked to the handler
3. **Cross-entity instructions**: "What are the content rules?" — rules span multiple entities (Originality, Surfer, Sarah)
4. **Vague queries**: "Any good news recently?" — no entity to anchor on at all

## Potential Solutions (to explore)

1. **Parallel search strategies**: Run entity-first AND instruction/fact search simultaneously
2. **Query classification**: Detect policy/rule queries and route to get_instructions first
3. **Unscoped fallback**: If scoped searches return nothing, always do an unscoped search before giving up
4. **Better edge modeling**: Link instructions to the *subject* (e.g., "deadline") not just the *actor* (Lisa)
5. **Instruction-first for rule queries**: If L1 detects intent "instruction" or "information" with no clear entity, start with get_instructions
