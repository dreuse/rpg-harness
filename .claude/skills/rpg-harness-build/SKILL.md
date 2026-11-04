---
name: rpg-harness-build
description: Work through the validated RPG Harness Beads implementation graph, one verified issue at a time
---

# Build RPG Harness

1. Read `CLAUDE.md`, `docs/10-roadmap-and-autonomy.md`, `beads/VALIDATION.md`, then run `bd prime`.
2. Do not import the Beads graph again if tasks already exist. Verify `python3 scripts/validate_plan.py`.
3. Use `bd ready --json` and `bd show` to select highest-priority unblocked **task** in the active milestone; skip epics and out-of-scope work.
4. Claim atomically with `bd update <id> --claim`.
5. Implement exactly that task, honor rule and state integrity, and add tests.
6. Run the independently defined verification profile. If blocked, add details to Beads and do not close.
7. When acceptance criteria pass with evidence, close and continue only within approved budget. Never use unbounded retries or bypassPermissions.

For automated runs, prefer the package's bounded `scripts/agent_loop.py` with explicit execution and review. The loop's auto-close is opt-in and still requires review for subjective criteria.
