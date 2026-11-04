# ADR 0010 — CampaignConfig is saved as a CampaignConfigured event in the opening turn

**Status:** Accepted. **Decision:** `openScene` takes an optional `config`. When present, it appends a `CampaignConfigured` event with `{ config }` to the opening turn, caused by `SceneOpened`. `campaignConfigOf(events)` returns the latest saved config. The CLI validates it with `parseCampaignConfig` before it shows the ruleset and genre on resume.

**Context:** `rpg new` built a `CampaignConfig` but did not save it, so resume could not show the ruleset or genre. The engine may not import `intent`, where `CampaignConfig` lives. `CampaignState.events` only holds turn-scoped events.

**Rationale:** The config and the opening scene commit in one transaction, so a campaign never has one without the other. The store and the module table stay the same. The engine treats the config as opaque data. The CLI parses it on read, so a damaged event log row cannot reach the output.

**Consequences:** Campaigns made before this change have no config event; resume shows the scene only. A later settings change needs its own engine command and event; `campaignConfigOf` already returns the latest one.
