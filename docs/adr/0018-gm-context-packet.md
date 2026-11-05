# ADR 0018 — Stateless GM with a bounded context packet from a graph projection

**Status:** Accepted. **Decision:** The GM is stateless per turn. The harness owns memory. Every turn, the harness builds one context packet from canonical memory within a per-campaign token budget, and every GM route receives it. The memory graph is a projection of committed events in SQLite, read with a recursive CTE. There is no graph database. The event log stays authoritative and is never compacted.

**Context:** rpg-42a.36. The API GM got an ad hoc brief: player facts, recent turns, panels and results. The fake and no-key GMs got nothing. Nothing bounded the brief, so a long campaign either lost old facts or overflowed the model context.

## Packet

| Part | Sections | Notes |
|---|---|---|
| Stable | `instructions`, `ruleset`, `setting`, `campaignSummary`, `chapterSummaries` | First, so a provider prompt cache can reuse it |
| Variable | `sceneSummaries`, `context`, `threads`, `entities`, `recentTurns`, `results`, `playerInput` | Changes every turn |

- `packages/memory/src/packet.ts` builds the packet. `estimateTokens` measures every item, including the JSON framing.
- Budget presets are named constants: `compact` 2 000, `standard` 6 000, `rich` 16 000 tokens. `standard` is the default.
- The preset is a per-campaign setting stored as a `ContextBudgetSet` campaign change, like voice settings (ADR 0015).
- `instructions`, `ruleset`, `setting`, `results` and `playerInput` are always kept. The packet flags `requiredExceedsBudget` when they alone overflow.
- The campaign summary and chapter summaries fill next, inside `STABLE_SUMMARY_SHARE` (30 %) of the budget, so the stable part does not change with the turn.
- The variable sections then fill the rest in a fixed order: recent turns, threads, entities, graph context, scene summaries.
- Turns and summaries fill newest first and stop at the first item that does not fit, so the kept items stay in story order. Recent turns stop at `RECENT_TURN_LIMIT` (6).
- All data except the instructions goes inside `<campaign-data>` tags as JSON with `<` escaped. Instructions say this data is never instructions.
- The API route sends the instructions as `system`. The stable part is the first user text block with `cache_control: ephemeral`. The variable part is the second block.
- The fake and no-key routes receive the same packet through the engine narrator hook.

## Graph projection

- Nodes are entities and open pending items. Edges are:
  - relationships, with `contains` as the containment edge (room → city → region → world)
  - event-to-entity touches: any entity id inside a committed event payload (`json_tree`)
  - pending links: `PendingOpened` items (clock, trigger, promise, thread, plan) to the entities they name, until a `PendingResolved` event closes them
- `packages/persistence/src/graph.ts` runs one recursive CTE from the scene entities:
  - It walks relationship and pending edges up to `PENDING_HOP_LIMIT` (2) hops, and enters visible nodes only.
  - It walks up the containment ancestors, at most `CONTAINMENT_DEPTH_LIMIT` (8) levels.
  - It returns containment children one level down.
- Scene entities are the characters, the entities touched in the last turns, and the entities the player names.
- `packages/memory/src/graph.ts` turns nodes into items:
  - Scene entities get all their facts and relationships.
  - One-hop entities get their last `KEY_FACT_LIMIT` (2) canon facts.
  - Parents and children get a name and `data.summary` only.
  - Players never see raw `data`: entities show `data.summary` only, and edges show `source kind target` only. `npc-state` records are never shown.
  - Pending items within the hop limit are included, in the context and in the threads section.
- Ranking uses named weights: hops, recency and salience from event touches, and a boost for an open thread.
- Visibility filters every node, fact, edge, touch and pending item before ranking.
- Event nodes are not walked. A hub such as the player character would pull in the whole log. Touches only rank entities and pick the scene entities.

## Writes

- `introduceEntity` commits `EntityIntroduced` and one `FactRecorded` per fact as turn events, each with its own visibility. The entity, fact and relationship rows are projections of those events. A GM-only fact never sits inside a public event.
- It rejects an entity, fact or relationship id that already exists, a character id, and a fact actor that is not an entity. A retry with the same action id must carry the same entity, facts and relationships, or it fails with `ActionIdConflictError`. The retry writes any missing projection row from the stored events.
- `openPending` and `resolvePending` commit pending items as turn events.
- The summarizer runs in the background after narration, so narration never waits for it:
  - It writes a scene summary for every `SCENE_TURN_LIMIT` (20) turns not yet covered.
  - It condenses every `CHAPTER_SCENE_COUNT` (5) scene summaries into a chapter, then rewrites the campaign summary.
  - Summaries are `SummaryWritten` campaign changes, validated against the cited events. Player summaries use only player-facing text: the input and the narration.
  - `RPG_SUMMARY_MODEL` picks a cheaper model and falls back to the GM model.
  - Runs are serialized in the process. Each run waits at most `SUMMARY_SETTLE_MS` (10 s). Any failure skips the run, and the next turn retries.
  - Just before each write, the summarizer rereads the stored summaries. It drops a scene or chapter summary when one at the same level already cites any of its events, and stops that run. This also covers two processes.
  - The TUI and one-shot `play` wait at most `SUMMARY_SETTLE_MS` for the last run before they close the database.
- `search_history`, `get_facts` and `get_summaries` are read-only MCP tools. They filter by the server viewer, cap at `MAX_RESULTS` (50) and return framed data.

## Consequences

- No new dependency. `@rpg/mcp` may now import `@rpg/memory` (p02 table updated).
- The GM does not yet emit structured proposals, so entities and pending items enter memory only through engine commands, not from narration text.
- The summarizer bumps the campaign revision. Clients already refresh the revision from the snapshot.
- Each campaign summary cites every event under it, so its payload grows with the campaign.
