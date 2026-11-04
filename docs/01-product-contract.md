# 01 — Product contract and player experience

## What this is

RPG Harness is a local-first, general-purpose RPG runtime whose Game Master is driven by a model such as Claude, while game rules, character sheets, memory, and world changes are managed by a deterministic application. The user may play in a terminal, TUI, or desktop app and can mix text and speech. It is not a game-specific chatbot wrapper.

## Non-negotiable principles

1. **Support, don't enforce.** Capabilities are explicitly declared and individually selectable. Dice, voice, encounters, autonomous world, maps, numerical attributes, and UI panels may all be absent.
2. **Zero-friction play.** A one-sentence request starts a campaign with reversible defaults, without forms. Clarify only details that would materially change rules or make gameplay impossible.
3. **Rules mean rules.** Imported/built-in mechanics execute through the engine or are transparently labeled GM-adjudicated; never fake exact enforcement.
4. **State survives sessions.** Events, resources, character data, quest changes and known facts persist. Long model context is not a database.
5. **Causal consequences and player agency.** Dynamic world actors can act independently but must follow resources, knowledge, elapsed game time and player interventions.
6. **No surprise costs.** Player controls model/TTS/STT provider budgets and simulation-agent intensity. Unavailable providers degrade to text and/or deterministic behavior.
7. **No forced GUI.** Core play and management work from a simple CLI; desktop/TUI adapt the same domain API.
8. **Privacy and source ownership.** Imported commercial/user documents remain local except when disclosed model processing is requested. No copyrighted rulebooks are bundled.

## Core scenarios

- "Surprise me" → propose/start a compatible fantasy, horror, mystery or sci-fi campaign with lightweight rules and optional narration.
- "I want a D&D 5e adventure in a dynamic world, balanced pacing, as a level 3 rogue" → parse edition and settings, match installed rules, check character validity, then start. Missing source pack → import/choose, never pretend full 5e mechanics are installed.
- "D&D 1.9" → exact edition not recognized: ask concise edition clarification, not silently treat as first edition.
- "Import these three PDFs and use our house rule that critical hits double damage" → stage, extract, synthesize draft mechanics with citations, test, flag gaps and apply a versioned overlay.
- "Here is my ficha" → parse image/PDF/structured sheet; map to rule schema, flag ambiguities and preserve original reference.
- "Make the kingdom politically active, but keep the story relaxed" → increase background simulation while keeping the Narrative Director's attention budget modest.
- "Show me my ficha" → render in current client's native components; no hardcoded d20 UI.
- "Let's talk instead of typing" → opt-in microphone and speech with the same authoritative game loop.

## Capability policy

A capability has `id`, `version`, `requiredDependencies`, `supportedModes`, `recommendedDefaults`, and `permissions`. A pack can recommend a capability but not force it without a well-defined rules-level requirement accepted by the player. Core mandatory infrastructure: safe storage, state validation, context/intent handling, and campaign identity. Everything else is optional **at runtime**. A feature can be required for a release milestone without becoming mandatory for a user's campaign.

## Player journey

1. Choose `rpg play` or open the desktop app.
2. Resume a prior campaign or describe a new one.
3. Resolve requested rules and edition; defaults are shown only if useful.
4. Generate/import character and world; don't require a long wizard.
5. Present immediate scene. User acts naturally. GM proposes, engine validates, resolves and commits, then GM responds.
6. Provide context-aware sheets, inventory, maps, journal, voice and dice when requested or supported.
7. Auto-save and reliably resume. Allow recaps, character edits (with history), rewind and branching.

## Quality targets (initial, subject to profiling)

- No game-state corruption across duplicate/retried actions or interrupted processes.
- All typed action commits atomic and branch-scoped.
- Every player-visible mechanical roll verifiable from recorded RNG event.
- Context retrieval bounded; it does not linearly inject full campaign histories.
- The player can start a no-dice narrative campaign with every optional runtime feature disabled.
- A long scripted campaign can be deterministically replayed and audited.
- UI and voice errors do not mutate canonical state.

## Out of scope initially

Multiplayer networking, persistent real-time offline world progression, a public plugin marketplace, realtime physics/3D maps, proprietary commercial book content, mandatory always-on AI agents, storing unconsented microphone recordings, and distributing an end-user desktop application that impersonates Claude Code authentication.
