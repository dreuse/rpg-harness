# 08 — Storage, events, memory, replay and branches

## SQLite first; Dolt optionally later

SQLite provides a zero-configuration local storage baseline, with WAL, transactions, migrations, FTS search and backups. Store separate per-campaign or shared encrypted/isolated local DBs as appropriate; security tests enforce campaign boundaries. The Dolt storage adapter is M4 and must not reuse Beads' development database.

## Canonical event fields

`id`, `campaignId`, `branchId`, `turnId`, `causationId`, `correlationId`, `actionId`, `actorId`, `logicalTime`, `committedAt`, `schemaVersion`, `type`, `payload`, `visibility`, `rulePackRevision`, `sourceRefs`, `expectedPreviousRevision`.

All mutations are committed atomically along with event append and projection updates. Every action ID is idempotent. Events remain append-only; corrections are new events. Player choice and GM rulings are traceable. Roll results and random draws are logged with outcomes, not retroactively recomputed via a different RNG.

## Knowledge and memory

Facts have provenance and visibility. Separate canon from beliefs, rumors and invalidated claims. Player knowledge increases through discovery events. Retrieval combines live scene, active quests and NPCs, world facts and relevant historical events with bounded context. Full-text search first; embeddings optional behind adapter. Summaries are derived caches and cannot overwrite truth.

## Branching

Branches share immutable historical ancestry up to a checkpoint and then diverge. Store branch-specific projections and append new branch events. Checkpoint restore/fork must be non-destructive. A diff compares entity/quest/relationship/resource deltas between snapshots. Scheduled simulator jobs carry branch IDs.

## Recovery

After failed commit, no partial state. After model stops following a commit, re-present committed results without re-executing actions. Migrations use preflight/backups and failure recording. Imports/exports validate schema versions, archive boundaries and rulepack references. Historical replay must compare to materialized state in tests.

## Illustrative API events

See `examples/domain-events.json` and `docs/12-contract-examples.md`.
