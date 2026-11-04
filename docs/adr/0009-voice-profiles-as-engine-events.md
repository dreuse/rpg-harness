# ADR 0009 — Voice profiles are engine events with an allow-listed shape

**Status:** Accepted. **Decision:** `VoiceProfile` moves to `domain`. `client-protocol` re-exports it, and `voice` imports it from there. The engine command `setVoiceProfile` commits a `VoiceProfileSet` event with `{ speakerId, profile }`. `voiceProfileOf(events, speakerId)` returns the latest profile for the speaker.

**Context:** A08 must keep the narrator and important NPC voices stable across sessions. The narrator is not an entity, so a `relationship` row (the `NpcState` pattern) cannot hold its profile. The engine may not import `voice`, and `voice` may only import `client-protocol`.

**Rationale:** The event log already survives restart, gives causality, and supports idempotent replay through `replayOf`. `toVoiceProfile` copies only the known fields. So API keys, credentials and hidden NPC knowledge never reach the event log or a voice adapter. The locale must be a canonical BCP 47 tag, so the same voice resolves after restart. Speakers are `narrator` or an `npc` entity.

**Consequences:** The module table stays the same. No profile means no event, so text output works as before. Provider credentials stay in provider config, outside campaign data.
