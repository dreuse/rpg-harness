# ADR 0032 — Offered attack resolves against the NPC sheet defense

**Status:** Accepted (rpg-42a.84). **Decision:** When a GM-offered attack names an NPC whose sheet holds defense and hit point traits for the pinned RulePack, the engine rolls the attack against that defense, rolls damage and commits a `DamageApplied` event in the same turn. With no usable sheet data the roll behaves as in ADR 0026: a check against the difficulty DC, nothing enforced.

**Context:** ADR 0026 rolled an offered attack as an ability check against a fixed DC and left defense and damage as follow-up work. NPC sheets (rpg-vbk) had no link to the roll path.

**Decision details:**
- The pack declares its combat data (`D20_LITE_COMBAT`: attack rule ids, defense trait id, hit point trait id, damage die). Core types carry no such field. A pack without it (dice-pool-lite, imported packs) rolls only.
- The sheet lives on the `npc` entity as `data.sheet`, either sparse or full (`damage.ts`, `NPC_SHEET_FIELD`). The engine parses it with `parseCharacterProfile`, requires its RulePack link to equal the campaign pack, and reads whole-number traits named by the pack. A missing, malformed or mismatched sheet means no combatant.
- The offer `target` is matched to one `npc` entity by id or by case-insensitive name. An unknown, non-NPC or ambiguous target means no combatant.
- Resolution reuses the pack's `attack` table: d20 plus attribute modifier, proficiency and flat modifiers against the defense, natural 20 doubles damage, natural 1 misses. Proficiency is listed as a flat modifier line so the roll card total adds up. The card target is the defense.
- `DamageApplied { targetId, amount, defeated }` follows `CheckResolved`, has `player` visibility so the GM packet carries it, and is skipped when the amount is zero. Current hit points are the sheet value minus the sum of `DamageApplied` amounts for that NPC (`damageTakenOf`), so replay equals live state. Remaining hit points are never stored in a player-visible event.
- Only NPCs visible to the player (`public` or `player`) can be targets; a `gm` NPC rolls as a plain check. The roll card shows a public NPC's defense as the target, a deliberate tradeoff against `docs/04-character-sheets.md`.
- A roll correction (ADR 0028 table fixes) is refused for an attack roll, because its damage is already committed.
- When the player rolls their own dice, only the attack die is reported (`roll-report.ts` keeps the first roll). Damage dice come from the engine rng.

**Consequences:**
- Nothing writes `data.sheet` yet. NPC creation and the GM proposal that sets it are follow-up work.
- NPC attacks on the player, healing, and a damage die other than the pack default are not modelled.
- The outcome label on the roll card is the raw rule event (`attack.hit`), as for checks.
