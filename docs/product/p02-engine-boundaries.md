# P02 — Engine boundaries and domain architecture

Traces to: `docs/02-architecture.md`, `docs/08-storage-and-events.md`, ADR 0002, ADR 0005.

## Canonical state owner

`engine` is the only module that writes canonical state. It writes through the `CampaignStore` port inside one transaction per turn. Every other module reads snapshots or submits proposals.

Exception until V05 (rpg-e0g): `mcp` writes `campaign` and `event_log` directly for `create_campaign` and `rename_campaign`, because no engine exists yet. V05 must route these through the engine and remove the write access.

## Modules and allowed imports

An arrow means "may import". No other imports are allowed.

| Module | Owns | May import |
|---|---|---|
| `domain` | IDs, entities, event types, invariants | nothing |
| `rules` | RulePack loading, dice, checks | `domain` |
| `engine` | Turn state machine, validation, commit | `domain`, `rules` |
| `persistence` | `CampaignStore` adapter (SQLite, later Dolt) | `domain` |
| `memory` | Retrieval, visibility filters | `domain` |
| `narrative` | `GameMaster` adapter, Narrative Director | `domain`, `memory` |
| `world` | WorldActor planners, scheduler | `domain` |
| `imports` | Document staging, extraction, provenance | `domain`, `rules` |
| `client-protocol` | Commands, events, view descriptors | `domain` |
| `voice` | STT/TTS adapters | `client-protocol` |
| `mcp` | Typed campaign tools for the terminal harness | `domain`, `persistence` |
| `apps/*` | Wiring (composition root) | any package |

`narrative`, `world`, `voice`, `imports` and `client-protocol` never import `persistence` or `engine` internals. They talk to the engine only through the ports below. V01 adds an automated import check for this table.

## Ports

| Port | Direction | Implemented by | Rule |
|---|---|---|---|
| `CampaignStore` | engine → storage | `persistence` | Only `engine` receives a write handle |
| `GameMaster` | engine → model | `narrative` (Claude, fake GM) | Returns `ActionProposal` and narration text only |
| `RulePackRuntime` | engine → rules | `rules` | Pure, deterministic; RNG is injected and seeded |
| `Rng` | rules → source | `rules`, `testkit` | Every draw is recorded in an event |
| `ActorPlanner` | world → engine | `world` | Returns proposals; the engine validates them |
| `AudioInputProvider` | voice → client | `voice` | Yields transcripts; never commits |
| `AudioOutputProvider` | client → voice | `voice` | Speaks committed utterances only |
| `ClientSession` | client ↔ engine | `client-protocol` | `GetCampaignSnapshot`, `SubmitPlayerAction`, `SelectCapability`, `RequestView`, `SubscribeEvents` |

## Turn data flow

```text
client --SubmitPlayerAction--> engine
engine --snapshot (visibility filtered)--> GameMaster
GameMaster --ActionProposal--> engine
engine --resolve--> RulePackRuntime (+ Rng)
engine --validate(expectedRevision, actionId)--> CampaignStore (one transaction:
        append events + update projections + bump revision)
engine --CommittedTurn--> GameMaster (narrate committed effects only)
engine --events--> client (render), voice (speak)
```

States: `RECEIVED → INTERPRETED → RULES_RESOLVED → VALIDATED → COMMITTED → NARRATED → PRESENTED`.

- A failure before `COMMITTED` writes nothing and returns a typed error.
- A failure after `COMMITTED` re-narrates from stored events. It never re-executes.
- A repeated `actionId` returns the stored `CommittedTurn`.
- A stale `expectedRevision` is rejected; the GM may re-propose.

## Who cannot mutate state

| Component | Can mutate canonical state? | Enforcement |
|---|---|---|
| UI renderers (CLI/TUI/desktop) | No | Receive `client-protocol` types only |
| Voice adapters | No | No engine or store import |
| Model provider (Claude) | No | Only returns proposals; MCP tools expose reads plus `submit_proposal` |
| WorldActor planners | No | Proposals go through the engine |
| Importers | No canonical game state | Write staged RulePack drafts, activated by an engine command |

## Acceptance evidence

- This document defines modules, ports, owner and flow (criterion 1).
- The "who cannot mutate" table plus the import rule cover criterion 2. V01 turns the import rule into a test. G-epic adds fake-GM tests that a proposal alone changes nothing.

## Open questions

1. One SQLite file per campaign or one shared file? Decide in V03 (ADR 0001 allows both).
2. Does `memory` own FTS indexes, or does `persistence`? Decide in D epic.
