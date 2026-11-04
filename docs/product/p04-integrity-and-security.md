# P04 — Data integrity and tool security policy

Traces to: `docs/08-storage-and-events.md`, `docs/11-security-and-content.md`, ADR 0002, ADR 0006, `docs/product/p02-engine-boundaries.md`.

## Transactions

1. One turn = one SQLite transaction (`BEGIN IMMEDIATE`).
2. The transaction appends events, updates projections and bumps the branch revision together.
3. Any error rolls back the whole transaction. Narration runs only after commit.
4. Migrations take a backup first and run in their own transaction.

## Idempotency and concurrency

| Field | Rule | Enforcement |
|---|---|---|
| `actionId` | Unique per branch | `UNIQUE(branch_id, action_id)`; repeat returns the stored turn; a repeat with a different action is rejected |
| `expectedRevision` | Must equal current branch revision | Checked inside the transaction; mismatch → `StaleRevision` |
| Events | Append-only | No `UPDATE`/`DELETE` on the events table; corrections are new events |
| RNG draws | Stored in events | Replay reads stored draws; it never re-rolls |
| Branch | Every event and projection row carries `branchId` | Queries require a branch; cross-branch writes fail |

## Fact visibility

| Level | Who may read |
|---|---|
| `public` | Everyone, including exports |
| `player` | Player views and player-facing GM context |
| `gm` | GM context only; never sent to client views |
| `actor-scoped` | The named actor's planner and the GM |

Visibility is filtered in `memory` before data leaves the engine boundary. Renderers never receive data they must hide.

## Capabilities

- Each campaign stores enabled capabilities in `CampaignConfig`.
- The engine rejects proposals that need a disabled capability (`CapabilityDisabled`). The GM then adjudicates narratively.
- Enabling or disabling a capability is an event with provenance.

## Untrusted input

Untrusted: imported documents, fichas, setting text, tool results, transcripts, model output, NPC dialogue.

| Threat | Control |
|---|---|
| Prompt injection in a rulebook | Imported text goes to the model only inside a delimited data block, never as instructions. Import model calls get no tools. |
| Rulebook asks to run a shell command | The rule DSL has no I/O, eval, import or shell primitive. The DSL parser rejects unknown node types. |
| Rulebook references local files | Importers read only files the player passed explicitly. Paths are resolved and must stay under the import root. |
| Archive attacks | Reject symlinks, `..` paths, absolute paths, files above a size limit and unexpected types. Cap total extracted size. |
| Model invents state | Proposals are typed and validated; free text never mutates state. |
| HTML/Markdown in views | Sanitize; block remote resources. |
| MCP tool misuse | Tools are typed, campaign-scoped and read-only except `submit_action`, which goes through the engine. |
| Secrets in logs | Provider keys never enter events, logs or exports. |

## Typed failures

`InvalidRuleDsl`, `UnknownEdition`, `RulePackMissing`, `CapabilityDisabled`, `StaleRevision`, `DuplicateAction` (returns stored turn), `BranchMismatch`, `ImportRejected`, `LowConfidenceTranscript`, `ProviderUnavailable`, `MigrationFailed`. Each leaves state unchanged and lets text play continue.

## Required tests

| Test | Owner epic |
|---|---|
| Malicious rulebook with shell text and `../` paths → no process spawned, no file outside root read | I, Q |
| Retried `actionId` → one set of events | V, D |
| Stale revision → rejected, state unchanged | V, D |
| Crash between append and projection → nothing visible | D |
| `gm` fact never present in a player view payload | D, UI |
| Disabled capability proposal → `CapabilityDisabled` | G |

## Open questions

1. Per-campaign SQLite encryption at rest: needed for M2 or later? Decide in D epic.
