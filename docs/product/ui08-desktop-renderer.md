# UI08 — Desktop app foundation and renderer

## What exists

| Part | File |
|---|---|
| Renderer state, campaign selection, responsive layout, view model, safe retry | `apps/desktop/src/renderer.ts` |
| Tests (2) | `apps/desktop/src/renderer.test.ts` |
| Engine child + supervisor (UI07) | `apps/cli/src/desktop-daemon.ts` |

- `createDesktopClient({ transport, newActionId })` holds renderer state. It only sends `client-protocol` commands.
- `Transport` has `connect`, `send`, `onLine` and `onClose`. Lines are JSON, one per line.
- Status is `connected` only after a `Ready` line with `PROTOCOL_VERSION`. A wrong version shows offline.
- The conversation shows committed turns from `CampaignSnapshot.turns`. Queued actions show as pending until a snapshot holds their `actionId`.
- Offline actions stay in the outbox. After `Ready`, the outbox is re-sent with the same `actionId`, so the engine returns the stored turn.
- `Rejected` replies move the action to a visible rejected list. Nothing is dropped silently.
- View replies have the shape `{ "type": "View", "campaignId": "...", "view": {...} }`. A reply for a campaign that is not selected is dropped.
- View descriptors pass through `parseViewDescriptor`. Unknown component kinds are refused.
- `layoutFor(width)`: `compact` up to 720 px, `medium` up to 1200 px, `wide` above.

## Test

```bash
node --test apps/desktop/src/renderer.test.ts
```

## Unverified

- Electron main process and preload wiring of `Transport` to `startDaemon`.
- Engine-side stdio serving of `ClientSession` commands: the daemon answers only `Ping` and `Shutdown`.
- HTML/DOM rendering of the view model.
- Packaging, signing and installers.
