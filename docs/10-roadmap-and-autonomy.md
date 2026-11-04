# 10 — Milestones, Beads workflow and bounded autonomous loop

## Milestone roadmap

| Gate | Deliverable | Entry criteria | Exit criteria |
|---|---|---|---|
| M0 | Architecture + graph | Source plan extracted | ADRs and 155 tasks/306 blocking edges validated |
| M1 | First playable | M0 passes | Campaign create → one committed action → process restart → resume |
| M2 | Complete core | M1 passes | Deterministic rules, import, ficha, intent, optional living world, CLI, event history/branches |
| M3 | Multi-modal supported | M2 passes | Cross-platform desktop/TUI and voice integration, tests and packaging |
| M4 | Optional Dolt backend | M3 passes | Storage contract parity, branch/commit, safe migrations |

Avoid estimates tied to calendar time. The graph establishes sequencing by prerequisites, not a promise of engineer-hours.

## How tasks are represented

- Epics group issues without blocking their own children.
- `parent_key` creates Beads hierarchy; explicit `blocks` edges enforce real technical prerequisites.
- Task IDs such as `W04` are stable *planning keys* and are retained in Beads metadata; real Beads IDs are minted on import.
- Each task includes goal/scope, architecture notes, three acceptance criteria, validation guidance, priority, milestone and labels.
- Use `beads/catalog.json` for inspection and `beads/beads-graph.json` as the **one-time atomic import**.
- After import, Beads is authoritative for development statuses, discovered bugs, splits and dependencies. Do not hand-edit generated files expecting live Beads updates.

## Worker loop (single writer first)

1. Find ready task via `bd ready --json`, explicitly filter epics and optional post-release tasks until milestone scope.
2. Claim atomically (`bd update <id> --claim`).
3. Read `bd show <id>`, specs, source files and acceptance criteria.
4. Implement one cohesive change (or document) with model using scoped permissions.
5. Run independent test commands; collect stdout/stderr, exit status and errors.
6. Compare evidence with acceptance checklist; if incomplete, leave open/in progress and annotate. Never mark complete merely because Claude said it worked.
7. On success, save evidence and close with reason; commit coherent Git diff if Git is configured and user permission permits.
8. Stop when max issues, failure threshold, runtime budget or no ready eligible tasks is reached.

Default unattended loop should be a *bounded run*, not an infinite daemon. Allow resume using Beads states; lease recovery and crash diagnostics must be explicit.

## Local driver

`python3 scripts/agent_loop.py --dry-run` inspects the next eligible task. `--execute` actually runs `claude -p` on one issue, then external verification. It is intentionally conservative:

- Will not run if Beads or Claude CLI is missing.
- Will not auto-close work without passing real verification commands.
- Requires the user to deliberately opt into execution and configure adequate permissions.
- Pauses after a bounded number of failures and tasks.
- Excludes epics and M4 by default; defaults to only M0/M1 when starting implementation.
- Writes logs under `.rpg-agent-runs/` (exclude from Git and user exports).
- Performs no remote pushes, installs or destructive operations on its own.

The driver is a starting point, not a formally verified scheduling service. Read its implementation and run on a disposable clone first. For multi-worker execution, add explicit worktree ownership and merge gates after proving single-worker stability.

## Critical path

P01 → P02 → P03/P04 → P05 → V01 → V02/V03 → V04 → V05 → V06 → V07 → V08 is the first playable route. The M2 graph has parallel strands for schema/persistence, mechanics, import, sheets, intent, scenario and world simulation. The M3 graph fans into client protocol and voice after the core GM is stable.

## Planning refinements

Do not re-plan everything on each Claude session. Use ADRs for architectural decisions and add linked Beads defects for discoveries. Splits are acceptable only if preserving existing parent acceptance and dependency semantics. Prioritize M1 even if new attractive feature proposals appear.

## Stop conditions

Stop and report for missing credentials, expired model usage budgets, destructive migrations, permission changes, incompatible third-party licensing, tests that cannot pass, stalled claims, repeated model failures or unresolved product contradictions. Prefer partial verified implementation over fabricated completion.
