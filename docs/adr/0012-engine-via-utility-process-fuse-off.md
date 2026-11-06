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
- Verified on 2026-11-04 (macOS, Electron 45.2.1, embedded Node v24.22.1). A bare Electron main inside an `asar` with `apps/*/src`, `apps/*/package.json` and `packages/**` ran `utilityProcess.fork(<asar>/apps/cli/src/desktop-daemon.ts)`. The engine stripped types, loaded its `../../../packages` imports from the archive and replied `Ready` (`sqlite: true`), `Pong` and `Stopped`, then exited with code 0. Command: `Electron verify.asar`. No `asarUnpack` is needed. The smoke test `rpg-42a.6 packaged asar ...` in `apps/desktop/src/electron-smoke.test.ts` repeats this with the real `electron-main.ts` and checks the window reports `Connected`.
- Fuse configuration (`@electron/fuses`) belongs to the packaging step and the owner's signing setup (M3).
- **GM MCP server (rpg-42a.78):** With the fuse off, `ELECTRON_RUN_AS_NODE=1` is ignored, and no Node binary can read a file inside `app.asar`. Chosen path: when the MCP server entry sits inside an `.asar` archive, the Claude Code route passes no `--mcp-config` (`gameServerLaunchable` in `apps/cli/src/gm-claude-code.ts`). The GM then narrates from the context packet alone; the engine stays the only state writer. Rejected: shipping a second Node binary (size, signing and notarisation cost) and `asarUnpack` plus a bundled Node (same cost). Revisit if tool access proves necessary in packaged builds.
