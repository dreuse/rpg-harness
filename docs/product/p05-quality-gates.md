# P05 — Quality gates, ADR process and milestones

Traces to: `docs/09-quality-and-testing.md`, `docs/10-roadmap-and-autonomy.md`, `scripts/agent_loop.py`.

## Validation profiles

| Profile | Applies to | Commands (all must exit 0) |
|---|---|---|
| `docs` | Issues whose output is only docs/ADRs (M0, and "Specify"/"Define" issues before V01 exists) | `python3 scripts/validate_plan.py` + reviewer reads the artifact against each acceptance criterion |
| `spike` | Technical spikes | `docs` profile + the spike's own test command + a recorded live run in the spike doc |
| `code` | Any issue that changes code, after V01 | `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` |
| `integration` | Issues touching storage, MCP, model, voice or clients | `code` profile + `pnpm test:integration` |

- `agent_loop.py` picks `docs` for M0 and `code` for later milestones. A doc-only issue in M1+ runs the `code` profile. That is stricter, so it is allowed.
- No profile may be skipped because its commands do not exist yet. A code issue before V01 is blocked, not closed.

## Completion evidence policy

A close reason must contain:

1. Profile name.
2. Changed files or artifact paths.
3. Exact commands and exit status, observed by the orchestrating process (not claimed by a subagent).
4. For spikes and real-model checks: the run command and result summary.
5. Known limits or deferred work, with the Beads ID that owns it.

Never close when a check fails or was not run. Leave the issue in progress and add a note, or file a linked bug with `bd create ... --deps discovered-from:<id>`.

## Milestone gates

| Gate | Exit test (all required) |
|---|---|
| M0 | P01–P05 closed with `docs`/`spike` evidence; `validate_plan.py` passes; ADRs 0001–0007 present |
| M1 | `code` + `integration` profiles green; scripted fake-GM adventure: create campaign → narrate → commit one action → exit → resume, twice in a row with no state loss; one real-Claude run recorded |
| M2 | M1 gate + multi-ruleset and multi-genre fixtures; source-grounded import fixture; dynamic ficha fixture; deterministic world-sim test; branch/replay test; security fixtures from P04 |
| M3 | M2 gate + full-off smoke test; same campaign across CLI/TUI/desktop; voice on/off fixtures; package smoke install on each target OS |
| M4 | M3 gate + SQLite/Dolt `CampaignStore` parity suite + migration round-trip |

A gate passes only when every listed check ran and passed in the same commit.

## ADR process

1. Write an ADR for any decision that changes a module boundary, a storage format, a protocol, an auth route or a capability default.
2. File: `docs/adr/NNNN-short-name.md`. Fields: Status, Decision, Context, Rationale, Consequences.
3. Breaking changes also need a Beads issue that lists migrations, affected tests and compatibility risks.
4. Superseded ADRs stay in place with `Status: Superseded by NNNN`.

## Acceptance evidence for P05

- Criterion 1: gate table, profiles and evidence policy above.
- Criterion 2: `docs`/`spike` profiles are distinct from `code`/`integration`.
- Criterion 3: P01–P04 close reasons follow this policy (see `bd show` for each).
