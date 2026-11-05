# ADR 0026 — GM-proposed checks and declared outcomes

**Status:** Accepted (rpg-42a.74). **Decision:** The GM proposes a check as structured data; the engine validates it against the effective RulePack, offers it to the player and rolls it only after the player accepts. The GM declares any mechanical outcome it narrates as structured data; narration text is never scanned.

**Context:** In as-written mode the engine rolled only when the player's own words matched a verb list. "I slashed my sword on his head" matched nothing, the GM ended the turn with an imperative line, and the attack never resolved. The regex claim check in `consistency.ts` had false negatives (stab, slash, shoot, pronoun targets) and false positives (club, shot, guarda).

**Decision details:**
- `check` proposal: `{ kind, id, ruleId, target, label }` in the existing GM proposals list. `ruleId` must be one of the ids the RulePack lists for check rules (`D20_LITE_CHECK_RULES`, `DICE_POOL_LITE_CHECK_RULES`); the GM sees the list in its instructions. The engine refuses an unknown rule, a campaign without dice and strictness `off`.
- An accepted proposal commits a `CheckOffered` event in a hidden proposal turn. The offer stays pending until a `CheckResolved` event follows it or a newer offer replaces it. The offer is part of the client snapshot (`rollOffer`).
- The player accepts with `SubmitPlayerAction.rollOfferId` (TUI `/roll`, desktop button) or with a reply that holds an attempt word ("I attempt it"). The engine then rolls the offered rule through the same `Check` path as a typed attack, so the roll, the event and the visualization are identical.
- After the roll the next GM request carries the `CheckResolved` result in the packet, as before. The as-written prompt tells the GM to end on the situation, never on an instruction to attempt something.
- `outcome` proposal: `{ kind, id, text }`. It becomes a `NarrationClaim` of kind `outcome`. In as-written mode an outcome claim with no resolved check is an `unresolved-outcome` violation and triggers the existing single regeneration. `claimsMechanicalResult` and its word lists are removed. `ConsistencyReport` keeps its shape.

**Rationale:** Intent and outcomes come from the GM as typed data, validated by the engine, which keeps ADR 0002 intact and removes language-specific word lists from the path that decides whether a roll happens.

**Consequences:**
- The check is a d20 ability check against the default DC with the attribute the rule names. Rolling an attack against the target's defense and applying damage needs target sheets and stays follow-up work.
- An outcome the GM narrates but does not declare is not caught. The prompt requires the declaration; the engine cannot verify it. This trades the old regex false positives for a trust boundary on the model.
- A campaign without a RulePack, or with dice off, cannot offer a roll; the GM prompt for strictness `off` already says to narrate without asking for rolls.
- A stale offer stays open until resolved or replaced.
