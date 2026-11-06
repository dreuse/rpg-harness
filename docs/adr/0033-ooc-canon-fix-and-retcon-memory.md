# ADR 0033 — Canon fix, retcon re-narration and retcon memory

**Status:** Accepted (rpg-42a.107). **Decision:** The out-of-character channel (ADR 0029) gets a fifth proposal kind, `canon_fix`. A confirmed retcon returns the taken-back action text. Memory built from a retconned turn no longer reaches the GM packet or the visualization replay.

**Decision details:**
- Canon fix: `{ kind: 'canon_fix', summary, entityId, claimKind, key?, value }`. The engine bounds the entity id and key (100 characters) and the value (200 characters). It refuses `secret` and unknown claim kinds, and drops the key for singleton kinds (`alive`, `place`, `name`, `description`). The checks on the entity and the visible fact stay in `correctStoryFact`.
- Apply: `applyOocProposal` calls a `FactCorrector` port, the same pattern as `RollCorrector`. The client session binds it to the story port, so `correctStoryFact` stays the only writer of claims. The correction is a `CLAIM_CORRECTED` system turn with action id `<proposal id>:canon-fix`. Then the engine saves the journal entry. Without a story port the proposal is refused.
- Undo: like a roll fix, undo hides the correction turn through `retconned`. `readStoryMemory` and `correctStoryFact` now read the ledger through `withoutRetconned`, so the earlier fact is current again. Nothing is deleted. Undo and retcon add turn ids without duplicates.
- Fake GM: the player says "<name> is alive" or "<name> is dead" (English or Portuguese). The pattern only matches an entity that has an `alive` fact in the story memory the player can see. Other text stays a table note.
- Model route: the prompt gets `storyFacts` (at most 40 entries: entity id, name, claim kind, key, value) inside the framed data. The CLI drops a `canon_fix` about an entity that is not in that list, and writes the summary itself from the fields, as for the other kinds.
- Re-narration: `OocApplied` carries an optional `retconnedInput`, the text of the retconned player action. It is also returned when the same confirm is sent again. The daemon does not re-run narration. A re-run would roll the dice again and change state without a new player choice. A client resubmits the text, or an edited one, with `SubmitPlayerAction`, which already narrates. The TUI prints the text after a retcon.
- Retcon memory: `contextPacketOf` reads the events of retconned turns (`EventQuery.turnIds`). It drops scene, chapter and campaign summaries that cite those events, facts whose source event or subject comes from them, entities and relationships introduced by them, graph touches, and pending threads opened or resolved by them. Nothing is deleted, so undo brings it all back.
- Visualization: the client session skips the visualization of events from retconned turns, both when it publishes new events and when it replays rolls to a new subscriber.

**Consequences:**
- A relationship between two entities that stay visible, created by a retconned turn, is not filtered from the graph walk (a recursive SQL query). It is filtered from the context lines.
- Entities saved without an `EntityIntroduced` event are never treated as retconned.
- A canon fix only fixes the visible fact of one entity. A fix that needs a new entity or a hidden fact stays a table note.
- Readers that skip the engine and the client session, such as the MCP server event list, still see retconned events.
