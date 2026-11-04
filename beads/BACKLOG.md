# Complete Beads backlog

**155 implementation tasks**, **16 epics**, **306 blocking dependency links**.

This file is a readable export of the authoritative import plan (`beads-graph.json`). After importing, the live Beads database is the development work tracker.

## Milestones

- **M0:** architecture, plan and dependency gate
- **M1:** first playable / restartable adventure
- **M2:** complete headless RPG + ruleset ingestion + ficha + living world (all runtime capabilities optional)
- **M3:** desktop/TUI/voice + cross-platform release verification
- **M4:** optional Dolt storage adapter


## Epic P — Product requirements and architecture (M0; 5 tasks)

### P01 — Specify product journeys and capability policy
**Priority:** P0 · **Depends on:** none

Outcome: Define personas, onboarding journey, user stories, non-goals and a supported-not-enforced feature matrix. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Define personas, onboarding journey, user stories, non-goals and a supported-not-enforced feature matrix.
- [ ] Unspecified preferences use reversible defaults; no player is forced to enable voice, dice, or simulation.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Create a concrete reviewed design/decision artifact in docs/, trace requirements to interfaces and tests, and record unresolved trade-offs in an ADR.

**Validation:** Check in the design/ADR artifact for P01; cross-check against the product contract, mark open questions, and run scripts/validate_plan.py.

### P02 — Define engine boundaries and domain architecture
**Priority:** P0 · **Depends on:** P01

Outcome: Document ports/adapters, domain modules, canonical state owner, and event/data flow. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Document ports/adapters, domain modules, canonical state owner, and event/data flow.
- [ ] No UI, voice adapter or model provider owns game mechanics or database mutations.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Create a concrete reviewed design/decision artifact in docs/, trace requirements to interfaces and tests, and record unresolved trade-offs in an ADR.

**Validation:** Check in the design/ADR artifact for P02; cross-check against the product contract, mark open questions, and run scripts/validate_plan.py.

### P03 — Spike Claude Code skill, MCP and launch transport
**Priority:** P0 · **Depends on:** P01

Outcome: Demonstrate a local model call via project skill and typed MCP read tool. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Demonstrate a local model call via project skill and typed MCP read tool.
- [ ] Do not conflate Claude Code subscription login with arbitrary third-party app API authentication.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Create a concrete reviewed design/decision artifact in docs/, trace requirements to interfaces and tests, and record unresolved trade-offs in an ADR.

**Validation:** Check in the design/ADR artifact for P03; cross-check against the product contract, mark open questions, and run scripts/validate_plan.py.

### P04 — Define data integrity and tool security policy
**Priority:** P0 · **Depends on:** P02

Outcome: Document transactions, idempotency, fact visibility, capabilities and untrusted document handling. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Document transactions, idempotency, fact visibility, capabilities and untrusted document handling.
- [ ] A malicious rulebook cannot invoke shell commands or expose unrelated local files.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Create a concrete reviewed design/decision artifact in docs/, trace requirements to interfaces and tests, and record unresolved trade-offs in an ADR.

**Validation:** Check in the design/ADR artifact for P04; cross-check against the product contract, mark open questions, and run scripts/validate_plan.py.

### P05 — Define quality gates, ADR process and milestones
**Priority:** P0 · **Depends on:** P02, P03, P04

Outcome: Publish M0-M4 gate contracts, executable validation profiles and issue completion evidence policy. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Publish M0-M4 gate contracts, executable validation profiles and issue completion evidence policy.
- [ ] Planning/documentation issues have distinct verification from code issues.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Create a concrete reviewed design/decision artifact in docs/, trace requirements to interfaces and tests, and record unresolved trade-offs in an ADR.

**Validation:** Check in the design/ADR artifact for P05; cross-check against the product contract, mark open questions, and run scripts/validate_plan.py.


## Epic V — First playable vertical slice (M1; 8 tasks)

### V01 — Bootstrap strict TypeScript workspace and CI basics
**Priority:** P0 · **Depends on:** P05

