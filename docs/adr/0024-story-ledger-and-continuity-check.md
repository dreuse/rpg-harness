# ADR 0024 — Story fact ledger and continuity check

**Status:** Accepted. **Decision:** The harness keeps a fact ledger folded from committed claim events. Every context packet carries the ledger facts of the entities in play. A deterministic continuity check compares GM narration with the ledger before the player sees it.

**Context:** rpg-42a.42. Retrieval (ADR 0018) puts relevant history in the packet, but it cannot stop the GM from contradicting an old fact, such as a dead NPC speaking.

## Ledger

- `ClaimRecorded` (GM proposal, validated by the engine) and `ClaimCorrected` (player correction) are turn events. Payload: `entityId`, `kind`, `key`, `value`, `visibility`, `actorId`.
- Kinds (`CLAIM_KINDS`, in `domain`): `alive`, `relationship`, `item`, `place`, `promise`, `secret`, `name`, `description`.
- A slot is entity + kind + key. `alive`, `place`, `name` and `description` have one slot per entity, so the key is the kind. A later claim in a slot supersedes the earlier one. The earlier entry stays with `supersededBy` set to the new event ID.
- `packages/memory/src/ledger.ts` folds events into entries. It is pure. It skips payloads that fail to parse. An unknown visibility becomes `gm`.
- Closed value sets: `alive` is `alive` or `dead`, `item` is `held` or `not-held`, `promise` is `open`, `kept` or `broken`. `relationship` keys are entity IDs. A `secret` cannot be `public` or `player`.
- Claim events are retained in the live state window (ADR 0023), so the ledger is built from `state.events`. They grow with play like facts and quests.

## Packet

- `ledger` is a new variable section and is in the required set: it is never trimmed.
- `ledgerLines` picks facts by entity, not by text similarity. The caller passes the scene entities, the entities touched in recent turns and the entities named in the player input.
- Under pressure (`LEDGER_BUDGET_SHARE`, 40 % of the budget) the superseded history is dropped oldest first and condensed into one line per entity. Current facts are always kept. If they alone exceed the budget, the packet sets `requiredExceedsBudget`.
- `visibleLedger` builds the viewer's ledger from the claims that viewer can see and recomputes supersession inside that set. A public fact superseded only by a GM-only fact stays current for the player. Names come from the viewer's ledger, so a GM-only `name` claim never reaches a player line.
- The engine rejects a player-readable claim about an entity that is not player-readable. For a `relationship` claim it also rejects a player-readable claim whose target entity is not player-readable. A hidden entity's name cannot reach the player.

## Continuity check

- `packages/narrative/src/continuity.ts`. Deterministic checks, per sentence: a dead entity that acts or speaks (`dead-acts`), a superseded name (`stale-name`), a superseded place (`wrong-place`), an item used by a holder who does not hold it (`item-not-held`), and a GM-only `secret` value restated as a whole word (`secret-leak`). Each conflict records whether its ledger entry is hidden from the player. The check uses word lists, so it can miss or over-flag. It targets cheap, common contradictions.
- Relationships and promises have no deterministic check. The optional `ModelContinuityCheck` (an injected function, absent by default) covers them. Its output is untrusted: a conflict counts as player-visible only when its `fact` equals a current player-visible fact line (names from the visible ledger). Any other model conflict is treated as hidden. A model check that throws is ignored, so narration never waits on it.
- `enforceContinuity` generates, checks and regenerates with the conflicting facts listed. `MAX_CONTINUITY_RETRIES` is 1. If a conflict remains, each offending sentence is replaced by `(<canonical fact>)`. A conflict about a hidden fact, like a leaked secret, is cut and never quoted or appended. Cutting and replacing work on whole sentences. If a hidden conflict's excerpt is not in the text, every sentence that shares a word of the excerpt (4 letters or more) is cut. The GM still receives the full facts when it regenerates.
- A first-pass conflict produces a `ContinuityConflictLogged` campaign change (GM visibility only). The record holds the kinds, the facts, the regeneration count and whether it resolved. Secret leaks are logged without text, and so is any excerpt that shares a leaked sentence.

## Writes and reads

- `proposeClaims` (engine) validates a GM batch (known entities, value sets, no public secret, no blank) and commits one turn with one event per claim. Replay with the same action ID needs the same claims.
- `correctStoryFact` (engine) commits a `ClaimCorrected` turn with player visibility. The player can only correct a current fact they can see, and never a secret. A correction is also rejected when a newer GM-only claim holds the same slot, so it cannot erase hidden state. The error text does not say why. The turn is left out of `playTurns`, like a sheet edit.
- `readStoryMemory` returns the player-visible current facts as `StoryMemory`, grouped by `person`, `place` and `thread`. Promises are threads, facts about a location are places, the rest are people. GM-only facts and secrets never appear.
- Protocol: `GetStoryMemory` and `CorrectStoryFact` commands parse in `client-protocol`. `StoryMemory` lives in `domain` because `client-protocol` may import only `domain`.

## Consequences

- The desktop daemon answers both commands with a rejection until a session port serves them (follow-up bead). No TUI or desktop panel exists yet (follow-up bead).
- No real GM route emits `claims` yet. The GM route needs structured claim output, then it calls `proposeClaims` (follow-up bead). The scripted fake GM already does (`GameMasterReply.claims`, `runGuardedScript`).
- `scripts/eval-continuity.ts` runs N turns against the real `claude` CLI and prints the first-pass contradiction rate. It is not part of the gate.
