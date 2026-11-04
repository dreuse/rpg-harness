# UI08 — Desktop app foundation and renderer

## What exists

| Part | File |
|---|---|
| Renderer state, campaign selection, responsive layout, view model, safe retry | `apps/desktop/src/renderer.ts` |
| Tests (2) | `apps/desktop/src/renderer.test.ts` |
| Engine child + supervisor (UI07) | `apps/cli/src/desktop-daemon.ts` |
| Main process: window, IPC relay, daemon transport, saved preferences | `apps/desktop/src/main.ts` |
| Preload bridge | `apps/desktop/src/preload.ts` |
| HTML view of the view model, key bindings | `apps/desktop/src/view.ts` |
| Saved preferences loader | `apps/desktop/src/accessibility.ts` |
| Electron entry | `apps/desktop/src/electron-main.ts` |
| `rpg://app` file server, CSP, preload bundle | `apps/desktop/src/serve.ts` |
| HTML page and its script | `apps/desktop/src/index.html`, `apps/desktop/src/page.ts` |
| Launch smoke test | `apps/desktop/src/electron-smoke.test.ts` |

- `createDesktopClient({ transport, newActionId })` holds renderer state. It only sends `client-protocol` commands.
- `Transport` has `connect`, `send`, `onLine` and `onClose`. Lines are JSON, one per line.
- Status is `connected` only after a `Ready` line with `PROTOCOL_VERSION`. A wrong version shows offline.
- The conversation shows committed turns from `CampaignSnapshot.turns`. Queued actions show as pending until a snapshot holds their `actionId`.
- Offline actions stay in the outbox. After `Ready`, the outbox is re-sent with the same `actionId`, so the engine returns the stored turn.
- `Rejected` replies move the action to a visible rejected list. Nothing is dropped silently.
- View replies have the shape `{ "type": "View", "campaignId": "...", "view": {...} }`. A reply for a campaign that is not selected is dropped.
- View descriptors pass through `parseViewDescriptor`. Unknown component kinds are refused.
- `layoutFor(width)`: `compact` up to 720 px, `medium` up to 1200 px, `wide` above.
- `startMain({ BrowserWindow, ipcMain, fs, env, dataDir, preload, page })` takes the Electron APIs as parameters. Tests use fakes.
- `electron-main.ts` calls `startMain` with the real `electron` module and the data folder from `RPG_DATA_DIR` or the platform default.
- The window uses `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`.
- `will-navigate` is blocked and `setWindowOpenHandler` denies every new window.
- Main never pushes to a destroyed window. Closing the window stops the engine.
- The page loads from `rpg://app/apps/desktop/src/index.html`. `serveAsset` serves only `.html`, `.css` and `.ts` files under `apps/desktop/src/` and `packages/`, never tests.
- `.ts` files are served as JavaScript through `stripTypeScriptTypes` from `node:module`. No bundler.
- Every response carries `CONTENT_SECURITY_POLICY`: `default-src 'none'`, `script-src 'self'`, no inline scripts.
- `bundlePreload` turns `preload.ts` into one sandboxed script that calls `exposeBridge(require('electron'))`. Main writes it to a temp folder at start.
- `page.ts` renders `renderView` into `#app`, sets `--font-scale` through the CSSOM, and drives `createDesktopClient` with `window.rpg`.
- The renderer sends `SubscribeEvents` after `Ready` and on campaign select. `daemonTransport` relays the events as lines and keeps one subscription.
- The engine gets `daemonEnv(env)`, so `CLAUDE_*` and other consumer credentials never reach it.
- `daemonTransport(daemon)` turns daemon replies into renderer lines. A failed call closes the transport.
- Main accepts IPC only from its own window. It sends only string lines to the engine.
- The preload exposes `window.rpg` with `connect`, `send`, `onLine`, `onClose` and `savePreferences`. Listeners get the line only, never the IPC event.
- `renderView(model, locale)` returns HTML. All campaign, player, GM and error text is escaped.
- Regions carry translated `aria-label`s. Status uses `role="status"`, rejected actions use `role="alert"`.
- `bindKeys(target, preferences, run)` maps `keydown` through `actionForKey`. The keyboard preference can turn it off.
- Preferences live in `desktop-preferences.json` in the data folder. A missing or invalid file loads `DEFAULT_PREFERENCES`.
- Main passes preferences to the page in the `preferences` query value. `queryPreferences(location.search)` reads them.
- Main saves preferences only after `parsePreferences` accepts them.

## Run

```bash
RPG_CAMPAIGN=<name> pnpm --filter @rpg/desktop start
```

## Test

```bash
node --test apps/desktop/src/*.test.ts
```

The smoke test is skipped when the Electron binary is missing, or on Linux without `DISPLAY`.

## Unverified

- No OS-level GUI check. The smoke test reads the status text, not pixels.
- `stripTypeScriptTypes` is experimental in Node 24 and logs a warning.
- Packaging, signing and installers are owner actions (rpg-42a.4).
