# UI07 — Desktop packaging and process model (spike)

## Result

The engine runs as a Node 24 child process. The shell spawns it, handshakes over stdio, restarts it after a crash and stops it cleanly. The same unchanged `.ts` entry ran under plain Node 24 and under the Node that ships inside Electron. Decision: Electron, see ADR 0011.

| Part | File |
|---|---|
| Engine child entry + supervisor (spawn, handshake, ping, shutdown, crash restart, credential scrub, client-protocol commands) | `apps/cli/src/desktop-daemon.ts` |
| Player client session for one campaign (`openClientSession`) | `apps/cli/src/engine-gateway.ts` |
| Tests (17) | `apps/cli/src/desktop-daemon.test.ts` |
| Decision | `docs/adr/0011-desktop-shell-and-engine-process.md` |

## Evidence (2026-11-04, macOS 26.6.2, arm64)

```bash
node --test apps/cli/src/desktop-daemon.test.ts     # tests 17, pass 17, fail 0
```

Electron embedding check. VS Code is an Electron 43.7.7 app on this machine. Its binary ran in Node mode:

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" \
  -e 'console.log(process.versions.node, process.versions.electron, typeof require("node:sqlite").DatabaseSync)'
# 24.21.0 43.7.7 function

printf '{"id":1,"type":"Ping"}\n{"id":2,"type":"Shutdown"}\n' | \
  ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" apps/cli/src/desktop-daemon.ts
# {"type":"Ready","version":1,"pid":45209,"node":"v24.21.0","sqlite":true,"gm":"fake"}
# {"id":1,"type":"Pong"}
# {"id":2,"type":"Stopped"}     exit 0
```

The same pipe under `node` v24.22.1 gave the same three lines and exit 0. With a `CLAUDE_*` variable present, the entry printed a refusal and exited 3.

Local tooling: `cargo`, `rustc`, `tauri` and `electron` CLIs are not installed. No package was added. No installer was built. No signing or store account exists.

## Platform matrix

| Target | Verified here | Electron installer (electron-builder) | Tauri 2 installer | Needs |
|---|---|---|---|---|
| `darwin` | Engine child under Node 24 and Electron 43 Node; stdio handshake, restart, shutdown | `.dmg`, `.zip` (unverified) | `.app`, `.dmg` (unverified) | Apple Developer ID, notarization, macOS CI runner |
| `win32` | Not verified | NSIS `.exe`, MSI (unverified) | MSI (WiX), NSIS `.exe` (unverified) | Windows CI runner, code-signing certificate |
| `linux` | Not verified | AppImage, `.deb`, `.rpm` (unverified) | AppImage, `.deb`, `.rpm` (unverified) | Linux CI runner; optional signing for repos |

The engine code has no platform branches except the data folder in `setup-check.ts`. The `win32` and `linux` rows still need a smoke install on a real runner (M3 gate).

## Findings

| Topic | Tauri 2 + Node sidecar | Electron |
|---|---|---|
| Node 24 engine embedding | Node is not inside the app. Ship a Node binary or a Node single executable as an `externalBin` sidecar per target triple (unverified). Local Node binary is 117 MB. | Node 24.21 is inside Electron 43 (verified). The engine `.ts` entry runs unchanged with type stripping (verified). |
| `node:sqlite` | Works only if the shipped Node is 24+ (verified for the system Node). | `DatabaseSync` loads in Electron 43 Node mode (verified). |
| Installers per OS | Bundler builds per host OS; no real cross-build (unverified) | electron-builder covers all three; per-OS runners still advised (unverified) |
| Process model | Rust core + system webview + Node sidecar: three runtimes | Main process + renderer + engine child: one runtime (Chromium + Node) |
| Size | Shell is small, but the Node sidecar adds tens of MB per OS (unverified for compressed size) | Electron Framework in VS Code is 494 MB on disk (verified, VS Code build); a minimal app is smaller (unverified) |
| Credential storage | Needs a plugin or Rust crate for OS keychain (unverified) | `safeStorage` uses Keychain, DPAPI or libsecret (unverified) |
| Updater | Updater plugin with signed update manifests (unverified) | `autoUpdater` / electron-updater; macOS needs a signed app (unverified) |
| Toolchain on this machine | Rust not installed | Electron runtime present via VS Code; CLI not installed |

- Transport: stdio with one JSON message per line works with no port, no firewall prompt and no loopback auth. P03 reached the same result for MCP.
- Inside Electron the supervisor adds `ELECTRON_RUN_AS_NODE=1` to the engine env, so `process.execPath` starts Node and not a second app. This depends on the `RunAsNode` fuse (open question 1).
- Not verified: the supervisor running inside an Electron main process, and type stripping of the engine `.ts` files and their relative `../../../packages` imports from a packaged `asar` archive. The live run above started the engine from the repo checkout only.
- Crash detection: the supervisor treats any exit it did not request as a crash. It rejects pending requests, respawns the engine and waits for a new `Ready`. It stops after `MAX_RESTARTS` (3).
- Shutdown: the supervisor sends `Shutdown`. The engine replies `Stopped` and exits 0. After `SHUTDOWN_TIMEOUT_MS` (2000) the supervisor kills it.
- Auth (ADR 0007): the supervisor drops every `CLAUDE_*` variable, plus `ANTHROPIC_AUTH_TOKEN`, `CLAUDECODE` and `ENABLE_CLAUDEAI_MCP_SERVERS`, in any letter case, before spawn. The engine refuses to start if one reaches it. `ANTHROPIC_API_KEY` selects the API GM route; with no key the engine uses the fake GM. Nothing reads `~/.claude`. The test run itself ran inside Claude Code with `CLAUDE_*` variables set, and the engine still started clean.
- The engine is the only state writer. The shell and the renderer get `client-protocol` messages only (P02).

## Decision

Electron. It bundles the Node major the engine needs, with `node:sqlite` and type stripping, so the engine source needs no build step in the checkout. Packaged `asar` loading is still unverified. Tauri saves shell size but must ship Node anyway, adds a Rust toolchain, and adds a third runtime. The engine runs as a child process over stdio line-delimited JSON. Details in ADR 0011.

## Open questions

1. Resolved in ADR 0012. Signed builds turn the `RunAsNode` fuse off and start the engine through `utilityProcess`. Development runs and the CLI keep `ELECTRON_RUN_AS_NODE`. Still unverified: `utilityProcess` running the engine with type stripping from a packaged `asar` archive.
2. The API key reaches the engine as an environment variable. Same-user processes can read it on some OSes. Sending it over stdin after `Ready` is an option.
3. Windows and Linux installs, signing, notarization and updates need CI runners and owner accounts. They stay open for the M3 package smoke test.
4. Resolved for every `ClientSession` command. The wire types live in `packages/client-protocol/src/wire.ts`. The engine opens the campaign named in `RPG_CAMPAIGN` from `RPG_DATA_DIR` (or the default data folder) as the player viewer. The supervisor sends `{"id","type":"Command","command"}` and gets `{"id","type":"Result","result"}`. A subscription pushes `{"id","type":"Event","event"}` lines with the subscribe request id. `{"id","type":"Unsubscribe","subscription"}` stops it. The engine checks every command with `parseCommand`. A bad command, a campaign it does not serve, or no campaign (`no campaign`) gets an `Error` reply. Still open: how the renderer learns the campaign id (`Ready` does not carry it yet).
5. Re-check provider terms before distribution (ADR 0007).
