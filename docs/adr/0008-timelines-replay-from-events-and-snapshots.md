# ADR 0008 — Timelines replay canonical state from events and versioned snapshots

**Status:** Accepted. **Decision:** A new `timelines` package replays a branch event log through a versioned `Projection`. A `Snapshot` stores the projection version, campaign, branch, event count, last event ID and state. Replay starts from a snapshot only when its version matches; otherwise it replays the full log.

**Context:** T01 needs state rebuilt from events, with roll outcomes read from events and never re-rolled. Persistence projections are written from commits, so they cannot prove replay on their own.

**Rationale:** Snapshots are derived caches, like summaries in `docs/08-storage-and-events.md`. A stale version is a normal upgrade, so it falls back to full replay. A snapshot whose campaign, branch, event count or last event ID does not match the log is rejected with `SnapshotMismatchError`. Recorded rolls are checked with `replayRoll` from `rules`, so `timelines` may import `domain` and `rules`.

**Consequences:** `DomainEvent` and the campaign event type names move to `domain`. Snapshot storage and checkpoint pointers come in T02. Branch ancestry comes in T03.
