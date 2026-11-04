# 09 — Verification and acceptance strategy

## Testing pyramid

1. **Pure deterministic unit tests (majority):** rule DSL, dice/RNG, derived fields, action preconditions, layout schema validation, role/knowledge filtering, view-model generation, conflicts and time advancement.
2. **Integration tests:** SQLite/repository transaction boundaries, migration, replay, imported rule documents, voice provider adapter mocks, UI event subscriptions.
3. **Fake GM scripted campaigns:** model adapters return predefined proposals and narrative; test 20+ turn sessions, restarts, branching, interrupts without paid inference.
4. **Real-model evaluations:** assess player agency, storytelling, retrieval relevance, complexity and surprise handling, confidence in interpretations; never a substitute for mechanical assertions.
5. **E2E clients:** terminal, desktop and TUI use same state; voice on/off, pause/reconnect, file imports, ruleset editing.

## Executable quality profiles

Use established monorepo commands after V01 has created them. Suggested package scripts:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm build
```

For Beads issues before V01, use a **docs profile**: files exist and are coherent, `python3 scripts/validate_plan.py` passes, ADRs can be reviewed, and technical spikes include recorded evidence. In automated mode the worker must reject attempts to close code issues when no actual checks exist. Git working tree must be inspected for untracked secrets/irrelevant changes.

## Required fixtures

- In-game theft + faction retaliation persists after restart.
- Ruleset math: d20 modifiers, pools, 3d6 keep/drop, resource spend, hidden GM roll, critical results.
- Improvised player action and no-railroad branching.
- Imported rulebooks with a corrupted table, multiple supplement/errata rules and unsupported mechanics.
- Ficha PDF/image with ambiguous fields; narrative character with zero stats; derived stat changes.
- Player asks for a non-existent rules edition; the resolver requests only essential clarification.
- World actors compete for finite item and scarce territory, with game-time clock and concurrency revisions.
- Dynamic world + relaxed narrative attention; background event flood does not become message flood.
- Branch fork, replay, re-import, migration and corrupted archive recovery.
- UI renderers handle unknown fields, screen readers, hidden facts, client reconnection.
- Voice interrupted before/after commit, low-confidence STT, unavailable TTS, language switching and no-mic permissions.

## Invariants

- Append-only events, idempotent commits and strict branch isolation.
- Narration follows committed mechanics.
- Untrusted rulebooks cannot execute instructions or access files/tools.
- Never force a style or runtime feature; disabling a capability is a tested path.
- Secrets filtered at API boundary, not simply hidden visually.
- GM/actor knowledge is epistemically scoped.
- Voice failure doesn't cost a turn; UI rerender doesn't change dice.
- A campaign cannot reference a silently substituted ruleset or edition.

## Definition of evidence

For each issue, record: issue key/ID, implementation summary, changed files, exact commands and exit statuses observed by the orchestration process, regression scenario, and verification limits. The automated runner uses checks it launches independently; agent-authored test claims alone do not pass the gate.

## Release gates

- M1: scriptable adventure with two consecutive successful save/resume cycles.
- M2: multi-ruleset/multi-genre play, source-grounded rule imports, dynamic ficha, optional simulator with deterministic world test, branching and safety.
- M3: documented cross-platform desktop/TUI, event visualizations and optional voice. Full-off mode smoke tests plus independent client continuity.
- M4: repository parity and migration tests between SQLite/Dolt.

**Note:** M2 and M3 denote *supported features*, not features enabled by default. Team can cut a public early access release at M1/M2 if clearly labeled incomplete, but M3 is the complete scoped feature set.
