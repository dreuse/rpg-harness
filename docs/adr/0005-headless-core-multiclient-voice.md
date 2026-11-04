# ADR 0005 — Headless engine; desktop, TUI and speech as adapters

**Status:** Accepted for design, desktop framework pending spike UI07. **Decision:** Typed client commands/events and declarative views drive all interfaces; voice is STT/TTS adapter over normal action pipeline.

**Rationale:** Prevent duplicated business logic and enable same campaign state across clients. Engine controls dice and state; UI animations and NPC voices only render trusted results. Tauri preferred pending packaging/proxy auth tests; Electron is fallback.

**Consequences:** Multi-platform integration tests, no arbitrary model-generated UI, careful voice interruption semantics and explicit provider auth boundaries.
