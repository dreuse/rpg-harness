# ADR 0034 — House rules in live rolls

**Status:** Accepted (rpg-42a.108). **Decision:** A live d20-lite check or strike resolves against the built-in rule table with the campaign house rules laid over it. The roll record carries the effective version.

**Context:** ADR 0029 stored house rules and validated them through the I09 overlay, but live rolls ignored them. Built-in packs declared no `effects` primitive, so only empty-effect rules compiled.

**Decision details:**
- Capabilities: `d20-lite` declares `random`, `comparison`, `arithmetic`, `condition` and `effects` as deterministic. `dice-pool-lite` declares `effects`. `resourceCost` stays undeclared, so a house rule with a cost is refused as before. The `narrative` pack is unchanged. A pack that marks a primitive `adjudicated` keeps it adjudicated.
- Overlay: `rollTableOf` (`apps/cli/src/house-roll.ts`) compiles the built-in table for the roll (`checkTable` or `attackTable`) as base rules, applies each stored house rule with `applyHouseRule`, and rebuilds the table in its original order. A house rule with the id of a table rule (for example `check.success`, `attack.hit`) replaces that rule. Rules with other ids do not enter the roll. A stored rule that no longer applies is skipped. A replacement that is not deterministic keeps the built-in rule.
- Plumbing: `attemptCheck` and `attack` accept an optional `table`. `checkFor`, `offeredCheckFor` and `ActionRoll` accept the stored house rules, which the gateway and the client session read from `oocStateOf(state.changes)`. The engine package takes no dependency on `imports`.
- Record: when at least one house rule is applied, `CheckResolution.version` holds `{ base, depth, overlayHash }` from `EffectiveVersion`. A roll with no house rule keeps its old record.

**Consequences:**
- A dice-pool roll does not read the table. Its house rules compile and are stored, but they do not change a pool roll.
- `correctD20Roll` (ADR 0029) refuses a roll that carries a `version`, because it would pick the corrected outcome with the built-in thresholds. The engine reports that the last roll cannot be corrected.
- `overlayHash` covers one roll table and the house rules applied to it, not the whole campaign. Rolls on different tables have different hashes.
- A house rule chooses its attribute by reference (`might.mod`). The table rule it replaces is the one for the attribute rolled.
