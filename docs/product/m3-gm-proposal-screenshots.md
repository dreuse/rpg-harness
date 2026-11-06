# M3 — Desktop screenshots of a turn with a GM claim proposal (rpg-42a.131)

A local server fakes the Anthropic API. Its reply holds an `entity` proposal for `aldric` and a `claim` proposal with id `aldric-jurou-devolver-chave`. The engine commits the claim as the hidden turn `GM proposal claim aldric-jurou-devolver-chave` and a `ClaimRecorded` event. The desktop shows no such turn and no internal id.

## Run

```bash
L=pt-BR   # or en
MOCK_PORT=<port> MOCK_LANG=$L node scripts/mock-claim-gm.mjs &   # replies to /v1/messages with a narrate tool call
D=$(mktemp -d)
RPG_DATA_DIR=$D RPG_LANG=$L RPG_GM=api ANTHROPIC_API_KEY=x RPG_GM_KEYCHAIN=off RPG_GM_API_URL=http://127.0.0.1:<port> \
  node apps/cli/src/bin.ts new hollow-lantern "A fantasy story with Aldric, who keeps a key." --client desktop < /dev/null
printf 'I ask Aldric to give back the key.\n' | RPG_DATA_DIR=$D RPG_LANG=$L RPG_GM=api ANTHROPIC_API_KEY=x RPG_GM_KEYCHAIN=off \
  RPG_GM_API_URL=http://127.0.0.1:<port> node apps/cli/src/bin.ts resume hollow-lantern
sqlite3 $D/hollow-lantern.sqlite "select payload from event_log where type = 'ClaimRecorded'"
RPG_DESKTOP_SMOKE=1 RPG_DESKTOP_JOURNEY=gmProposal RPG_DESKTOP_CAPTURE_DIR=/tmp/rpg-131-shots-$L RPG_DATA_DIR=$D RPG_LANG=$L pnpm --filter @rpg/desktop start
```

## Screenshots (not committed)

- `/tmp/rpg-131-shots-en/gm-proposal-light.png` (also `-dark`, `-high-contrast-light`, `-high-contrast-dark`)
- `/tmp/rpg-131-shots-pt-BR/gm-proposal-light.png` (same four themes)

Both show only the narration, the player line and the narration again. They show no "GM proposal" text and no id.
