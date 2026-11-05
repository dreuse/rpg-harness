# M3 — Real-Claude check of NPC voice traits (pt-BR)

## Result

Real Claude Code (Haiku) narrated a pt-BR scene. It recorded `voiceTraits` for both speaking NPCs. The picker chose a matching voice for each.

## Run (2026-11-05)

```bash
D=$(mktemp -d /tmp/rpg-cm63-48-XXXX)
RPG_DATA_DIR=$D RPG_GM=claude-code RPG_GM_MODEL=haiku LANG=pt_BR.UTF-8 LC_ALL=pt_BR.UTF-8 \
  node apps/cli/src/bin.ts new taverna "Uma taverna medieval; a estalajadeira é uma mulher calorosa e um velho viajante rabugento conversa com o jogador. Narre em português do Brasil." < /dev/null
sqlite3 $D/taverna.sqlite "select payload from event_log where type = 'EntityIntroduced'"
```

Exit status 0. Narration excerpt: "Dona Helena, a estalajadeira de braços fortes e sorriso largo ... Barnabé ergue os olhos cansados e tamborila sobre um mapa rasgado".

## Recorded entities

```text
dona-helena    npc  {"voiceTraits":{"gender":"female","age":"adult","manner":"warm"}}
mestre-barnabe npc  {"voiceTraits":{"gender":"male","age":"old","manner":"gruff"}}
```

## Picker output

`pickVoice` over the installed pt-BR Kokoro voices (`pf_dora`, `pm_alex`, `pm_santa`), with the recorded traits, campaign `taverna`:

| NPC | Voice | Catalog tags |
|---|---|---|
| dona-helena | `pf_dora` | female, young/adult, warm |
| mestre-barnabe | `pm_santa` | male, old, warm/rough |

Not run: audio playback. No Kokoro runtime was started; the picker ran on the catalog.
