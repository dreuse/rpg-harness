# ADR 0021 — GM model choice and token usage as campaign data

**Status:** Accepted. Amends ADR 0020. **Decision:** The player picks the GM model, a summary model and a soft token budget per session. The choice is an app default plus an optional per-campaign setting. Each GM turn records the provider's token use and cost as an event in the game database. Clients show session and campaign totals. The budget only warns.

**Context:** rpg-42a.37. Claude Code takes `--model <alias>`. The API takes a model id. The player could not see what a session cost.

## Settings

- A campaign stores its settings as a `GmSettingsSaved` event, written by `engine.saveGmSettings` through `recordChange`. It takes `expectedRevision`, like `SaveVoiceSettings`.
- A save replaces the whole setting. An empty field means "use the app default".
- The app default lives in `gm-settings.json` in the data folder. `rpg settings` without a campaign writes it. The desktop writes it with `SaveGmDefaults`, which takes no `expectedRevision` and never touches the campaign. It holds preferences only, never game state.
- The snapshot sends the campaign setting, the app default and the effective setting apart. The desktop campaign form shows only the campaign setting and shows the app default as a placeholder, so a save never copies the default into the campaign.
- The model resolves in this order: campaign setting, app default, `RPG_GM_MODEL`, the route default. Settings are read on every turn, so a change applies on the next turn.
- `default` means the balanced profile (rpg-42a.59), shown as "Balanced (recommended)". On `claude-code` the harness always passes `--model=sonnet --effort medium` for narration and `--model=haiku --effort low` for summaries, so the player's own Claude Code model and effort never leak in. A chosen model replaces only the model; effort stays balanced.
- On `api` the balanced model is `claude-sonnet-5-5` (summaries `claude-haiku-5-5`). The harness sends no effort parameter there, because support per model is unverified. Add it when the API documents it.
- The summary model defaults to a cheap model: `haiku` on `claude-code` and `claude-haiku-5-5` on `api`. `RPG_SUMMARY_MODEL` overrides both.
- A model value is a short id that starts with a letter or digit. It may hold `.`, `:`, `@` and `/`, as in `claude-sonnet-4@20250514` or `anthropic/claude-x`. It goes into argv only as `--model=<value>`, so it cannot act as a flag.

## Usage

- Each narrated turn appends a `GmUsageRecorded` event with the turn id, a session id, the model, the input, cache read, cache write and output tokens, and the cost when the provider reports it.
- `recordUsage` appends at the current revision and does not bump it. Usage is a fact about the provider call, not a game change, so open clients keep a valid `expectedRevision`.
- Recording usage never throws after the narration is committed. An unknown model id is recorded as `default`. Malformed usage is skipped.
- Usage lives in the campaign database, never in Beads or `.beads`.
- A session id is one UUID per CLI play loop, per TUI run and per desktop engine session.

## Budget

- `sessionBudgetTokens` is optional. When session tokens pass it, the CLI and TUI print one warning, and the desktop shows it as a status line.
- Play never stops. This keeps "everything supported, nothing enforced".

## Rejected

- A per-turn token cap or a hard stop: it would block play.
- Usage in a separate table: the event log already orders and scopes campaign data.
- Bumping the revision per usage record: every GM reply would make the client's pending actions stale.
