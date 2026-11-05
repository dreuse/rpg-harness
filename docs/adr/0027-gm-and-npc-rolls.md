# ADR 0027 — GM and NPC rolls

**Status:** Accepted (rpg-42a.89). **Decision:** The GM asks the engine to roll for itself or an NPC with a `gm-roll` proposal. The engine validates it, rolls with the session RNG, records the roll and hands the result back to the GM in the same turn. The GM never invents a number.

**Context:** ADR 0026 covers checks the player makes. NPC attacks, saves the GM calls for an NPC, damage, initiative, random tables and hidden perception checks still came only from narration text.

**Decision details:**
- `gm-roll` proposal: `{ kind, id, roller, reason, visibility, ruleId | expression }`. `roller` is an npc entity id or `gm`. `visibility` is `shown` or `secret`. Exactly one of `ruleId` and `expression` is set.
- The CLI resolves the proposal to a dice expression. A `ruleId` must be in the effective RulePack check rules and maps to that pack's base check dice (`1d20` for d20-lite, `2d6` for dice-pool-lite); an NPC has no sheet, so it rolls without a modifier. An `expression` (`2d6+3`) is parsed by `parseDiceExpression` in `packages/rules` and bound by the same limits as every other pool. A campaign with dice off, or strictness `off` on a RulePack, refuses both.
- `rollForGm` (`packages/engine/src/gm-roll.ts`) checks the roller is `gm` or an npc entity, rolls with the session RNG and commits a hidden system turn holding a `GmRolled` event: `roller`, `rollerName`, `reason`, `visibility`, `expression` and the same `resolution.rolls` shape as `CheckResolved`. It never resolves a pending player offer. A shown roll is stored player-visible; a secret roll is stored GM-only. A shown roll by an npc the player does not know is refused.
- A repeated action id returns the stored roll and never rolls again, so replay and retries are deterministic.
- Two-phase turn: the first GM reply may carry `gm-roll` proposals. The engine rolls them, then asks the GM again with the `GmRolled` events under `results` (secret ones included, since the GM owns them). The second reply is the narration. It must repeat any other proposal; a `gm-roll` in it is ignored. An `outcome` proposal counts as resolved for the as-written check only when its id equals a GM roll id of that turn (read from the roll turn's action id); any other outcome still needs the player's own check. The outcome claim ref is now the outcome id, not its text.
- Secret rolls reach only the GM packet. The client event stream, snapshot, visualization events, TUI and desktop read events through the viewer scope, so a secret roll is absent from them. The player roll mode (`whoRolls`, 42a.83) does not apply; GM rolls always use the engine RNG.
- A shown roll becomes a visualization event whose `final.roller` is the NPC name (or `GM`). The desktop roll tray and the TUI roll line label it ("rolled by Old Tam").

**Consequences:**
- The first GM reply of a dice campaign is not streamed or spoken, because it may be replaced by the post-roll reply. When it holds no `gm-roll`, it is narrated as before.
- Narration text is not scanned for secret numbers; the prompt forbids revealing them. This is the same trust boundary as ADR 0026.
- A campaign with no RulePack has no dice capability today, so it cannot GM-roll. GM-only mode (rpg-42a.82) will enable expression rolls there.
- A rule roll has no modifier and no damage or defense resolution; the GM states a modifier by using an `expression`.
- A refused proposal (unknown roller, unknown rule, dice off) is dropped silently and gives the GM no result line.
