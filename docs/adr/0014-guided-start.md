# ADR 0014 — Guided start as one shared wizard over a PlanCampaign dry run

**Status:** Accepted. **Decision:** The desktop and the TUI run one wizard from `packages/client-protocol/src/guided-start.ts`. The engine answers a new unscoped `PlanCampaign` command with the installed options and the resolved choices. `CreateCampaign` stays the only command that writes a campaign.

**Context:** rpg-42a.14. A new player needs to start an adventure without knowing RulePacks, GenrePacks or campaign preferences. The wizard must never substitute an edition, must keep optional features off, and must survive closing the app.

## Flow

| Path | Steps |
|---|---|
| Describe it | describe (one sentence to the intent resolver), summary |
| Guide me | primer, genre, rules, character, features, summary |

- Every step after the path choice has Back and Skip. Skip clears that choice.
- The rules step lists installed RulePacks only. The lightest one (fewest capabilities) is marked "recommended for new players". Other systems point to "Import your rulebook".
- The character step offers the GenrePack archetypes, or one typed description. The RulePack sheet fields show as hints.
- The engine builds the character from that text with the RulePack creation rules. The name is the text before the first comma, or the word after "named". Missing sheet values fail the plan with "Your character needs …". With no creation rules, the summary shows no character.
- The summary lists each setting with "chosen" or "default" from the engine's provenance. Start is enabled only after a successful plan.

## Protocol

- `PlanCampaign` takes the same `intent` or `choices` as `CreateCampaign`, without a name. It returns `StartOptions` (genres, rulesets) and one `PlanEntry` per field: ruleset, genre, character, dice, diceVisualization, voiceOutput, simulation.
- An uninstalled or invalid edition returns `UnknownEdition` from `PlanCampaign` and from the desktop `CreateCampaign`. The wizard shows "Import your rulebook." with the engine message. Nothing is substituted and nothing is written.
- The guide path sends the UI's `client` (`tui` or `desktop`) in `choices`, so capability conflicts match the screen that asked.

## Defaults when every step is skipped

| Field | Value | Provenance |
|---|---|---|
| ruleset | none | default |
| genre | none | default |
| character | none | default |
| dice | as the ruleset decides | default |
| diceVisualization | off | default |
| voiceOutput | off | default |
| simulation | off | default |

## Saved progress

- The draft is `guided-start.json` in the client data directory. It never goes in a campaign database or in `.beads`.
- The TUI writes it after each answer and removes it after Start. `q` saves and stops.
- The desktop main process writes it over the `rpg:start` IPC channel. It saves a draft only when `parseStartDraft` returns it unchanged. It passes the draft back to the page in the `start` query parameter.
- A missing, broken or tampered draft falls back to the first step.

## Rationale

- One pure state machine (`nextDraft`, `startScreen`) keeps both UIs identical and testable without a DOM or terminal.
- A dry run reuses `quickstart.ts` resolution, so the summary shows exactly what `CreateCampaign` will write.
- No new package and no new dependency.
- The desktop summary is a grouped review list built from `StartScreen.review`. Each row carries a chosen or default flag and an Edit action that sends `{ kind: 'edit', step }`. The adventure name saves with Start; there is no Save button.

## Consequences

- The desktop daemon still serves one campaign per process. Playing a new campaign needs `RPG_CAMPAIGN` until the desktop can switch campaigns.
- Wizard copy is English. Desktop controls are translated through the existing catalog.
- The describe path cannot carry a client, so voice asked for in text uses the CLI client rules.
