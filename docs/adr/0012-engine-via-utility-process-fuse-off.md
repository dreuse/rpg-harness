# ADR 0012 — Signed desktop builds turn the RunAsNode fuse off and start the engine through utilityProcess

**Status:** Accepted. Amends ADR 0011. **Decision:** Signed builds ship with the `RunAsNode` Electron fuse off. The Electron main process starts the engine with `utilityProcess.fork`. The CLI and development runs keep the stdio supervisor with `ELECTRON_RUN_AS_NODE`.

**Context:** ADR 0011 and the UI07 spike (open question 1). With the fuse on, any local user can run the signed app as plain Node and inherit its macOS permissions, such as the microphone. Voice is optional, but the app must not widen that exposure for a convenience.

**Rationale:**

- Hardening wins over keeping one spawn path. The fuse is a build-time flag, so the choice must be made before the first signed build.
- The message format does not change. `client-protocol` messages stay one JSON object per message. Only the pipe changes: a `MessagePort` replaces stdin and stdout.
- Keeping the fuse on would need no new code, but it cannot be undone after users install the app.

**Consequences:**

- The desktop shell needs a transport adapter that gives `utilityProcess` the same send and receive interface the supervisor uses over stdio. The supervisor logic (restart bound, shutdown timeout, `CLAUDE_*` filtering) is reused.
- `utilityProcess` takes no `ELECTRON_RUN_AS_NODE`. The environment filter from ADR 0011 still applies through the `env` option.
- Not verified: `utilityProcess` running the engine `.ts` entry with type stripping, and loading it and its `../../../packages` imports from a packaged `asar` archive. This needs a real Electron main process. The follow-up bead covers it. If asar loading fails, unpack the engine with `asarUnpack`.
- Fuse configuration (`@electron/fuses`) belongs to the packaging step and the owner's signing setup (M3).