Outcome: Create pnpm workspace, strict TS setup, test runner, formatting and lint commands. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Create pnpm workspace, strict TS setup, test runner, formatting and lint commands.
- [ ] Clean checkout fails clearly if toolchain prerequisites are missing.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the First playable vertical slice boundary (foundation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for V01: successful behavior 'create pnpm workspace, strict ts setup, test runner, formatting and lint commands', edge case 'clean checkout fails clearly if toolchain prerequisites are missing'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### V02 — Implement basic rpg CLI shell
**Priority:** P0 · **Depends on:** V01

Outcome: Provide launch, new, play, resume and help scaffolding with accessible terminal output. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Provide launch, new, play, resume and help scaffolding with accessible terminal output.
- [ ] Unsupported commands or invalid arguments do not corrupt campaign data.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the First playable vertical slice boundary (foundation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for V02: successful behavior 'provide launch, new, play, resume and help scaffolding with accessible terminal output', edge case 'unsupported commands or invalid arguments do not corrupt campaign data'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### V03 — Implement SQLite local database bootstrap
**Priority:** P0 · **Depends on:** V01

Outcome: Create local SQLite database, versioned migrations and repository connection lifecycle. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Create local SQLite database, versioned migrations and repository connection lifecycle.
- [ ] Interrupted migration can be detected or recovered without deleting user data.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the First playable vertical slice boundary (foundation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for V03: successful behavior 'create local sqlite database, versioned migrations and repository connection lifecycle', edge case 'interrupted migration can be detected or recovered without deleting user data'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### V04 — Expose minimal campaign MCP tools
**Priority:** P0 · **Depends on:** V02, V03

Outcome: MCP tools can create, read and update a tiny test campaign with typed schemas. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] MCP tools can create, read and update a tiny test campaign with typed schemas.
- [ ] Invalid or oversized tool requests are rejected cleanly.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the First playable vertical slice boundary (foundation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for V04: successful behavior 'mcp tools can create, read and update a tiny test campaign with typed schemas', edge case 'invalid or oversized tool requests are rejected cleanly'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### V05 — Implement minimal campaign, character, scene and turn
**Priority:** P0 · **Depends on:** V04

Outcome: Store and retrieve a campaign, character, current scene and single turn. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Store and retrieve a campaign, character, current scene and single turn.
- [ ] Opening the same campaign after process restart yields identical identifiers and state.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the First playable vertical slice boundary (foundation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for V05: successful behavior 'store and retrieve a campaign, character, current scene and single turn', edge case 'opening the same campaign after process restart yields identical identifiers and state'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### V06 — Build initial Claude GM skill
**Priority:** P0 · **Depends on:** V05

Outcome: Skill narrates one scene, reads engine state and interprets one player input. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Skill narrates one scene, reads engine state and interprets one player input.
- [ ] Narration never substitutes for persistent state mutation.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the First playable vertical slice boundary (foundation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for V06: successful behavior 'skill narrates one scene, reads engine state and interprets one player input', edge case 'narration never substitutes for persistent state mutation'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### V07 — Implement first validated action commit
**Priority:** P0 · **Depends on:** V06

Outcome: Player can perform an action and persist a validated corresponding state change. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Player can perform an action and persist a validated corresponding state change.
- [ ] A failed action produces no partial state mutation.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the First playable vertical slice boundary (foundation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for V07: successful behavior 'player can perform an action and persist a validated corresponding state change', edge case 'a failed action produces no partial state mutation'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### V08 — Pass create/play/restart/resume smoke test
**Priority:** P0 · **Depends on:** V07

Outcome: Scripted test creates a campaign, plays multiple turns, exits and resumes. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Scripted test creates a campaign, plays multiple turns, exits and resumes.
- [ ] Duplicate tool calls cannot duplicate the committed action.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the First playable vertical slice boundary (foundation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for V08: successful behavior 'scripted test creates a campaign, plays multiple turns, exits and resumes', edge case 'duplicate tool calls cannot duplicate the committed action'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.


## Epic D — Persistence and canonical memory (M2; 8 tasks)

### D01 — Define versioned campaign database schema
**Priority:** P1 · **Depends on:** V08

Outcome: Implement migrations for campaign, entities, ruleset refs, facts, events, sessions and visibility. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Implement migrations for campaign, entities, ruleset refs, facts, events, sessions and visibility.
- [ ] Upgrades preserve user data and reject incompatible schema versions predictably.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Persistence and canonical memory boundary (memory). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for D01: successful behavior 'implement migrations for campaign, entities, ruleset refs, facts, events, sessions and visibility', edge case 'upgrades preserve user data and reject incompatible schema versions predictably'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### D02 — Implement append-only event repository
**Priority:** P1 · **Depends on:** D01

Outcome: Persist ordered immutable domain events with campaign, timeline, actor and logical time. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Persist ordered immutable domain events with campaign, timeline, actor and logical time.
- [ ] Historical event writes cannot be silently overwritten.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Persistence and canonical memory boundary (memory). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for D02: successful behavior 'persist ordered immutable domain events with campaign, timeline, actor and logical time', edge case 'historical event writes cannot be silently overwritten'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### D03 — Implement typed entity and relationship repositories
**Priority:** P1 · **Depends on:** D01

Outcome: Persist stable-ID NPCs, locations, factions, items and relationships. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Persist stable-ID NPCs, locations, factions, items and relationships.
- [ ] Dangling references and cross-campaign entity access are rejected.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Persistence and canonical memory boundary (memory). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for D03: successful behavior 'persist stable-id npcs, locations, factions, items and relationships', edge case 'dangling references and cross-campaign entity access are rejected'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### D04 — Implement atomic idempotent turn transactions
**Priority:** P0 · **Depends on:** D02, D03

Outcome: Validate preconditions and commit effects/events with revision checks and idempotency keys. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Validate preconditions and commit effects/events with revision checks and idempotency keys.
- [ ] Concurrent turns or retry after timeout do not duplicate inventory or rewards.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Persistence and canonical memory boundary (memory). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for D04: successful behavior 'validate preconditions and commit effects/events with revision checks and idempotency keys', edge case 'concurrent turns or retry after timeout do not duplicate inventory or rewards'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### D05 — Implement facts, beliefs, rumors and knowledge scopes
**Priority:** P1 · **Depends on:** D02, D03

Outcome: Separate canonical facts, character beliefs, player-known facts and GM secrets. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Separate canonical facts, character beliefs, player-known facts and GM secrets.
- [ ] An NPC rumor is not promoted to truth; player tools cannot retrieve secret facts.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Persistence and canonical memory boundary (memory). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for D05: successful behavior 'separate canonical facts, character beliefs, player-known facts and gm secrets', edge case 'an npc rumor is not promoted to truth; player tools cannot retrieve secret facts'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### D06 — Implement bounded relevant context retrieval
**Priority:** P1 · **Depends on:** D04, D05

Outcome: Retrieve current scene, related entities, active threads and provenance with token budget. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Retrieve current scene, related entities, active threads and provenance with token budget.
- [ ] Long campaign retrieval excludes irrelevant history without losing required constraints.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Persistence and canonical memory boundary (memory). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for D06: successful behavior 'retrieve current scene, related entities, active threads and provenance with token budget', edge case 'long campaign retrieval excludes irrelevant history without losing required constraints'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### D07 — Implement historical search and summary projection
**Priority:** P1 · **Depends on:** D06

Outcome: Provide full-text event search, summaries and provenance-preserving condensation. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Provide full-text event search, summaries and provenance-preserving condensation.
- [ ] Summaries cannot alter canonical fact records or claim non-existent evidence.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Persistence and canonical memory boundary (memory). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for D07: successful behavior 'provide full-text event search, summaries and provenance-preserving condensation', edge case 'summaries cannot alter canonical fact records or claim non-existent evidence'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### D08 — Implement recovery, migrations and persistence tests
**Priority:** P1 · **Depends on:** D07

Outcome: Pass crash, duplicate action, migration, backup-read and branch-scoping tests. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Pass crash, duplicate action, migration, backup-read and branch-scoping tests.
- [ ] Interrupted writes remain atomic and a resume returns the last committed turn.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Persistence and canonical memory boundary (memory). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for D08: successful behavior 'pass crash, duplicate action, migration, backup-read and branch-scoping tests', edge case 'interrupted writes remain atomic and a resume returns the last committed turn'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.


## Epic R — Ruleset engine and mechanical resolution (M2; 9 tasks)

### R01 — Define RulePack API and capability manifest
**Priority:** P1 · **Depends on:** V08

Outcome: Specify versioned mechanical contracts, supported primitives and capability introspection. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Specify versioned mechanical contracts, supported primitives and capability introspection.
- [ ] No default d20 stat, dice or combat field is required.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Ruleset engine and mechanical resolution boundary (rules). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for R01: successful behavior 'specify versioned mechanical contracts, supported primitives and capability introspection', edge case 'no default d20 stat, dice or combat field is required'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### R02 — Implement extensible character trait domain
**Priority:** P1 · **Depends on:** R01

Outcome: Model typed traits, resources, tags, conditions and derived fields without hardcoded game stats. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Model typed traits, resources, tags, conditions and derived fields without hardcoded game stats.
- [ ] Narrative-only characters work with zero numerical attributes.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Ruleset engine and mechanical resolution boundary (rules). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for R02: successful behavior 'model typed traits, resources, tags, conditions and derived fields without hardcoded game stats', edge case 'narrative-only characters work with zero numerical attributes'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### R03 — Implement authoritative randomness and roll audit
**Priority:** P1 · **Depends on:** R01

Outcome: Support dice pools, rolls and injectable seeded RNG with event capture. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Support dice pools, rolls and injectable seeded RNG with event capture.
- [ ] Claude cannot supply a fabricated result as a trusted engine roll.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Ruleset engine and mechanical resolution boundary (rules). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for R03: successful behavior 'support dice pools, rolls and injectable seeded rng with event capture', edge case 'claude cannot supply a fabricated result as a trusted engine roll'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### R04 — Implement generic check and action resolution
**Priority:** P0 · **Depends on:** R02, R03, D04

Outcome: Execute typed preconditions, modifiers, resource costs and consequences as deterministic transactions. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Execute typed preconditions, modifiers, resource costs and consequences as deterministic transactions.
- [ ] Invalid action or insufficient resources leaves all state unchanged.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Ruleset engine and mechanical resolution boundary (rules). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for R04: successful behavior 'execute typed preconditions, modifiers, resource costs and consequences as deterministic transactions', edge case 'invalid action or insufficient resources leaves all state unchanged'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### R05 — Implement narrative ruleset
**Priority:** P1 · **Depends on:** R04

Outcome: Run full adventures without mandatory dice, HP, levels, classes or combat. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Run full adventures without mandatory dice, HP, levels, classes or combat.
- [ ] Narrative adjudication is clearly marked rather than masquerading as strict mechanics.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Ruleset engine and mechanical resolution boundary (rules). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for R05: successful behavior 'run full adventures without mandatory dice, hp, levels, classes or combat', edge case 'narrative adjudication is clearly marked rather than masquerading as strict mechanics'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### R06 — Implement original d20-lite ruleset
**Priority:** P1 · **Depends on:** R04

Outcome: Support attributes, difficulty checks, combat turns, resources and progression. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Support attributes, difficulty checks, combat turns, resources and progression.
- [ ] Edge cases such as critical effects and negative modifiers pass deterministic tests.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Ruleset engine and mechanical resolution boundary (rules). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for R06: successful behavior 'support attributes, difficulty checks, combat turns, resources and progression', edge case 'edge cases such as critical effects and negative modifiers pass deterministic tests'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### R07 — Implement original dice-pool-lite ruleset
**Priority:** P1 · **Depends on:** R04

Outcome: Support pool rolls, success counting, complications and configurable thresholds. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Support pool rolls, success counting, complications and configurable thresholds.
- [ ] Zero dice, mixed successes and opposed checks resolve consistently.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Ruleset engine and mechanical resolution boundary (rules). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for R07: successful behavior 'support pool rolls, success counting, complications and configurable thresholds', edge case 'zero dice, mixed successes and opposed checks resolve consistently'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### R08 — Implement inventory, equipment, effects and progression
**Priority:** P1 · **Depends on:** R05, R06, D04

Outcome: Track equipment, resources, effects and progression through ruleset-specific actions. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Track equipment, resources, effects and progression through ruleset-specific actions.
- [ ] Unequipped modifiers disappear; impossible item spend and illegal level-up are rejected.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Ruleset engine and mechanical resolution boundary (rules). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for R08: successful behavior 'track equipment, resources, effects and progression through ruleset-specific actions', edge case 'unequipped modifiers disappear; impossible item spend and illegal level-up are rejected'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### R09 — Verify ruleset isolation and compatibility
**Priority:** P1 · **Depends on:** R07, R08

Outcome: Run same domain test suite across narrative, d20-lite and dice-pool-lite packs. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Run same domain test suite across narrative, d20-lite and dice-pool-lite packs.
- [ ] Switching genre requires no core ruleset change and vice versa.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Ruleset engine and mechanical resolution boundary (rules). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for R09: successful behavior 'run same domain test suite across narrative, d20-lite and dice-pool-lite packs', edge case 'switching genre requires no core ruleset change and vice versa'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.


## Epic G — Game Master and core world engine (M2; 9 tasks)

### G01 — Build canonical GM context assembler
**Priority:** P1 · **Depends on:** D06, R02

Outcome: Construct scoped relevant context for Claude with rules and source references. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Construct scoped relevant context for Claude with rules and source references.
- [ ] No hidden NPC knowledge or GM-only secret appears in player-facing context.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Game Master and core world engine boundary (gameplay). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for G01: successful behavior 'construct scoped relevant context for claude with rules and source references', edge case 'no hidden npc knowledge or gm-only secret appears in player-facing context'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### G02 — Implement natural-language player action interpretation
**Priority:** P1 · **Depends on:** G01, R04

Outcome: Map freeform intent into typed action proposals including unexpected actions. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Map freeform intent into typed action proposals including unexpected actions.
- [ ] Clarify only mechanically consequential ambiguity; do not railroad choices.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Game Master and core world engine boundary (gameplay). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for G02: successful behavior 'map freeform intent into typed action proposals including unexpected actions', edge case 'clarify only mechanically consequential ambiguity; do not railroad choices'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### G03 — Implement persistent NPC goals, knowledge and relationships
**Priority:** P1 · **Depends on:** G01, D05

Outcome: NPC state, memory, relationships and information channels influence dialogue. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] NPC state, memory, relationships and information channels influence dialogue.
- [ ] NPCs cannot act on facts they have not learned.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Game Master and core world engine boundary (gameplay). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for G03: successful behavior 'npc state, memory, relationships and information channels influence dialogue', edge case 'npcs cannot act on facts they have not learned'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### G04 — Implement encounter lifecycle and actions
**Priority:** P1 · **Depends on:** G01, R04

Outcome: Persist encounter initiation, transitions, mechanical turns and resolution. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Persist encounter initiation, transitions, mechanical turns and resolution.
- [ ] Resume mid-encounter without rerolling previously committed mechanics.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Game Master and core world engine boundary (gameplay). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for G04: successful behavior 'persist encounter initiation, transitions, mechanical turns and resolution', edge case 'resume mid-encounter without rerolling previously committed mechanics'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### G05 — Implement quests, objectives and dependencies
**Priority:** P1 · **Depends on:** G02, G04

Outcome: Track active/completed/failed quests and prerequisites linked to events. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Track active/completed/failed quests and prerequisites linked to events.
- [ ] Quest cannot complete twice or activate unmet prerequisites silently.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Game Master and core world engine boundary (gameplay). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for G05: successful behavior 'track active/completed/failed quests and prerequisites linked to events', edge case 'quest cannot complete twice or activate unmet prerequisites silently'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### G06 — Implement logical time, world clocks and consequences
**Priority:** P1 · **Depends on:** G05

Outcome: Advance event clocks and delayed effects only on approved game-time triggers. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Advance event clocks and delayed effects only on approved game-time triggers.
- [ ] Closing the app does not unexpectedly advance game time.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Game Master and core world engine boundary (gameplay). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for G06: successful behavior 'advance event clocks and delayed effects only on approved game-time triggers', edge case 'closing the app does not unexpectedly advance game time'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### G07 — Implement narrative pacing service
**Priority:** P1 · **Depends on:** G03

Outcome: Represent scene tension, pacing intent and player-attention budget without manipulating dice. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Represent scene tension, pacing intent and player-attention budget without manipulating dice.
- [ ] Quiet scenes remain possible even with outstanding world activity.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Game Master and core world engine boundary (gameplay). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for G07: successful behavior 'represent scene tension, pacing intent and player-attention budget without manipulating dice', edge case 'quiet scenes remain possible even with outstanding world activity'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### G08 — Implement GM consistency checks and secret discipline
**Priority:** P1 · **Depends on:** G06, G07, D05

Outcome: Validate narration claims against committed events and known facts. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Validate narration claims against committed events and known facts.
- [ ] Uncommitted damage, impossible equipment and secret leaks are detected.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Game Master and core world engine boundary (gameplay). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for G08: successful behavior 'validate narration claims against committed events and known facts', edge case 'uncommitted damage, impossible equipment and secret leaks are detected'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### G09 — Integrate end-to-end gameplay orchestration
**Priority:** P1 · **Depends on:** G08, D08, R09

Outcome: Commit mechanics before narrated results across combat, investigation and social scenes. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Commit mechanics before narrated results across combat, investigation and social scenes.
- [ ] Model interruption resumes from committed state without duplication.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Game Master and core world engine boundary (gameplay). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for G09: successful behavior 'commit mechanics before narrated results across combat, investigation and social scenes', edge case 'model interruption resumes from committed state without duplication'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.


## Epic U — Player onboarding and CLI experience (M2; 8 tasks)

### U01 — Build accessible interactive CLI foundation
**Priority:** P1 · **Depends on:** V08

Outcome: CLI accepts freeform turns and supports keyboard-friendly history, help and errors. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] CLI accepts freeform turns and supports keyboard-friendly history, help and errors.
- [ ] Gameplay does not require commands for normal actions.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Player onboarding and CLI experience boundary (ux). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for U01: successful behavior 'cli accepts freeform turns and supports keyboard-friendly history, help and errors', edge case 'gameplay does not require commands for normal actions'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### U02 — Implement low-friction quickstart and resume flow
**Priority:** P1 · **Depends on:** U01, N07

Outcome: New users can start with default choices or one-sentence campaign intent. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] New users can start with default choices or one-sentence campaign intent.
- [ ] Missing ruleset files are surfaced honestly instead of invented.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Player onboarding and CLI experience boundary (ux). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for U02: successful behavior 'new users can start with default choices or one-sentence campaign intent', edge case 'missing ruleset files are surfaced honestly instead of invented'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### U03 — Implement conversational and guided character creation
**Priority:** P1 · **Depends on:** U02, S05

Outcome: Create valid characters from descriptions or guided choices. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Create valid characters from descriptions or guided choices.
- [ ] An ambiguous required mechanical choice is asked once, not silently invented.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Player onboarding and CLI experience boundary (ux). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for U03: successful behavior 'create valid characters from descriptions or guided choices', edge case 'an ambiguous required mechanical choice is asked once, not silently invented'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### U04 — Implement campaign management and switching
**Priority:** P1 · **Depends on:** U02, D06

Outcome: Create, list, select, resume and archive campaigns without cross-campaign leakage. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Create, list, select, resume and archive campaigns without cross-campaign leakage.
- [ ] Deletion requires explicit intent and offers backup/export guidance.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Player onboarding and CLI experience boundary (ux). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for U04: successful behavior 'create, list, select, resume and archive campaigns without cross-campaign leakage', edge case 'deletion requires explicit intent and offers backup/export guidance'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### U05 — Implement terminal sheets, inventory, journal and recap
**Priority:** P1 · **Depends on:** U04, S04

Outcome: Read character state, inventory, important events and quests using concise commands. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Read character state, inventory, important events and quests using concise commands.
- [ ] Player-facing views never expose hidden GM-only data.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Player onboarding and CLI experience boundary (ux). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for U05: successful behavior 'read character state, inventory, important events and quests using concise commands', edge case 'player-facing views never expose hidden gm-only data'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### U06 — Implement dice and encounter terminal presentation
**Priority:** P1 · **Depends on:** U03, G04

Outcome: Display trusted rolls, modifiers and encounter outcomes in readable text. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Display trusted rolls, modifiers and encounter outcomes in readable text.
- [ ] Hidden GM rolls and narrative-only rulesets do not expose invented dice.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Player onboarding and CLI experience boundary (ux). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for U06: successful behavior 'display trusted rolls, modifiers and encounter outcomes in readable text', edge case 'hidden gm rolls and narrative-only rulesets do not expose invented dice'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### U07 — Implement import/export, backups and restore
**Priority:** P1 · **Depends on:** U04, D08

Outcome: Round-trip campaigns and rulepack version pins through portable validated archives. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Round-trip campaigns and rulepack version pins through portable validated archives.
- [ ] Untrusted archives cannot write outside application data directory.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Player onboarding and CLI experience boundary (ux). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for U07: successful behavior 'round-trip campaigns and rulepack version pins through portable validated archives', edge case 'untrusted archives cannot write outside application data directory'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### U08 — Implement packaged rpg launch and setup checks
**Priority:** P1 · **Depends on:** U06, U07

Outcome: Provide single-command play, install docs, first-run checks and clean error messages. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Provide single-command play, install docs, first-run checks and clean error messages.
- [ ] System works without background services or user-managed SQLite setup.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Player onboarding and CLI experience boundary (ux). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for U08: successful behavior 'provide single-command play, install docs, first-run checks and clean error messages', edge case 'system works without background services or user-managed sqlite setup'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.


## Epic C — Genre and setting packs (M2; 6 tasks)

### C01 — Define genre templates and pack loader
**Priority:** P1 · **Depends on:** G01, R01

Outcome: Load versioned thematic templates independently of the RulePack mechanics. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Load versioned thematic templates independently of the RulePack mechanics.
- [ ] Genre packs cannot execute arbitrary code or mutate engine schemas.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Genre and setting packs boundary (content). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for C01: successful behavior 'load versioned thematic templates independently of the rulepack mechanics', edge case 'genre packs cannot execute arbitrary code or mutate engine schemas'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### C02 — Build fantasy and science-fiction genre packs
**Priority:** P1 · **Depends on:** C01, R05

Outcome: Provide distinct opening scenes, NPC archetypes, conflicts and tone for both. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Provide distinct opening scenes, NPC archetypes, conflicts and tone for both.
- [ ] Both packs can run under narrative rules without assumed spell/space combat mechanics.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Genre and setting packs boundary (content). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for C02: successful behavior 'provide distinct opening scenes, npc archetypes, conflicts and tone for both', edge case 'both packs can run under narrative rules without assumed spell/space combat mechanics'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### C03 — Build horror and investigative mystery packs
**Priority:** P1 · **Depends on:** C01, R05, D05

Outcome: Provide tension, clue tracking, information concealment and investigation pacing. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Provide tension, clue tracking, information concealment and investigation pacing.
- [ ] Secret solutions cannot leak through generic memory retrieval.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Genre and setting packs boundary (content). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for C03: successful behavior 'provide tension, clue tracking, information concealment and investigation pacing', edge case 'secret solutions cannot leak through generic memory retrieval'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### C04 — Build modern adventure and blank world templates
**Priority:** P1 · **Depends on:** C01, R07

Outcome: Support grounded modern stories and entirely user-defined settings. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Support grounded modern stories and entirely user-defined settings.
- [ ] Blank world does not force classes, combat or supernatural elements.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Genre and setting packs boundary (content). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for C04: successful behavior 'support grounded modern stories and entirely user-defined settings', edge case 'blank world does not force classes, combat or supernatural elements'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### C05 — Implement coherent scenario and setting generation
**Priority:** P1 · **Depends on:** C02, C03, C04

Outcome: Generate consistent locations, factions, hooks and starting NPCs with provenance. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Generate consistent locations, factions, hooks and starting NPCs with provenance.
- [ ] Regeneration does not silently replace persistent canon in an existing campaign.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Genre and setting packs boundary (content). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for C05: successful behavior 'generate consistent locations, factions, hooks and starting npcs with provenance', edge case 'regeneration does not silently replace persistent canon in an existing campaign'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### C06 — Verify genre-ruleset combinations and overrides
**Priority:** P1 · **Depends on:** C05, R09

Outcome: Exercise multiple genres with multiple compatible rule systems. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Exercise multiple genres with multiple compatible rule systems.
- [ ] Incompatibilities are reported rather than covered up by fallback d20 rules.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Genre and setting packs boundary (content). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for C06: successful behavior 'exercise multiple genres with multiple compatible rule systems', edge case 'incompatibilities are reported rather than covered up by fallback d20 rules'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.


## Epic T — History, checkpoints, and branching timelines (M2; 6 tasks)

### T01 — Build replayable event projections and checkpoints
**Priority:** P1 · **Depends on:** D08

Outcome: Reconstruct canonical state from events plus versioned snapshots. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Reconstruct canonical state from events plus versioned snapshots.
- [ ] Replay state matches directly materialized state and recorded roll outcomes.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the History, checkpoints, and branching timelines boundary (timelines). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for T01: successful behavior 'reconstruct canonical state from events plus versioned snapshots', edge case 'replay state matches directly materialized state and recorded roll outcomes'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### T02 — Implement checkpoint creation and restoration
**Priority:** P1 · **Depends on:** T01

Outcome: Create, list and restore checkpoint pointers without overwriting history. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Create, list and restore checkpoint pointers without overwriting history.
- [ ] Invalid checkpoint or incompatible version produces no partial restore.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the History, checkpoints, and branching timelines boundary (timelines). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for T02: successful behavior 'create, list and restore checkpoint pointers without overwriting history', edge case 'invalid checkpoint or incompatible version produces no partial restore'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### T03 — Implement branch ancestry and isolation
**Priority:** P1 · **Depends on:** T02

Outcome: Fork campaigns non-destructively with stable branch identifiers and shared ancestry. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Fork campaigns non-destructively with stable branch identifiers and shared ancestry.
- [ ] Background world actions cannot leak across branches.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the History, checkpoints, and branching timelines boundary (timelines). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for T03: successful behavior 'fork campaigns non-destructively with stable branch identifiers and shared ancestry', edge case 'background world actions cannot leak across branches'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### T04 — Implement branch diff and history navigation
**Priority:** P1 · **Depends on:** T03

Outcome: Compare facts, relationships, quests, resources and inventory between two branches. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Compare facts, relationships, quests, resources and inventory between two branches.
- [ ] Historical diff is deterministic and excludes secrets from player view.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the History, checkpoints, and branching timelines boundary (timelines). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for T04: successful behavior 'compare facts, relationships, quests, resources and inventory between two branches', edge case 'historical diff is deterministic and excludes secrets from player view'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### T05 — Implement safe rewind and choose-timeline UX
**Priority:** P1 · **Depends on:** T04, U04

Outcome: Player can fork at checkpoint, inspect ramifications and select active branch. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Player can fork at checkpoint, inspect ramifications and select active branch.
- [ ] Rewind preserves previous timeline and presents clear confirmation of branch choice.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the History, checkpoints, and branching timelines boundary (timelines). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for T05: successful behavior 'player can fork at checkpoint, inspect ramifications and select active branch', edge case 'rewind preserves previous timeline and presents clear confirmation of branch choice'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### T06 — Stress-test branch replay, recovery and isolation
**Priority:** P1 · **Depends on:** T05

Outcome: Run forks, retries, restarts and replay consistency tests. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Run forks, retries, restarts and replay consistency tests.
- [ ] No branch corruption even with concurrent scheduled world events.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the History, checkpoints, and branching timelines boundary (timelines). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for T06: successful behavior 'run forks, retries, restarts and replay consistency tests', edge case 'no branch corruption even with concurrent scheduled world events'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.


## Epic I — Rulebook ingestion and house rules (M2; 14 tasks)

### I01 — Specify importer file formats and provenance model
**Priority:** P1 · **Depends on:** P01, P02

Outcome: Define PDF, DOCX, text, Markdown, YAML and JSON ingest journey with failure states. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Define PDF, DOCX, text, Markdown, YAML and JSON ingest journey with failure states.
- [ ] User content is untrusted and cannot imply permission to execute instructions.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Rulebook ingestion and house rules boundary (import). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for I01: successful behavior 'define pdf, docx, text, markdown, yaml and json ingest journey with failure states', edge case 'user content is untrusted and cannot imply permission to execute instructions'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### I02 — Implement multi-document import staging
**Priority:** P1 · **Depends on:** I01, V03

Outcome: Stage multiple files with type/size validation, integrity hashes and source identity. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Stage multiple files with type/size validation, integrity hashes and source identity.
- [ ] Path traversal, oversized payload and unsupported file types produce safe errors.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Rulebook ingestion and house rules boundary (import). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for I02: successful behavior 'stage multiple files with type/size validation, integrity hashes and source identity', edge case 'path traversal, oversized payload and unsupported file types produce safe errors'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### I03 — Extract text, tables, pages and image fallback
**Priority:** P1 · **Depends on:** I02, D01

Outcome: Preserve page/section references, extraction confidence and tabular structure. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Preserve page/section references, extraction confidence and tabular structure.
- [ ] Scanned material is marked incomplete if vision fallback is unavailable.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Rulebook ingestion and house rules boundary (import). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for I03: successful behavior 'preserve page/section references, extraction confidence and tabular structure', edge case 'scanned material is marked incomplete if vision fallback is unavailable'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### I04 — Define declarative rule DSL and compiler boundaries
**Priority:** P0 · **Depends on:** I01, R01

Outcome: Define typed expressions for dice, comparisons, resources, conditions and rule effects. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Define typed expressions for dice, comparisons, resources, conditions and rule effects.
- [ ] No arbitrary JS/Python execution from user-authored rulebooks.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Rulebook ingestion and house rules boundary (import). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for I04: successful behavior 'define typed expressions for dice, comparisons, resources, conditions and rule effects', edge case 'no arbitrary js/python execution from user-authored rulebooks'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### I05 — Implement provenance-aware AI rule interpretation
**Priority:** P1 · **Depends on:** I03, I04

Outcome: Convert source clauses into draft mechanics with exact source references and uncertainty. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Convert source clauses into draft mechanics with exact source references and uncertainty.
- [ ] Interpretations lacking clear evidence remain flagged, not authoritative.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Rulebook ingestion and house rules boundary (import). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for I05: successful behavior 'convert source clauses into draft mechanics with exact source references and uncertainty', edge case 'interpretations lacking clear evidence remain flagged, not authoritative'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### I06 — Implement ambiguity and conflicting-source review
**Priority:** P1 · **Depends on:** I05

Outcome: Report unknown editions, competing definitions, errata conflicts and suggested decisions. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Report unknown editions, competing definitions, errata conflicts and suggested decisions.
- [ ] An ambiguous official edition cannot be silently converted to another edition.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Rulebook ingestion and house rules boundary (import). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for I06: successful behavior 'report unknown editions, competing definitions, errata conflicts and suggested decisions', edge case 'an ambiguous official edition cannot be silently converted to another edition'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### I07 — Implement safe rule DSL compiler and runtime
**Priority:** P1 · **Depends on:** I04, R04

Outcome: Compile supported primitives to deterministic validated mechanics and test hooks. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Compile supported primitives to deterministic validated mechanics and test hooks.
- [ ] Unsupported card/token/custom mechanics are explicitly flagged or provided by approved plugins.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Rulebook ingestion and house rules boundary (import). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for I07: successful behavior 'compile supported primitives to deterministic validated mechanics and test hooks', edge case 'unsupported card/token/custom mechanics are explicitly flagged or provided by approved plugins'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### I08 — Implement rule import validation and preview
**Priority:** P1 · **Depends on:** I06, I07

Outcome: Generate import summary, executable coverage report and source-backed tests. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Generate import summary, executable coverage report and source-backed tests.
- [ ] Player can decline activation when material mechanics remain unresolved.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Rulebook ingestion and house rules boundary (import). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for I08: successful behavior 'generate import summary, executable coverage report and source-backed tests', edge case 'player can decline activation when material mechanics remain unresolved'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### I09 — Implement layered house-rule overlays and undo
**Priority:** P1 · **Depends on:** I08, D04

Outcome: Apply user overrides to versioned effective rules without changing source docs. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Apply user overrides to versioned effective rules without changing source docs.
- [ ] Undo restores prior effective rule and never rewrites historical rolls.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Rulebook ingestion and house rules boundary (import). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for I09: successful behavior 'apply user overrides to versioned effective rules without changing source docs', edge case 'undo restores prior effective rule and never rewrites historical rolls'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### I10 — Implement ruleset revisions and campaign migration
**Priority:** P1 · **Depends on:** I09, D08

Outcome: Pin ruleset versions and preview/apply compatible or explicit migrations. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Pin ruleset versions and preview/apply compatible or explicit migrations.
- [ ] Incompatible sheet fields block silent migration.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Rulebook ingestion and house rules boundary (import). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for I10: successful behavior 'pin ruleset versions and preview/apply compatible or explicit migrations', edge case 'incompatible sheet fields block silent migration'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### I11 — Implement conversational and CLI import/edit workflow
**Priority:** P1 · **Depends on:** I08, U01

Outcome: Import files, preview rules, change mechanics and select effective ruleset using conversation. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Import files, preview rules, change mechanics and select effective ruleset using conversation.
- [ ] User does not need to write schema by hand; import never silently completes with gaps.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Rulebook ingestion and house rules boundary (import). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for I11: successful behavior 'import files, preview rules, change mechanics and select effective ruleset using conversation', edge case 'user does not need to write schema by hand; import never silently completes with gaps'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### I12 — Connect effective imported mechanics to GM and engine
**Priority:** P1 · **Depends on:** I08, I10, G01

Outcome: GM selects and cites imported rules while engine resolves supported mechanics. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] GM selects and cites imported rules while engine resolves supported mechanics.
- [ ] Unsupported mechanics use visibly designated adjudication, never a fake deterministic check.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Rulebook ingestion and house rules boundary (import). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for I12: successful behavior 'gm selects and cites imported rules while engine resolves supported mechanics', edge case 'unsupported mechanics use visibly designated adjudication, never a fake deterministic check'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### I13 — Implement supplement order, editions and errata
**Priority:** P1 · **Depends on:** I05, I10

Outcome: Support precedence of campaign overrides, options, errata, supplements and base texts. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Support precedence of campaign overrides, options, errata, supplements and base texts.
- [ ] Version conflicts require explicit resolution; mixed editions are not merged silently.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Rulebook ingestion and house rules boundary (import). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for I13: successful behavior 'support precedence of campaign overrides, options, errata, supplements and base texts', edge case 'version conflicts require explicit resolution; mixed editions are not merged silently'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### I14 — End-to-end imported rulebook and edit tests
**Priority:** P1 · **Depends on:** I11, I12, I13

Outcome: Import multi-document rules, play, change house rules, restart and verify source references. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Import multi-document rules, play, change house rules, restart and verify source references.
- [ ] Failed conversion or malicious source cannot change canonical state or access tools.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Rulebook ingestion and house rules boundary (import). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for I14: successful behavior 'import multi-document rules, play, change house rules, restart and verify source references', edge case 'failed conversion or malicious source cannot change canonical state or access tools'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.


## Epic N — Natural-language campaign intent (M2; 10 tasks)

### N01 — Define structured CampaignIntent and preference schema
**Priority:** P1 · **Depends on:** P01, P02

Outcome: Represent ruleset+edition, genre, mood, simulation, pacing, character and optional features. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Represent ruleset+edition, genre, mood, simulation, pacing, character and optional features.
- [ ] Unspecified capabilities remain defaulted, not interpreted as explicit consent.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Natural-language campaign intent boundary (intent). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for N01: successful behavior 'represent ruleset+edition, genre, mood, simulation, pacing, character and optional features', edge case 'unspecified capabilities remain defaulted, not interpreted as explicit consent'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### N02 — Implement natural-language campaign intent parser
**Priority:** P1 · **Depends on:** N01, G01

Outcome: Extract complex one-sentence requests into typed proposed settings with confidence. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Extract complex one-sentence requests into typed proposed settings with confidence.
- [ ] Mixed requests such as dynamic world plus relaxed pacing are not treated as contradictory.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Natural-language campaign intent boundary (intent). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for N02: successful behavior 'extract complex one-sentence requests into typed proposed settings with confidence', edge case 'mixed requests such as dynamic world plus relaxed pacing are not treated as contradictory'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### N03 — Implement ruleset, genre and capability registry
**Priority:** P1 · **Depends on:** N01, R01, C01

Outcome: Match installed rulepack/genre versions and advertised optional capabilities. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Match installed rulepack/genre versions and advertised optional capabilities.
- [ ] Absent commercial editions are not claimed installed or accurately enforced.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Natural-language campaign intent boundary (intent). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for N03: successful behavior 'match installed rulepack/genre versions and advertised optional capabilities', edge case 'absent commercial editions are not claimed installed or accurately enforced'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### N04 — Implement system and edition resolution
**Priority:** P1 · **Depends on:** N02, N03

Outcome: Resolve exact, aliased, misspelled and ambiguous RPG version requests. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Resolve exact, aliased, misspelled and ambiguous RPG version requests.
- [ ] Unknown 'D&D 1.9' requests clarification rather than guessing official mechanics.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Natural-language campaign intent boundary (intent). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for N04: successful behavior 'resolve exact, aliased, misspelled and ambiguous rpg version requests', edge case 'unknown 'd&d 1.9' requests clarification rather than guessing official mechanics'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### N05 — Implement compatibility and preference conflict detection
**Priority:** P1 · **Depends on:** N03, N04

Outcome: Explain requested combinations that are unsupported by active rules or UI. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Explain requested combinations that are unsupported by active rules or UI.
- [ ] A voice-disabled or dice-free campaign cannot be forced into incompatible settings.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Natural-language campaign intent boundary (intent). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for N05: successful behavior 'explain requested combinations that are unsupported by active rules or ui', edge case 'a voice-disabled or dice-free campaign cannot be forced into incompatible settings'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### N06 — Implement minimal-clarification defaults
**Priority:** P1 · **Depends on:** N05

Outcome: Ask only blocking questions and propose reversible default settings. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Ask only blocking questions and propose reversible default settings.
- [ ] Long questionnaires are never required just to start a narrative campaign.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Natural-language campaign intent boundary (intent). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for N06: successful behavior 'ask only blocking questions and propose reversible default settings', edge case 'long questionnaires are never required just to start a narrative campaign'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### N07 — Generate and validate versioned campaign config
**Priority:** P1 · **Depends on:** N06, D04

Outcome: Store effective config, provenance of explicit/default choices and capability decisions. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Store effective config, provenance of explicit/default choices and capability decisions.
- [ ] Invalid inferred options do not produce a campaign or override user intent.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Natural-language campaign intent boundary (intent). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for N07: successful behavior 'store effective config, provenance of explicit/default choices and capability decisions', edge case 'invalid inferred options do not produce a campaign or override user intent'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### N08 — Implement conversational mid-game settings changes
**Priority:** P1 · **Depends on:** N07, G09

Outcome: Change simulation, tone, combat frequency or voice settings via dialogue. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Change simulation, tone, combat frequency or voice settings via dialogue.
- [ ] Config changes preserve prior events and check rulepack compatibility.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Natural-language campaign intent boundary (intent). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for N08: successful behavior 'change simulation, tone, combat frequency or voice settings via dialogue', edge case 'config changes preserve prior events and check rulepack compatibility'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### N09 — Integrate one-sentence setup into onboarding
**Priority:** P1 · **Depends on:** N07, U02

Outcome: From single prompt to scene opening without manual JSON editing. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] From single prompt to scene opening without manual JSON editing.
- [ ] Ruleset not present triggers import/choice instead of invented rules enforcement.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Natural-language campaign intent boundary (intent). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for N09: successful behavior 'from single prompt to scene opening without manual json editing', edge case 'ruleset not present triggers import/choice instead of invented rules enforcement'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### N10 — Evaluate ambiguous and adversarial campaign requests
**Priority:** P1 · **Depends on:** N09, I12

Outcome: Test missing editions, unsupported requests, conflicting preferences and vague intent. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Test missing editions, unsupported requests, conflicting preferences and vague intent.
- [ ] Prompt injection in user-provided rules text cannot override intent constraints.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Natural-language campaign intent boundary (intent). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for N10: successful behavior 'test missing editions, unsupported requests, conflicting preferences and vague intent', edge case 'prompt injection in user-provided rules text cannot override intent constraints'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.


## Epic S — Dynamic character sheets / fichas (M2; 12 tasks)

### S01 — Define versioned, ruleset-driven SheetSchema
**Priority:** P1 · **Depends on:** R01, R02

Outcome: Support typed widgets, custom fields, visibility, derived expressions and stable IDs. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Support typed widgets, custom fields, visibility, derived expressions and stable IDs.
- [ ] Narrative character has valid sheet without numerical stats.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Dynamic character sheets / fichas boundary (characters). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for S01: successful behavior 'support typed widgets, custom fields, visibility, derived expressions and stable ids', edge case 'narrative character has valid sheet without numerical stats'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### S02 — Implement canonical character profile persistence
**Priority:** P1 · **Depends on:** S01, D03

Outcome: Persist identity, motivations, background, traits, conditions and rulepack link. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Persist identity, motivations, background, traits, conditions and rulepack link.
- [ ] No second mutable copy of character truth is created by a UI renderer.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Dynamic character sheets / fichas boundary (characters). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for S02: successful behavior 'persist identity, motivations, background, traits, conditions and rulepack link', edge case 'no second mutable copy of character truth is created by a ui renderer'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### S03 — Implement derived stats and dependency evaluation
**Priority:** P1 · **Depends on:** S01, R04

Outcome: Recompute modifiers, bonuses and constraints from referenced attributes and equipment. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Recompute modifiers, bonuses and constraints from referenced attributes and equipment.
- [ ] Cycles, unknown fields or invalid formulas are rejected.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Dynamic character sheets / fichas boundary (characters). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for S03: successful behavior 'recompute modifiers, bonuses and constraints from referenced attributes and equipment', edge case 'cycles, unknown fields or invalid formulas are rejected'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### S04 — Implement dynamic sheet view-model and templates
**Priority:** P1 · **Depends on:** S02, S03

Outcome: Produce renderer-neutral field groups, values, allowed edits and computed descriptors. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Produce renderer-neutral field groups, values, allowed edits and computed descriptors.
- [ ] Private NPC fields and GM-only secrets never appear in player view.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Dynamic character sheets / fichas boundary (characters). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for S04: successful behavior 'produce renderer-neutral field groups, values, allowed edits and computed descriptors', edge case 'private npc fields and gm-only secrets never appear in player view'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### S05 — Implement conversational character builder
**Priority:** P1 · **Depends on:** S04, N07

Outcome: Create validated characters from backstory and ask for necessary mechanical choices. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Create validated characters from backstory and ask for necessary mechanical choices.
- [ ] AI cannot quietly grant unsupported high stats or illegal starting equipment.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Dynamic character sheets / fichas boundary (characters). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for S05: successful behavior 'create validated characters from backstory and ask for necessary mechanical choices', edge case 'ai cannot quietly grant unsupported high stats or illegal starting equipment'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### S06 — Implement existing ficha import and reconciliation
**Priority:** P1 · **Depends on:** S04, I03

Outcome: Extract PDF/image/text/spreadsheet character data and map to sheet schema with review. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Extract PDF/image/text/spreadsheet character data and map to sheet schema with review.
- [ ] Ambiguous handwritten or missing mechanical values require explicit resolution.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Dynamic character sheets / fichas boundary (characters). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for S06: successful behavior 'extract pdf/image/text/spreadsheet character data and map to sheet schema with review', edge case 'ambiguous handwritten or missing mechanical values require explicit resolution'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### S07 — Implement lightweight and detailed NPC sheets
**Priority:** P1 · **Depends on:** S04, G03

Outcome: Support sparse NPC profiles and expand to full schema if narrative role grows. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Support sparse NPC profiles and expand to full schema if narrative role grows.
- [ ] NPC player-facing preview cannot reveal secrets or private goals.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Dynamic character sheets / fichas boundary (characters). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for S07: successful behavior 'support sparse npc profiles and expand to full schema if narrative role grows', edge case 'npc player-facing preview cannot reveal secrets or private goals'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### S08 — Implement character change audit and explicit edits
**Priority:** P1 · **Depends on:** S04, D04

Outcome: Track every resource, backstory and equipment revision with cause and source. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Track every resource, backstory and equipment revision with cause and source.
- [ ] Manual backstory correction is distinguishable from in-world character development.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Dynamic character sheets / fichas boundary (characters). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for S08: successful behavior 'track every resource, backstory and equipment revision with cause and source', edge case 'manual backstory correction is distinguishable from in-world character development'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### S09 — Implement character effects, death and progression
**Priority:** P1 · **Depends on:** S03, R08, S08

Outcome: Apply temporary modifiers, conditions, recovery, mortality and progression per RulePack. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Apply temporary modifiers, conditions, recovery, mortality and progression per RulePack.
- [ ] Death/resurrection and effect stacking honor configured mechanics.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Dynamic character sheets / fichas boundary (characters). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for S09: successful behavior 'apply temporary modifiers, conditions, recovery, mortality and progression per rulepack', edge case 'death/resurrection and effect stacking honor configured mechanics'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### S10 — Implement ficha display and export
**Priority:** P1 · **Depends on:** S04, U05

Outcome: Show sheet on CLI and export structured portable representation with provenance. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Show sheet on CLI and export structured portable representation with provenance.
- [ ] Import/export preserves custom fields without exposing private NPC knowledge.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Dynamic character sheets / fichas boundary (characters). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for S10: successful behavior 'show sheet on cli and export structured portable representation with provenance', edge case 'import/export preserves custom fields without exposing private npc knowledge'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### S11 — Implement ruleset-version sheet migrations
**Priority:** P1 · **Depends on:** S08, I10

Outcome: Preview and apply safe field transformations on new ruleset versions. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Preview and apply safe field transformations on new ruleset versions.
- [ ] Historical sheets and events stay unchanged; incompatible migrations require approval.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Dynamic character sheets / fichas boundary (characters). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for S11: successful behavior 'preview and apply safe field transformations on new ruleset versions', edge case 'historical sheets and events stay unchanged; incompatible migrations require approval'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### S12 — Run character sheets across genre/rule systems
**Priority:** P1 · **Depends on:** S05, S06, S07, S09, S10, S11

Outcome: Validate narrative, d20, pool, imported and unconventional sheets end-to-end. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Validate narrative, d20, pool, imported and unconventional sheets end-to-end.
- [ ] Invalid stats, private fields and divergent branch changes are rejected.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Dynamic character sheets / fichas boundary (characters). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.

**Validation:** Add named tests for S12: successful behavior 'validate narrative, d20, pool, imported and unconventional sheets end-to-end', edge case 'invalid stats, private fields and divergent branch changes are rejected'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.


## Epic W — Optional living-world simulation (M2; 15 tasks)

### W01 — Specify optional world simulator contracts and defaults
**Priority:** P1 · **Depends on:** P02, R01, G01

Outcome: Define logical-time triggers, actor action schema, simulation modes and attention budgets. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Define logical-time triggers, actor action schema, simulation modes and attention budgets.
- [ ] Off means no autonomous activity; world simulation is never mandatory.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional living-world simulation boundary (simulation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.

**Validation:** Add named tests for W01: successful behavior 'define logical-time triggers, actor action schema, simulation modes and attention budgets', edge case 'off means no autonomous activity; world simulation is never mandatory'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### W02 — Implement WorldActor and faction state
**Priority:** P1 · **Depends on:** W01, D03

Outcome: Persist goals, resources, plans, memories, knowledge and decision cooldowns. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Persist goals, resources, plans, memories, knowledge and decision cooldowns.
- [ ] Actors cannot know secret facts without an information path.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional living-world simulation boundary (simulation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.

**Validation:** Add named tests for W02: successful behavior 'persist goals, resources, plans, memories, knowledge and decision cooldowns', edge case 'actors cannot know secret facts without an information path'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### W03 — Implement bounded logical-time scheduler
**Priority:** P1 · **Depends on:** W01, G06, D04

Outcome: Advance scheduled actors and world events on approved in-game time transitions. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Advance scheduled actors and world events on approved in-game time transitions.
- [ ] App shutdown does not advance time; jobs resume idempotently.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional living-world simulation boundary (simulation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.

**Validation:** Add named tests for W03: successful behavior 'advance scheduled actors and world events on approved in-game time transitions', edge case 'app shutdown does not advance time; jobs resume idempotently'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### W04 — Implement deterministic and LLM-driven actor planners
**Priority:** P1 · **Depends on:** W02, W03, G03

Outcome: Generate typed scoped action proposals with deterministic simple behaviors and optional LLM planning. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Generate typed scoped action proposals with deterministic simple behaviors and optional LLM planning.
- [ ] An LLM agent cannot write directly to world state or invent actor resources.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional living-world simulation boundary (simulation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.

**Validation:** Add named tests for W04: successful behavior 'generate typed scoped action proposals with deterministic simple behaviors and optional llm planning', edge case 'an llm agent cannot write directly to world state or invent actor resources'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### W05 — Validate autonomous action preconditions and effects
**Priority:** P1 · **Depends on:** W04, R04

Outcome: Apply ruleset checks, resource costs, concurrency guards and event commits. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Apply ruleset checks, resource costs, concurrency guards and event commits.
- [ ] Invalid or stale proposals do not alter canon.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional living-world simulation boundary (simulation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.

**Validation:** Add named tests for W05: successful behavior 'apply ruleset checks, resource costs, concurrency guards and event commits', edge case 'invalid or stale proposals do not alter canon'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### W06 — Resolve conflicts between simultaneous actors
**Priority:** P1 · **Depends on:** W05

Outcome: Handle contested resources, races and incompatible actions with documented deterministic rules. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Handle contested resources, races and incompatible actions with documented deterministic rules.
- [ ] Two actors cannot spend the same unique item or own exclusive territory simultaneously.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional living-world simulation boundary (simulation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.

**Validation:** Add named tests for W06: successful behavior 'handle contested resources, races and incompatible actions with documented deterministic rules', edge case 'two actors cannot spend the same unique item or own exclusive territory simultaneously'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### W07 — Build Narrative Director event relevance selection
**Priority:** P1 · **Depends on:** W05, G07

Outcome: Classify canonical events as background, emerging, major or critical based on player context. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Classify canonical events as background, emerging, major or critical based on player context.
- [ ] Critical direct effects cannot be suppressed just to hit a pacing target.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional living-world simulation boundary (simulation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.

**Validation:** Add named tests for W07: successful behavior 'classify canonical events as background, emerging, major or critical based on player context', edge case 'critical direct effects cannot be suppressed just to hit a pacing target'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### W08 — Implement pacing, recovery and fairness controls
**Priority:** P1 · **Depends on:** W07

Outcome: Enforce configurable narrative budgets and player attention load without manipulating mechanics. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Enforce configurable narrative budgets and player attention load without manipulating mechanics.
- [ ] Dynamic world with relaxed story pace remains a valid combination.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional living-world simulation boundary (simulation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.

**Validation:** Add named tests for W08: successful behavior 'enforce configurable narrative budgets and player attention load without manipulating mechanics', edge case 'dynamic world with relaxed story pace remains a valid combination'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### W09 — Implement faction goals and strategic world consequences
**Priority:** P1 · **Depends on:** W06, W08

Outcome: Factions negotiate, compete, expand or retreat consistently from resources and goals. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Factions negotiate, compete, expand or retreat consistently from resources and goals.
- [ ] Player intervention changes faction plans instead of forcing predetermined outcomes.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional living-world simulation boundary (simulation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.

**Validation:** Add named tests for W09: successful behavior 'factions negotiate, compete, expand or retreat consistently from resources and goals', edge case 'player intervention changes faction plans instead of forcing predetermined outcomes'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### W10 — Integrate genre and imported rule simulation policies
**Priority:** P1 · **Depends on:** W09, C01, I12

Outcome: World simulation respects time, faction and house-rule constraints where available. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] World simulation respects time, faction and house-rule constraints where available.
- [ ] Unsupported mechanics are adjudicated visibly or simulation capability is disabled.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional living-world simulation boundary (simulation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.

**Validation:** Add named tests for W10: successful behavior 'world simulation respects time, faction and house-rule constraints where available', edge case 'unsupported mechanics are adjudicated visibly or simulation capability is disabled'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### W11 — Implement budgeted agent jobs and recovery
**Priority:** P1 · **Depends on:** W09, D08

Outcome: Limit agent calls, concurrency, retries and spend; resume durable job state. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Limit agent calls, concurrency, retries and spend; resume durable job state.
- [ ] A failed agent cannot stall player turns or duplicate events.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional living-world simulation boundary (simulation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.

**Validation:** Add named tests for W11: successful behavior 'limit agent calls, concurrency, retries and spend; resume durable job state', edge case 'a failed agent cannot stall player turns or duplicate events'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### W12 — Surface world events naturally through GM context
**Priority:** P1 · **Depends on:** W08, W10, G09

Outcome: Reveal relevant information using knowledge scopes and narrative pacing. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Reveal relevant information using knowledge scopes and narrative pacing.
- [ ] No notification floods; undiscovered distant events remain hidden.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional living-world simulation boundary (simulation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.

**Validation:** Add named tests for W12: successful behavior 'reveal relevant information using knowledge scopes and narrative pacing', edge case 'no notification floods; undiscovered distant events remain hidden'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### W13 — Implement player simulation settings and diagnostics
**Priority:** P1 · **Depends on:** W11, W12, N08

Outcome: Off, ambient, balanced, dynamic and custom modes are persisted and editable conversationally. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Off, ambient, balanced, dynamic and custom modes are persisted and editable conversationally.
- [ ] World autonomy, intensity and consequence-severity sliders do not cheat rolls.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional living-world simulation boundary (simulation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.

**Validation:** Add named tests for W13: successful behavior 'off, ambient, balanced, dynamic and custom modes are persisted and editable conversationally', edge case 'world autonomy, intensity and consequence-severity sliders do not cheat rolls'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### W14 — Build deterministic multi-agent simulation tests
**Priority:** P1 · **Depends on:** W10, W11, W13

Outcome: Simulate factions over game days with budgets, conflicts and varying pacing. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Simulate factions over game days with budgets, conflicts and varying pacing.
- [ ] No out-of-order, leaked, or duplicated events even after failed agent call.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional living-world simulation boundary (simulation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.

**Validation:** Add named tests for W14: successful behavior 'simulate factions over game days with budgets, conflicts and varying pacing', edge case 'no out-of-order, leaked, or duplicated events even after failed agent call'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### W15 — Test branching, long-run consistency and restart
**Priority:** P1 · **Depends on:** W14, T06

Outcome: Prove autonomous evolution in separate timelines and persistent paused/resumed sessions. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Prove autonomous evolution in separate timelines and persistent paused/resumed sessions.
- [ ] Cross-branch faction actions never mutate another branch.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional living-world simulation boundary (simulation). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.

**Validation:** Add named tests for W15: successful behavior 'prove autonomous evolution in separate timelines and persistent paused/resumed sessions', edge case 'cross-branch faction actions never mutate another branch'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.


## Epic UI — Headless client API, TUI and desktop (M3; 12 tasks)

### UI01 — Define headless gameplay API and event stream
**Priority:** P1 · **Depends on:** G09

Outcome: Provide versioned commands and typed events for UI clients; support snapshot + subscription. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Provide versioned commands and typed events for UI clients; support snapshot + subscription.
- [ ] Clients cannot bypass the engine or trust unsolicited model state writes.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Headless client API, TUI and desktop boundary (ui). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for UI01: successful behavior 'provide versioned commands and typed events for ui clients; support snapshot + subscription', edge case 'clients cannot bypass the engine or trust unsolicited model state writes'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### UI02 — Define schema-driven view descriptors and registry
**Priority:** P1 · **Depends on:** UI01, S04

Outcome: Represent sheet, inventory, quest, encounter, clock, map and investigation views. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Represent sheet, inventory, quest, encounter, clock, map and investigation views.
- [ ] Renderers reject unapproved arbitrary UI code in imported packs.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Headless client API, TUI and desktop boundary (ui). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for UI02: successful behavior 'represent sheet, inventory, quest, encounter, clock, map and investigation views', edge case 'renderers reject unapproved arbitrary ui code in imported packs'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### UI03 — Build dynamic character sheet UI widgets
**Priority:** P1 · **Depends on:** UI02

Outcome: Render schema-driven fichas with computed labels, conditions and editable approved fields. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Render schema-driven fichas with computed labels, conditions and editable approved fields.
- [ ] Unknown custom fields degrade gracefully without data loss.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Headless client API, TUI and desktop boundary (ui). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for UI03: successful behavior 'render schema-driven fichas with computed labels, conditions and editable approved fields', edge case 'unknown custom fields degrade gracefully without data loss'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### UI04 — Build inventory, journal and rule reference panels
**Priority:** P1 · **Depends on:** UI02, U05

Outcome: Display inventory, quest journal, rule citations and world recap with live updates. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Display inventory, quest journal, rule citations and world recap with live updates.
- [ ] Secret facts are filtered server-side, not hidden only with CSS.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Headless client API, TUI and desktop boundary (ui). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for UI04: successful behavior 'display inventory, quest journal, rule citations and world recap with live updates', edge case 'secret facts are filtered server-side, not hidden only with css'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### UI05 — Build dice, cards and mechanics visualization events
**Priority:** P1 · **Depends on:** UI01, R03

Outcome: Animate trusted engine results for d20, pools and supported non-dice mechanics. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Animate trusted engine results for d20, pools and supported non-dice mechanics.
- [ ] Animation never changes result; hidden rolls respect visibility policy.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Headless client API, TUI and desktop boundary (ui). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for UI05: successful behavior 'animate trusted engine results for d20, pools and supported non-dice mechanics', edge case 'animation never changes result; hidden rolls respect visibility policy'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### UI06 — Implement optional keyboard-driven TUI
**Priority:** P1 · **Depends on:** UI01, UI02, UI05

Outcome: Provide accessible terminal conversation, sheet, log and mechanical indicators. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Provide accessible terminal conversation, sheet, log and mechanical indicators.
- [ ] Text-only and limited terminal environments still work without graphics.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Headless client API, TUI and desktop boundary (ui). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for UI06: successful behavior 'provide accessible terminal conversation, sheet, log and mechanical indicators', edge case 'text-only and limited terminal environments still work without graphics'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### UI07 — Spike Tauri vs Electron packaging and process model
**Priority:** P1 · **Depends on:** V08, UI01

Outcome: Validate Windows/macOS/Linux packaging, daemon lifecycle and Node engine embedding. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Validate Windows/macOS/Linux packaging, daemon lifecycle and Node engine embedding.
- [ ] Desktop does not require unsupported reuse of consumer Claude subscription credentials.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Headless client API, TUI and desktop boundary (ui). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for UI07: successful behavior 'validate windows/macos/linux packaging, daemon lifecycle and node engine embedding', edge case 'desktop does not require unsupported reuse of consumer claude subscription credentials'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### UI08 — Implement desktop app foundation and renderer
**Priority:** P1 · **Depends on:** UI03, UI04, UI07

Outcome: Provide responsive desktop conversation, sheets, panels and campaign selection. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Provide responsive desktop conversation, sheets, panels and campaign selection.
- [ ] Offline / disconnected engine state is shown accurately with safe retry.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Headless client API, TUI and desktop boundary (ui). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for UI08: successful behavior 'provide responsive desktop conversation, sheets, panels and campaign selection', edge case 'offline / disconnected engine state is shown accurately with safe retry'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### UI09 — Implement live state synchronization across clients
**Priority:** P1 · **Depends on:** UI06, UI08, T03

Outcome: Clients subscribe to canonical event revisions and can resume same campaign. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Clients subscribe to canonical event revisions and can resume same campaign.
- [ ] Stale UI action cannot overwrite newer state from another client.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Headless client API, TUI and desktop boundary (ui). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for UI09: successful behavior 'clients subscribe to canonical event revisions and can resume same campaign', edge case 'stale ui action cannot overwrite newer state from another client'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### UI10 — Implement accessibility, localization and UI preferences
**Priority:** P1 · **Depends on:** UI08

Outcome: Support keyboard controls, font scaling, screen reader labels and locale strings. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Support keyboard controls, font scaling, screen reader labels and locale strings.
- [ ] Dynamic fichas are readable without animation or color semantics.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Headless client API, TUI and desktop boundary (ui). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for UI10: successful behavior 'support keyboard controls, font scaling, screen reader labels and locale strings', edge case 'dynamic fichas are readable without animation or color semantics'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### UI11 — Package and smoke-test all desktop platforms
**Priority:** P1 · **Depends on:** UI09, UI10

Outcome: Produce and verify platform-specific installation/launch and local data directory handling. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Produce and verify platform-specific installation/launch and local data directory handling.
- [ ] Missing model-provider configuration never results in data loss.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Headless client API, TUI and desktop boundary (ui). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for UI11: successful behavior 'produce and verify platform-specific installation/launch and local data directory handling', edge case 'missing model-provider configuration never results in data loss'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### UI12 — Complete cross-client end-to-end gameplay tests
**Priority:** P1 · **Depends on:** UI06, UI09, UI11

Outcome: Play campaign in desktop, resume in TUI and compare identical state. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Play campaign in desktop, resume in TUI and compare identical state.
- [ ] No duplicate turns on reconnect, restart or renderer switch.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Headless client API, TUI and desktop boundary (ui). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for UI12: successful behavior 'play campaign in desktop, resume in tui and compare identical state', edge case 'no duplicate turns on reconnect, restart or renderer switch'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.


## Epic A — Optional voice and audio (M3; 20 tasks)

### A01 — Define provider-agnostic audio, privacy and billing contracts
**Priority:** P1 · **Depends on:** UI01, P04

Outcome: Specify STT, TTS, realtime, transcript and voice-profile provider interfaces. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Specify STT, TTS, realtime, transcript and voice-profile provider interfaces.
- [ ] All features remain available with voice completely disabled.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A01: successful behavior 'specify stt, tts, realtime, transcript and voice-profile provider interfaces', edge case 'all features remain available with voice completely disabled'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A02 — Implement microphone capture permissions and device selection
**Priority:** P1 · **Depends on:** A01, UI08

Outcome: Request consent, capture mic input, display state and handle device changes. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Request consent, capture mic input, display state and handle device changes.
- [ ] Permission denial falls back to typing without crash.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A02: successful behavior 'request consent, capture mic input, display state and handle device changes', edge case 'permission denial falls back to typing without crash'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A03 — Implement STT adapters and transcription quality status
**Priority:** P1 · **Depends on:** A01, A02

Outcome: Convert speech to time-stamped text using pluggable local or cloud adapters. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Convert speech to time-stamped text using pluggable local or cloud adapters.
- [ ] Low-confidence recognition requires clarification for consequential actions.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A03: successful behavior 'convert speech to time-stamped text using pluggable local or cloud adapters', edge case 'low-confidence recognition requires clarification for consequential actions'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A04 — Implement push-to-talk and voice turn detection
**Priority:** P1 · **Depends on:** A02, A03

Outcome: Provide push-to-talk and optional hands-free VAD with clear boundaries. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Provide push-to-talk and optional hands-free VAD with clear boundaries.
- [ ] Silence, noise and multiple rapid turns cannot duplicate game actions.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A04: successful behavior 'provide push-to-talk and optional hands-free vad with clear boundaries', edge case 'silence, noise and multiple rapid turns cannot duplicate game actions'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A05 — Implement multilingual voice input and transcript normalization
**Priority:** P1 · **Depends on:** A03

Outcome: Support locale hints and multilingual inputs with faithful named-entity handling. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Support locale hints and multilingual inputs with faithful named-entity handling.
- [ ] User language switch does not silently change rule terminology or names.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A05: successful behavior 'support locale hints and multilingual inputs with faithful named-entity handling', edge case 'user language switch does not silently change rule terminology or names'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A06 — Define TTS adapters and streaming speech contract
**Priority:** P1 · **Depends on:** A01

Outcome: Support provider-neutral synthesized chunks, voice IDs and cancellation. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Support provider-neutral synthesized chunks, voice IDs and cancellation.
- [ ] Unavailable or unaffordable provider gracefully chooses text output.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A06: successful behavior 'support provider-neutral synthesized chunks, voice ids and cancellation', edge case 'unavailable or unaffordable provider gracefully chooses text output'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A07 — Implement output queue and streaming playback
**Priority:** P1 · **Depends on:** A06, UI08

Outcome: Stream ordered utterances, synchronize subtitles and control playback speed. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Stream ordered utterances, synchronize subtitles and control playback speed.
- [ ] Interrupted playback never undoes already committed gameplay state.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A07: successful behavior 'stream ordered utterances, synchronize subtitles and control playback speed', edge case 'interrupted playback never undoes already committed gameplay state'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A08 — Persist narrator and important NPC voice profiles
**Priority:** P1 · **Depends on:** A06, G03

Outcome: Store voice identity, locale, pronunciation and preferred delivery across sessions. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Store voice identity, locale, pronunciation and preferred delivery across sessions.
- [ ] Voice profile remains recognizable while secrets stay private.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A08: successful behavior 'store voice identity, locale, pronunciation and preferred delivery across sessions', edge case 'voice profile remains recognizable while secrets stay private'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A09 — Implement dialogue speaker routing and narration
**Priority:** P1 · **Depends on:** A07, A08, G09

Outcome: Route segments to narration or correct NPC voice after valid commit. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Route segments to narration or correct NPC voice after valid commit.
- [ ] No speaker attribution changes during interrupted output.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A09: successful behavior 'route segments to narration or correct npc voice after valid commit', edge case 'no speaker attribution changes during interrupted output'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A10 — Implement expression, pronunciation and emotion hints
**Priority:** P1 · **Depends on:** A09

Outcome: Use validated SSML-equivalent styles where provider supports them. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Use validated SSML-equivalent styles where provider supports them.
- [ ] Unsupported prosody hints degrade gracefully, without modifying character emotions.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A10: successful behavior 'use validated ssml-equivalent styles where provider supports them', edge case 'unsupported prosody hints degrade gracefully, without modifying character emotions'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A11 — Implement barge-in, interruption and cancellation
**Priority:** P1 · **Depends on:** A04, A07

Outcome: Stop output when player interrupts and preserve exact committed turn boundary. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Stop output when player interrupts and preserve exact committed turn boundary.
- [ ] An interrupted half-heard sentence is not treated as a completed player turn.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A11: successful behavior 'stop output when player interrupts and preserve exact committed turn boundary', edge case 'an interrupted half-heard sentence is not treated as a completed player turn'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A12 — Implement subtitles and transcript synchronization
**Priority:** P1 · **Depends on:** A07, A09

Outcome: Keep text, speaker and timing aligned with playback and searchable history. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Keep text, speaker and timing aligned with playback and searchable history.
- [ ] Users can mute voice and still access full narrative transcript.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A12: successful behavior 'keep text, speaker and timing aligned with playback and searchable history', edge case 'users can mute voice and still access full narrative transcript'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A13 — Implement optional ambient and effect audio layers
**Priority:** P1 · **Depends on:** A07, UI08

Outcome: Provide opt-in ambience, ducking, per-channel volume and accessible silence mode. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Provide opt-in ambience, ducking, per-channel volume and accessible silence mode.
- [ ] Background audio cannot obscure narration or start without user selection.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A13: successful behavior 'provide opt-in ambience, ducking, per-channel volume and accessible silence mode', edge case 'background audio cannot obscure narration or start without user selection'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A14 — Implement conversational voice settings
**Priority:** P1 · **Depends on:** A04, A12, N08

Outcome: Allow typed or spoken changes to mic mode, output mode, locale and speed. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Allow typed or spoken changes to mic mode, output mode, locale and speed.
- [ ] Changing modes mid-session preserves campaign and input continuity.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A14: successful behavior 'allow typed or spoken changes to mic mode, output mode, locale and speed', edge case 'changing modes mid-session preserves campaign and input continuity'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A15 — Implement provider setup, health and secret storage
**Priority:** P0 · **Depends on:** A03, A06

Outcome: Allow local/provider choice, API key safe storage and availability diagnostics. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Allow local/provider choice, API key safe storage and availability diagnostics.
- [ ] No credentials are logged or committed to campaign exports.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A15: successful behavior 'allow local/provider choice, api key safe storage and availability diagnostics', edge case 'no credentials are logged or committed to campaign exports'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A16 — Implement audio caching and consumption budgets
**Priority:** P1 · **Depends on:** A07, A15

Outcome: Cache safe repeated output and show model/voice costs and limits. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Cache safe repeated output and show model/voice costs and limits.
- [ ] A budget cap falls back to text instead of blocking gameplay.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A16: successful behavior 'cache safe repeated output and show model/voice costs and limits', edge case 'a budget cap falls back to text instead of blocking gameplay'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A17 — Implement text fallback and audio failure recovery
**Priority:** P1 · **Depends on:** A11, A12, A16

Outcome: Recover gracefully from STT/TTS timeout, missing device or provider errors. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Recover gracefully from STT/TTS timeout, missing device or provider errors.
- [ ] No gameplay event is committed twice after retry.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A17: successful behavior 'recover gracefully from stt/tts timeout, missing device or provider errors', edge case 'no gameplay event is committed twice after retry'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A18 — Integrate audio with desktop and optional TUI
**Priority:** P1 · **Depends on:** A14, A17, UI06, UI08

Outcome: Desktop supports full voice; TUI supports appropriate audio controls when available. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Desktop supports full voice; TUI supports appropriate audio controls when available.
- [ ] Headless text-only play does not depend on audio stack.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A18: successful behavior 'desktop supports full voice; tui supports appropriate audio controls when available', edge case 'headless text-only play does not depend on audio stack'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A19 — Test accessibility, privacy, latency and cancellation
**Priority:** P1 · **Depends on:** A18

Outcome: Measure latency and test interruptions, transcript correctness and opt-out. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Measure latency and test interruptions, transcript correctness and opt-out.
- [ ] Mic capture is never activated silently or stored indefinitely by default.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A19: successful behavior 'measure latency and test interruptions, transcript correctness and opt-out', edge case 'mic capture is never activated silently or stored indefinitely by default'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### A20 — Verify complete multilingual voice campaigns
**Priority:** P1 · **Depends on:** A19, S12, W14

Outcome: Run mixed text/speech campaign with narrator, persistent NPC voices and resume. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Run mixed text/speech campaign with narrator, persistent NPC voices and resume.
- [ ] Voice toggle, provider failure and game restart preserve canonical state.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional voice and audio boundary (audio). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Client adapters observe engine events and request validated actions; all capability toggles are optional.

**Validation:** Add named tests for A20: successful behavior 'run mixed text/speech campaign with narrator, persistent npc voices and resume', edge case 'voice toggle, provider failure and game restart preserve canonical state'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.


## Epic Q — Verification, security and release (M3; 9 tasks)

### Q01 — Implement foundational CI and fixtures
**Priority:** P1 · **Depends on:** V01, P05

Outcome: Build deterministic fixtures and continuous tests for types, lint, unit and integration. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Build deterministic fixtures and continuous tests for types, lint, unit and integration.
- [ ] Known flaky or missing prerequisite is surfaced, not silently ignored.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Verification, security and release boundary (quality). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Prefer reproducible fake-model fixtures; real-model evaluations are additional evidence.

**Validation:** Add named tests for Q01: successful behavior 'build deterministic fixtures and continuous tests for types, lint, unit and integration', edge case 'known flaky or missing prerequisite is surfaced, not silently ignored'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### Q02 — Implement fake-GM scripted simulation harness
**Priority:** P1 · **Depends on:** V08, Q01

Outcome: Play long scripted sessions without model API calls and inspect committed events. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Play long scripted sessions without model API calls and inspect committed events.
- [ ] Repeated or interrupted fake-model responses cannot duplicate mutations.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Verification, security and release boundary (quality). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Prefer reproducible fake-model fixtures; real-model evaluations are additional evidence.

**Validation:** Add named tests for Q02: successful behavior 'play long scripted sessions without model api calls and inspect committed events', edge case 'repeated or interrupted fake-model responses cannot duplicate mutations'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### Q03 — Implement rules and state invariant suite
**Priority:** P1 · **Depends on:** D08, R09, Q02

Outcome: Verify inventory bounds, secrets, conditions, quest state and idempotent mechanics. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Verify inventory bounds, secrets, conditions, quest state and idempotent mechanics.
- [ ] Malicious or out-of-order state proposals are rejected.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Verification, security and release boundary (quality). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Prefer reproducible fake-model fixtures; real-model evaluations are additional evidence.

**Validation:** Add named tests for Q03: successful behavior 'verify inventory bounds, secrets, conditions, quest state and idempotent mechanics', edge case 'malicious or out-of-order state proposals are rejected'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### Q04 — Run cross-genre integrated campaign simulations
**Priority:** P1 · **Depends on:** G09, U08, C06, I14, S12, W14, Q03

Outcome: Verify fantasy, sci-fi, horror and mystery multi-session campaigns across rulesets. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Verify fantasy, sci-fi, horror and mystery multi-session campaigns across rulesets.
- [ ] Multiple concurrent world clocks and imported house rules retain causal integrity.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Verification, security and release boundary (quality). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Prefer reproducible fake-model fixtures; real-model evaluations are additional evidence.

**Validation:** Add named tests for Q04: successful behavior 'verify fantasy, sci-fi, horror and mystery multi-session campaigns across rulesets', edge case 'multiple concurrent world clocks and imported house rules retain causal integrity'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### Q05 — Implement long-run replay and load tests
**Priority:** P1 · **Depends on:** Q04, T06

Outcome: Stress-test hundreds of turns, branches, retrieval budgets and recovery. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Stress-test hundreds of turns, branches, retrieval budgets and recovery.
- [ ] Performance does not require full history injection into every model prompt.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Verification, security and release boundary (quality). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Prefer reproducible fake-model fixtures; real-model evaluations are additional evidence.

**Validation:** Add named tests for Q05: successful behavior 'stress-test hundreds of turns, branches, retrieval budgets and recovery', edge case 'performance does not require full history injection into every model prompt'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### Q06 — Implement attack-surface and privacy security tests
**Priority:** P0 · **Depends on:** Q04, P04

Outcome: Test malicious documents, untrusted packs, path traversal, local data scope and provider secrets. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Test malicious documents, untrusted packs, path traversal, local data scope and provider secrets.
- [ ] No imported rulebook can override application instructions or access arbitrary files.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Verification, security and release boundary (quality). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Prefer reproducible fake-model fixtures; real-model evaluations are additional evidence.

**Validation:** Add named tests for Q06: successful behavior 'test malicious documents, untrusted packs, path traversal, local data scope and provider secrets', edge case 'no imported rulebook can override application instructions or access arbitrary files'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### Q07 — Run real Claude Game Master evaluations
**Priority:** P1 · **Depends on:** Q05, Q06, N10

Outcome: Evaluate actual player agency, imported mechanics, consistency, pacing and adversarial prompts. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Evaluate actual player agency, imported mechanics, consistency, pacing and adversarial prompts.
- [ ] Subjective success never overrides deterministic test failures.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Verification, security and release boundary (quality). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Prefer reproducible fake-model fixtures; real-model evaluations are additional evidence.

**Validation:** Add named tests for Q07: successful behavior 'evaluate actual player agency, imported mechanics, consistency, pacing and adversarial prompts', edge case 'subjective success never overrides deterministic test failures'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### Q08 — Complete install, API, ruleset and recovery documentation
**Priority:** P1 · **Depends on:** Q07, UI12, A20

Outcome: Verify clean-install quickstart, rulepack authoring and backup and audio/desktop docs. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Verify clean-install quickstart, rulepack authoring and backup and audio/desktop docs.
- [ ] Instructions distinguish subscription-based Claude Code from API-key desktop providers.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Verification, security and release boundary (quality). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Prefer reproducible fake-model fixtures; real-model evaluations are additional evidence.

**Validation:** Add named tests for Q08: successful behavior 'verify clean-install quickstart, rulepack authoring and backup and audio/desktop docs', edge case 'instructions distinguish subscription-based claude code from api-key desktop providers'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### Q09 — Verify complete multimodal release gate
**Priority:** P1 · **Depends on:** Q08, W15, UI12, A20

Outcome: Pass M3 acceptance matrix with all optional capabilities implemented and disabled-mode smoke tests. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Pass M3 acceptance matrix with all optional capabilities implemented and disabled-mode smoke tests.
- [ ] No unresolved P0 critical defect and all runtime components remain optional.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Verification, security and release boundary (quality). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state. Prefer reproducible fake-model fixtures; real-model evaluations are additional evidence.

**Validation:** Add named tests for Q09: successful behavior 'pass m3 acceptance matrix with all optional capabilities implemented and disabled-mode smoke tests', edge case 'no unresolved p0 critical defect and all runtime components remain optional'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.


## Epic X — Optional Dolt game-storage adapter (M4; 4 tasks)

### X01 — Define optional Dolt storage adapter contract
**Priority:** P2 · **Depends on:** Q09

Outcome: Map canonical events, revisions and snapshots to isolated campaign Dolt repository. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Map canonical events, revisions and snapshots to isolated campaign Dolt repository.
- [ ] Beads development database is never reused as user RPG data storage.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional Dolt game-storage adapter boundary (storage). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for X01: successful behavior 'map canonical events, revisions and snapshots to isolated campaign dolt repository', edge case 'beads development database is never reused as user rpg data storage'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### X02 — Implement parity-tested Dolt repositories
**Priority:** P2 · **Depends on:** X01

Outcome: Persist campaigns, facts and events through alternative backend contract suite. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Persist campaigns, facts and events through alternative backend contract suite.
- [ ] Moving from SQLite does not alter mechanic results or event semantics.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional Dolt game-storage adapter boundary (storage). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for X02: successful behavior 'persist campaigns, facts and events through alternative backend contract suite', edge case 'moving from sqlite does not alter mechanic results or event semantics'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### X03 — Integrate native Dolt branch, commit and diff
**Priority:** P2 · **Depends on:** X02

Outcome: Use native Dolt history to support game timeline interface and audits. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Use native Dolt history to support game timeline interface and audits.
- [ ] No silent overwrite of divergent timeline data.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional Dolt game-storage adapter boundary (storage). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for X03: successful behavior 'use native dolt history to support game timeline interface and audits', edge case 'no silent overwrite of divergent timeline data'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

### X04 — Test SQLite/Dolt migration and backend parity
**Priority:** P2 · **Depends on:** X03

Outcome: Import/export representative campaigns with identical canonical projections. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.

**Acceptance criteria**

- [ ] Import/export representative campaigns with identical canonical projections.
- [ ] Round-trip preserves rule versions, hidden facts and ancestry.
- [ ] Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.

**Design:** Implement within the Optional Dolt game-storage adapter boundary (storage). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state.

**Validation:** Add named tests for X04: successful behavior 'import/export representative campaigns with identical canonical projections', edge case 'round-trip preserves rule versions, hidden facts and ancestry'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.

