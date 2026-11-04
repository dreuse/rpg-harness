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
- The window uses `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`.
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

## Test

```bash
node --test apps/desktop/src/*.test.ts
```

## Unverified

- Electron is not installed. `main.ts`, `preload.ts` and `view.ts` run only against fakes under `node --test`.
- No Electron entry file calls `startMain` or `exposeBridge` with the real `electron` module yet.
- A sandboxed preload needs one bundled script. The `.ts` imports in `preload.ts` are not bundled yet.
- No HTML page loads `view.ts`, sets `innerHTML` from `renderView` or calls `createDesktopClient` with `window.rpg`.
- `SubscribeEvents` is not relayed. The renderer refreshes only on its own commands.
- Packaging, signing and installers are owner actions.
