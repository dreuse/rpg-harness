# ADR 0003 — Capability-driven RPG, not a fixed game template

**Status:** Accepted. **Decision:** Ruleset mechanics, genre, presentation and campaign preferences are distinct. Optional capabilities can all be disabled in a campaign.

**Context:** RPG systems differ radically in character sheets, dice, combat, voice and world simulation.

**Rationale:** A ruleset should declare supported capabilities, genre recommends theme, and user settings select an actual experience. One-sentence intent is resolved into a versioned config. No 3-minute wizard.

**Consequences:** All features have disabled-mode tests. UI layouts are schema-driven. Unrecognized requested commercial rules are not silently inferred.

**Amendment (rpg-20j):** A GenrePack may declare `requiredRuleCapabilities`. `checkRequiredCapabilities` in `@rpg/rules` reports the disabled ones with the rule pack id. The check never blocks a campaign and never substitutes d20 rules. The player decides what to do with the report.
