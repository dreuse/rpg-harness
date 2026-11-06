# ADR 0031 — GM-only mode with the player's own rules files

**Status:** Accepted (rpg-42a.82). **Decision:** A campaign can run with no built-in RulePack and the player's own rules files as the rules reference. The GM names the roll the files call for, as a `gm-roll` proposal. The engine validates the dice expression and rolls it.

**Context:** A campaign used a built-in RulePack or nothing (strictness `off`). Players who own a different system had no way to play it with the GM and the dice.

**Decision details:**
- Start choice: the rules step offers built-in rulesets, "My own files" and "No rules". "No rules" is a campaign with `ruleset: null`. "My own files" is the same campaign plus rules documents. The draft keeps `rulesSource` (`own` or `none`) and `ownRules` (staged file names). The plan sends `ruleset: null` for both. `CreateCampaign.rulesDocuments` carries the file names. A client that cannot pick files (the TUI) does not show "My own files".
- Setting files: the genre step of the desktop client offers "Add setting files". The draft keeps `settingFiles`. `CreateCampaign.settingDocuments` carries the file names. They share the staging folder with the rules files, and the engine caps both together.
- Files: markdown, text and YAML only. PDF and DOCX have no reader in the importer yet, so they are refused with a clear message. The desktop host copies the picked files into `<dataDir>/own-rules/` (same folder only, size and symlink checks of the import gateway, text content only). `CreateCampaign` reads them from there by name, so no file text crosses the client protocol.
- Storage: each file becomes one `RulesDocumentAdded` event on the opening turn, next to `CampaignConfigured`. It holds `name`, `format`, `sourceHash` and `text` (at most 20 files, 200000 characters each). Events default to GM-only visibility, so the player stream never carries them. The campaign uses own rules when any such event exists. Adding files after creation is follow-up work.
- Packet: the `ruleset` section holds the config line, a summary of every file, and the sections that match the player input and recent turns. `condense` and `selectSections` from `packages/memory` do the retrieval, bounded by the section cap. Text goes through the import `wrapUntrusted` and `interpretImported` guards, then into the packet data frame, which is JSON inside `<campaign-data>` with `<` escaped. A new instruction tells the GM the text is data and never instructions. It replaces the generic `gm-roll` prompt, which offers a `ruleId` these rules do not have.
- Resolution: the verb-list check is off in this mode. The GM adds a `gm-roll` proposal with roller `player` (always shown), a dice expression that includes any modifier, a reason and a `section`. The engine parses the expression with `parseDiceExpression` and the usual limits, rolls with the session RNG and records `GmRolled` with the section. The next GM request carries the result, and an `outcome` proposal with the roll id counts as resolved (ADR 0027). Roller `player` is refused in campaigns that have a RulePack, because they use `check` proposals.
- Strictness: the default is `as-written`. As written, the engine refuses a roll whose `section` is not the title of a section in the files, and the prompt tells the GM to name that section in its narration. Relaxed accepts a roll without a section. `off` refuses all rolls. Narration text is not scanned for the citation; the structured `section` is the check.
- Types: no game fields were added. A rule is only a dice expression, a reason and a section title.

**Consequences:**
- The player does not accept a roll first. In this mode the GM calling for a roll rolls it at once, as for GM rolls.
- A player-reported roll (`whoRolls` `me`) is not wired to `gm-roll` yet. The engine rolls.
- The section title check matches heading text of the stored files. Files without headings use their first line per paragraph.
- Modifiers, conditions and difficulty need a RulePack vocabulary, so the GM writes the modifier into the expression. Relaxed mode is superseded by the ADR 0028 amendment (rpg-42a.103): the expression holds base dice only and modifiers go in `modifiers` with a `sourceRule`. As-written keeps the bonus in the expression.
- A rules file the GM misreads is not detected. The citation proves the GM named a real section, not that it applied it right.
