# RPG Harness — Full Development Package

**Status:** implementation-ready plan, **not** an implemented game.  
**Updated:** 2026-11-04  
**Authoring target:** Claude Code + Beads  
**Task graph:** 155 fully specified tasks, 16 epics, 306 blocking dependencies.

A local-first, genre-independent RPG experience with Claude as Game Master and a deterministic, auditable engine as the source of truth. The product supports (but never forces) imported rulebooks, custom mechanics, dynamic character sheets (*fichas*), living-world agents, desktop/TUI, and voice.

## What's included

| Path | Purpose |
|---|---|
| `PROMPT_CLAUDE_CODE.md` | Paste verbatim into Claude Code to begin implementation |
| `CLAUDE.md` | Agent instructions and architecture constraints for the repository |
| `docs/` | Product requirements, architecture, engine, memory, security, UI, voice, simulations, tests, roadmap and ADRs |
| `beads/catalog.json` | Machine-readable task data (logical planning IDs, descriptions, verification and dependencies) |
| `beads/beads-graph.json` | **Atomic Beads import** using the current `bd create --graph` format |
| `beads/BACKLOG.md` | Readable full list of tasks, acceptance criteria and checks |
| `beads/VALIDATION.md` | Graph counts and milestones |
| `scripts/build_catalog.py` | Rebuilds catalog, Beads graph and readable backlog from source specifications |
| `scripts/validate_plan.py` | Checks unique IDs, dependencies, cycles, completeness, graph correspondence |
| `scripts/bootstrap_beads.py` | Checks prerequisites and safely imports task graph into a fresh Beads project |
| `scripts/agent_loop.py` | Bounded single-worker automated execution with verification gates; dry-run by default |
| `.claude/skills/rpg-harness-build/SKILL.md` | Project-local Claude Code orchestration skill |
| `examples/` | Illustrative intent, schema, runtime-event and voice configuration samples |

## Quick start

```bash
# 1. Unzip the package into a NEW empty project directory.
cd rpg-harness-plan

# 2. Inspect the specifications and check the plan.
python3 scripts/validate_plan.py

# 3. Install Beads, Claude Code, Git, Node LTS and pnpm yourself.
#    Check current official documentation before installing.

# 4. Initialize Git / Beads. The importer must run only in the intended project.
git init
bd init
bd prime

# 5. Preview graph import, then explicitly apply once.
python3 scripts/bootstrap_beads.py
python3 scripts/bootstrap_beads.py --apply

# 6. Start Claude Code and paste PROMPT_CLAUDE_CODE.md.
claude
```

**Alternative:** Open Claude Code directly after extracting and paste `PROMPT_CLAUDE_CODE.md`. Tell it to run the plan validator, initialize Beads and import `beads/beads-graph.json` before product implementation. Do not ask it to recreate duplicate issues once imported.

`bootstrap_beads.py` requires a recent Beads CLI supporting `bd create --graph` and safely refuses to import into a database containing pre-existing issues. If the user's installed release does not support graph imports, stop and upgrade or have Claude create issues through supported commands using `beads/catalog.json`; never silently drop dependency links.

## The five milestones

- **M0 — Planning gate:** architecture decisions, validated Beads graph, quality contract.
- **M1 — First playable:** create a campaign, play a scene, commit an action, restart and resume.
- **M2 — Core RPG complete:** rulesets, imported rules/house rules, dynamic fichas, campaign intent, quests, persistent memory, optional living-world simulation, branching and CLI.
- **M3 — Full client release:** cross-platform desktop, TUI, dice/visuals, voice/STT/TTS, installation, integration and security testing.
- **M4 — Advanced storage:** optional Dolt campaign-store adapter (not the Beads database).

The game **can run with every optional capability disabled**. “Supported” means available when explicitly selected or when the player approves a suggested preset, never forced on every campaign.

## Architecture in one sentence

**Player input (typed/spoken) → validated intent → GM action proposal → deterministic RulePack/game-engine resolution → atomic event/state commit → narration/audio/UI presentation.**

A long narrative isn't the authoritative state; structured events and projections are. Narrative Director balances presentation, not physics, rolls or world causality. Imported documents are data, not executable instructions. Voice and interface integrations are adapters.

## Development loop

The Beads graph is the work tracker. Use `bd ready --json` to find unblocked tasks, claim exactly one, implement acceptance criteria, run external checks and close with evidence. For unattended work, see `docs/10-roadmap-and-autonomy.md` and `scripts/agent_loop.py`. Start with a single worker. Do not disable security checks to get the loop running.

```bash
python3 scripts/agent_loop.py --dry-run  # inspect what it would do
python3 scripts/agent_loop.py --execute --max-issues 3 --timeout-seconds 1800
```

The driver is an **implementation aid**, not a guarantee that unreviewed model output is correct. It requires a configured Claude CLI and, after the scaffold exists, executable project validation commands. Explicit user permission is still required for external/destructive operations and credentials.

## Useful references

- Beads: https://github.com/gastownhall/beads
- Beads CLI reference, including `bd create --graph`: https://github.com/gastownhall/beads/blob/main/docs/CLI_REFERENCE.md
- Claude Code documentation: https://code.claude.com/docs/en/
- Claude Code commercial integration/authentication terms: https://code.claude.com/docs/en/legal-and-compliance

No proprietary rulebook content, user files, binaries, or external credentials are bundled.

## Run

```bash
pnpm install
pnpm check:prereqs
pnpm rpg
pnpm rpg new Ember
pnpm rpg play Ember
pnpm rpg help
```

## Test

```bash
pnpm test
```

## Build

```bash
pnpm install --prod --config.node-linker=hoisted --ignore-scripts  # flat install for packaging
pnpm --config.verify-deps-before-run=false package:desktop --platform=darwin --arch=arm64  # writes out/RPG Harness-<platform>-<arch>
ELECTRON_RUN_AS_NODE=1 "out/RPG Harness-darwin-arm64/RPG Harness.app/Contents/MacOS/RPG Harness" "out/RPG Harness-darwin-arm64/RPG Harness.app/Contents/Resources/app/apps/cli/src/bin.ts"  # packaged CLI
```

## Environment

Optional:

```bash
RPG_DATA_DIR=  # default: OS data folder + /rpg, created on first run
XDG_DATA_HOME=
APPDATA=
RPG_LANG=  # default: LC_ALL, LC_MESSAGES, LANG, then the OS locale; en or pt-BR
```
