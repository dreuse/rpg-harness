# ADR 0015 — Voice settings are campaign changes saved through the engine

**Status:** Accepted. **Decision:** `ClientSession` gets a `SaveVoiceSettings` command with `microphone`, `spokenOutput`, `locale`, `speed` and an optional `consentGrantedAt`. The engine command `saveVoiceSettings` validates the settings with `toSavedVoiceSettings`. It writes a `VoiceSettingsSaved` event through the new `CampaignStore.recordChange`. `recordChange` checks the revision, advances it, and appends a campaign event with no turn. `CampaignSnapshot.voice` returns the latest saved settings.

**Context:** A21 needs explicit microphone consent before the first capture. Voice settings must survive a restart and show in the TUI and the desktop. The engine is the only state writer, and `voice` and `client-protocol` may not import engine or persistence internals.

**Rationale:** A turn commit (the ADR 0009 path) would add a conversation turn for every settings change. A campaign change follows the `renameCampaign` precedent: the log keeps causality and the stale-revision check still holds, but no turns are added. The engine rejects a microphone other than `off` without `consentGrantedAt`, so no client can save capture without consent. The allow-list strips unknown fields, so provider keys never reach the event log. Provider ids stay in client provider config, outside campaign data.

**Consequences:** The module table stays the same. Each client shows a consent prompt before it saves a microphone mode. Declining saves the microphone as `off`, and text play keeps working. `VoiceSettingsSaved` uses the default `gm` visibility, so player subscribers get no push. Clients read the settings from the snapshot. `recordChange` has no idempotent `actionId` replay.
