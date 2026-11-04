# ADR 0009 — Pacing budgets live in domain

**Status:** Accepted. **Decision:** The pacing types and pure budget functions (`selectSurfaced`, `startScene`, `concludeStoryline`, `DEFAULT_PACING`) move from `narrative` to `domain/src/pacing.ts`. `narrative/src/pacing.ts` re-exports them. `world` adds `surfaceWorldEvents`, which classifies world events with `classifyEvent` and passes them to `selectSurfaced`.

**Context:** W08 needs world activity gated by the same attention, interruption and storyline budgets as narrative. `world` may import only `domain`.

**Rationale:** One budget implementation for both packages, as was done for `EVENT_BUCKETS`. The functions are pure and hold no narrative state.

**Consequences:** Budgets select which events surface. They never change accepted world actions, dice or the scheduler tick rate, so any simulation mode works with any pacing intent. World events count as unsolicited; critical events always surface.
