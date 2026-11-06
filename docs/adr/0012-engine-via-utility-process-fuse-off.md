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
- **GM MCP server (rpg-42a.78, rpg-42a.143):** With the fuse off, `ELECTRON_RUN_AS_NODE=1` is ignored, and no Node binary can read a file inside `app.asar`. When the MCP entry sits inside an `.asar` archive, the engine process (the utility process) hosts the game tools itself. For each Claude Code call it starts the server from `apps/mcp-server/src/host.ts` on `127.0.0.1` with a random port and a random bearer token, and passes `--mcp-config` with `type: http`, the URL and the token. It stops the server when the call ends. The config file is mode 0600 and is deleted after the call. The tools stay read-only (`READ_ONLY_GAME_TOOLS`) and the engine stays the only state writer. If the server cannot start, the GM narrates from the context packet alone. CLI and development runs keep the stdio server. Chosen over a second Node binary or an `asarUnpack`ed entry run by a bundled Node, which cost size, signing and notarisation. `rpg claude` is interactive and terminal-only, so it passes no game server when its entry sits inside an asar.
- **Packaging note (owner):** the archive must contain `@modelcontextprotocol/sdk` and its dependencies, resolved from `packages/mcp/node_modules`. Check that the packager follows that symlink.
