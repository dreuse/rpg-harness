# ADR 0030 — Installed rulesets from an activated import

**Status:** Accepted (rpg-42a.122). **Decision:** An activated rulebook import is saved in the data dir as one installed ruleset. The start options list it next to the built-in packs, and `CreateCampaign` can pin it. A declined or unfinished import saves nothing.

**Context:** `importRules` returned the activated rules and wrote nothing, so the player lost them on exit and no client could choose them.

**Decision details:**
- Storage: `<dataDir>/rulesets/<id>.json` holds `{ manifest, rules }`. The write goes to a temporary file and is renamed, so a crash never leaves a half file.
- Identity: the import runs on a built-in base pack. The installed manifest copies the base capabilities, edition, usage and style. Its id is `<base id>-import-<12 hex of SHA-256 over base pin and rules>` and its revision is the base revision. The same import gives the same id, so installing twice keeps one file. Rules are re-compiled against the installed manifest, so their pin names the installed ruleset, not the base pack.
- Trust: the stored file is untrusted. Load checks the id against `^[a-z0-9][a-z0-9-]{0,127}$`, that the manifest id equals the file name, `validateManifest`, at most 1000 rules and 4 MiB, and re-parses and re-compiles every rule with `parseRuleDsl` and `compileRule`. A bad file is refused on load and left out of the list. It never hides good rulesets.
- Choice without a terminal: the existing conversation already shows a read-only gap report, then accepts (`activate`, refused while gaps remain) or declines. Nothing is enforced and no pack is substituted: a missing ruleset id is `UnknownEdition`.
- Start: `packsIn(dataDir)` returns the built-in packs plus the installed rulesets. `startOptions`, `planStart`, `planResult` and `createCampaignFrom` take it as an optional last argument, which defaults to the built-in packs.

**Consequences:**
- Installed rulesets are never marked recommended. They have no character creation rules, so their start option shows no sheet fields.
- Readers that look a pack up without a data dir (`usageFor` in views and `client-session`, `styleLinesOf`, `creationRulesFor`) use the defaults for an installed ruleset. Passing the data dir to them is a follow-up.
- `rpg new "<pitch>"` resolves built-in packs only.
- Live rule resolution does not read the stored rules yet. `loadInstalledRuleset` is the entry point for that.
