# ADR 0011 — Desktop shell is Electron; the engine runs as a supervised Node child over stdio

**Status:** Accepted. **Decision:** The desktop client uses Electron. The main process spawns the engine as a Node 24 child process and supervises it. They exchange `client-protocol` messages as line-delimited JSON over the child's stdin and stdout. The renderer never touches the engine or the database; it gets `client-protocol` types through the main process.

**Context:** UI07 spike (`docs/product/ui07-desktop-packaging-spike.md`). `docs/07-clients-voice.md` named Tauri 2 first and Electron as the fallback if Node embedding is simpler. The engine needs Node 24, `node:sqlite` and native type stripping (P02). ADR 0007 forbids reuse of a consumer Claude login.

**Rationale:**

- Electron 43 ships Node 24.21 with `node:sqlite`. The unchanged engine entry ran under it from the repo checkout. Tauri would need a separate Node sidecar per target, a Rust toolchain and a third runtime, which cancels its size advantage.
- A child process keeps the engine as the only state writer and isolates its crashes from the UI. The supervisor restarts it a bounded number of times.
- Stdio needs no port, no firewall prompt and no loopback auth token, and it matches the MCP transport from P03. Loopback would add all three.

**Consequences:**

- `apps/cli/src/desktop-daemon.ts` holds the spike supervisor and engine entry. It is a starting point for `apps/desktop`, not a finished shell.
- The supervisor drops all `CLAUDE_*` variables plus `ANTHROPIC_AUTH_TOKEN`, `CLAUDECODE` and `ENABLE_CLAUDEAI_MCP_SERVERS`, in any letter case. The engine refuses to start if one reaches it. Provider auth is `ANTHROPIC_API_KEY` or the fake GM.
- Inside Electron the supervisor sets `ELECTRON_RUN_AS_NODE=1`, so it needs the `RunAsNode` fuse on. If the fuse is turned off for hardening, the engine starts through `utilityProcess`. The message format stays the same; only the pipe changes. This ADR is then amended.
- Not verified: the supervisor inside an Electron main process, and type stripping of the engine `.ts` files and their relative `../../../packages` imports from a packaged `asar` archive.
- Windows and Linux installers, signing, notarization and updates are not verified. They need CI runners and owner accounts (M3 package smoke test).
