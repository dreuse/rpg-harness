# ADR 0002 — The Game Master proposes; engine validates and commits

**Status:** Accepted. **Decision:** No model, client, voice adapter, or world actor can directly mutate canonical state.

**Context:** A chat-only GM forgets resources, fabricates rolls and contradicts world history.

**Rationale:** Use typed proposals, independent RulePack resolution, transactional event writes and narration after commit. Prompt-derived story text is presentation only.

**Consequences:** Add model/tool boundary tests, authoritative roll events, strict revision checking and a separate GM-adjudication pathway for unsupported rule mechanics.
