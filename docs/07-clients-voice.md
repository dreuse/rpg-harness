# 07 — Terminal, desktop, rendering, dice and voice

## Client strategy

Build a headless engine first. Expose typed commands/events to multiple optional clients:

- **CLI:** very simple text-first commands and prompts, required for M1.
- **TUI:** keyboard-first terminal UI, potentially using OpenTUI after validation.
- **Desktop:** React frontend with Tauri 2 as first packaging candidate, Electron fallback if Node/Claude integration requires simpler process embedding. Validate actual platform installations in a packaging spike.

The same saved campaign must open from another client with identical canonical state. UI subscription receives events and authoritative snapshots. Models never return raw executable HTML to UI.

## Declarative views

`ViewDescriptor` supplies registered widgets such as field group, stat, progress bar, roll display, skill list, item table, relationships, inventory, quest journal, map/location card, clue graph and world clocks. A pack may select layout and labels but not run arbitrary client JavaScript.

**Dice:** The engine returns an authoritative `RollResolved` event with roll IDs, individual RNG results, modifiers, target, visibility and outcome. The UI animates those values; animation never determines the roll. Narrative-only rules don't show dice. Hidden rolls remain hidden.

## Speech architecture

`AudioInputProvider` (push-to-talk or optional VAD) → STT transcripts with timestamps/confidence → normal player intent gateway → validated engine → GM narration → speaker routing → streaming TTS / synchronized subtitles.

Initial path is STT → Claude text → TTS, not an uncontrolled realtime speech model modifying game state. A realtime adapter can be explored later. Voice is completely optional. Players may move between typed, spoken, and silent play mid-turn.

### Voices

Narrator and important NPCs have persistent `VoiceProfile` identifiers with language, pace, style, pronunciation dictionary and provider-specific fallback metadata. No built-in voice cloning without explicit rights/consent. NPC dialogue tags are generated from committed GM response. Sound effects and ambience are independent optional audio channels.

### Player settings

Microphone: off / push-to-talk / hands-free. Spoken output: off / narrator / dialogue / full. Voice language, speed, subtitles, sound effects and provider budget. All default safely with explicit mic permission and visible active status.

### Failure cases

- Low-confidence speech cannot automatically commit high-impact actions.
- Realtime interruption stops audio, not already committed state.
- TTS provider timeout falls back to full text narration.
- Cloud processing and audio retention disclosed. Microphone streams not stored by default.
- Provider API keys are held in the OS credential store or a secure equivalent, not saved in exported campaigns.

## Cross-platform release requirements

Install packages for macOS, Windows and Linux; test app data locations, migrations, cleanup, consent prompts, no-provider fallback and switching clients. Follow official provider licensing/auth guidance. A normal distributed desktop app must support independently authorized model access, not assume that a consumer Claude subscription can be embedded in third-party software.
