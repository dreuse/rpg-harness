# 02 — Architecture and module contracts

## Overview

```text
Player (CLI / TUI / Desktop / Voice)
           |
           v
Intent / command gateway ----> Campaign preferences + capability registry
           |
           v
GM adapter (Claude first, swappable later)
           | proposes typed actions
           v
RulePack runtime / domain engine / game-time scheduler
           | validates and resolves
           v
Atomic commit --> append-only events --> canonical projections
           |                         |
           v                         v
Narration / audio / client events    Memory retrieval / timeline replay
```

Only the **domain engine** commits authoritative state. No model, UI renderer, NPC planner or voice provider receives raw DB write privileges. The narrative is a consequence/view, not the source of truth.

## Suggested TypeScript monorepo

```text
apps/
  cli/                  # simple rpg play, campaign commands
  tui/                  # optional terminal presentation
  desktop/              # React + Tauri/Electron after packaging spike
  mcp-server/           # Claude tool surface
packages/
  domain/               # entities, IDs, invariants, event types
  engine/               # action orchestration, checks, transaction boundary
  rules/                # RulePack DSL compiler + built-in systems
  imports/              # documents, rulebooks, sheets, provenance
  memory/               # queries, visibility, summaries, history
  world/                # logical time, world actors, faction planner
  narrative/            # GM adapter, Narrative Director, prompt context
  persistence/          # SQLite, event log, migrations, later Dolt
  client-protocol/      # typed commands/events + view descriptors
  voice/                # STT/TTS/streaming interfaces
  testkit/              # fake GM, seeded RNG, fixtures
```

These are boundaries, not mandatory folder names. Keep API contracts stable before parallel development.

## RulePack vs GenrePack vs CampaignConfig

**RulePack:** declares mechanical definitions and capabilities: dice syntax, stats, tests, consequences, progression, turn rules, faction mechanics. Can be built in, compiled from user documents or extended via controlled plugins. Version-pinned.

**GenrePack:** defines setting and style: dark fantasy, sci-fi, horror, investigation. Provides starting archetypes, narrative constraints, examples, visual conventions and suggested capabilities, not mandatory mechanics. A genre may list rule capabilities it depends on (`requiredRuleCapabilities`). A mismatch with the selected RulePack is reported, never enforced and never replaced by d20 rules.

**CampaignConfig:** stores explicit player choices and defaults: selected RulePack revision, GenrePack, pace, world autonomy, impact/intensity, voice, UI presentation, and content boundaries. Settings may change with appropriate validation.

## Domain state

- Stable IDs: campaign, timeline branch, event, turn, actor, character, location, quest, rulepack, equipment.
- Canonical values: structured entities and facts; never infer current gold/HP from chat summaries.
- Historical values: append-only events with immutable recorded dice results and source provenance.
- Derived values: schema-driven projections (HP max, armor, skills, relationships); invalidated through dependency graphs.
- Knowledge layers: objective canon; player-known facts; NPC beliefs/rumors; GM-only secrets.

## Turn state machine

`RECEIVED → INTERPRETED → RULES_RESOLVED → VALIDATED → COMMITTED → NARRATED → PRESENTED`

A failed transition is recorded as a safe error; it is not half committed. `actionId` and `expectedRevision` avoid duplicates/stale proposals. A narration response interrupted after commit is re-rendered from committed effects, not re-executed.

## Simulation boundaries

`WorldActor` is a stored entity with goals and resources. Hybrid planners may propose actions using deterministic policy or a model. The scheduler is game-time-driven, budgets work, and passes proposals through the same engine. Narrative Director labels consequences by importance and knowledge scope; it must never falsify a roll to preserve pacing.

## UI boundary

The client protocol includes `GetCampaignSnapshot`, `SubmitPlayerAction`, `SelectCapability`, `RequestView`, and `SubscribeEvents`. Server-generated UI descriptors use an approved component set (field, group, progress, roll, clock, inventory, relationship, journal). Renderers are responsible for native accessibility and presentation, not business logic.

## Voice boundary

`AudioInputProvider` yields transcripts with confidence/locale. `AudioOutputProvider` accepts speaker-tagged, already-committed utterances. Neither can submit implicit irreversible action on low-confidence recognition. Speech playback can be canceled without undoing a committed turn.

## Delivery and deployment

- Local-first SQLite; migrations and backups bundled.
- Start with a single user and one process. No service mesh, brokers or remote queues.
- Use WebSocket/IPC/subprocess transport appropriate to client after UI07 spike; typed command/event semantics identical across transports.
- Desktop provider auth is independently configured. Initial Claude Code skill/MCP can be used by a terminal user, but is not a blanket license to reuse a consumer subscription inside a distributed app.
- Source imports, audio caching, and temp files must respect system permissions and retention.
