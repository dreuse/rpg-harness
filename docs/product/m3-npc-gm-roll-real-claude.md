# M3 — Real-Claude check of an NPC gm-roll (rpg-42a.100)

## Result

Real Claude Code (Haiku) proposed a `gm-roll` for an NPC attack. The engine rolled it and sent the result back. Claude narrated the turn. The desktop roll tray showed the roll as "rolled by Old Tam".

No skill or MCP change was needed. The CLI GM (`RPG_GM=claude-code`) takes `gm-roll` as a structured proposal (`apps/cli/src/gm-proposals.ts`, prompt in `apps/cli/src/gm-api.ts`). The `/rpg-gm` skill and the MCP `submit_action` tool cannot express it.

Haiku is not reliable here. In the first campaign it proposed a `gm-roll` in 1 of 5 turns. Four turns used the player check path instead. The 1 that worked had the wording "Tam steps out from the bar and brings the cudgel down on me." with no attack or dice words.

## Run (2026-11-06)

```bash
D=$(mktemp -d /tmp/rpg-42a100-XXXX)
RPG_DATA_DIR=$D RPG_GM=claude-code RPG_GM_MODEL=haiku \
  node apps/cli/src/bin.ts new hollow-lantern "A fantasy story using the d20-lite rules with dice animation. Old Tam, a surly barkeep, is hostile and attacks intruders with his cudgel." --client desktop < /dev/null
printf 'Tam steps out from the bar and brings the cudgel down on me.\n' | \
  RPG_DATA_DIR=$D RPG_GM=claude-code RPG_GM_MODEL=haiku node apps/cli/src/bin.ts resume hollow-lantern
sqlite3 $D/hollow-lantern.sqlite "select payload from event_log where type = 'GmRolled'"
```

| Field | Value |
|---|---|
| Exit status | 0 (both commands) |
| Attempts | 5 turns in one campaign; the 5th produced the `gm-roll` |
| Cost | $0.027 for the first campaign; $0.0075 for the desktop campaign |
| Claude calls on the winning turn | 2 (proposal, then narration with `results`) |
| MCP tool calls | none; the CLI passes the context in the prompt |

Proposal: `{"kind":"gm-roll","id":"tam-cudgel-attack","roller":"old-tam","reason":"Tam swings his cudgel at the player","visibility":"shown","ruleId":"attack.melee"}`.

Recorded event:

```text
GmRolled {"roller":"old-tam","rollerName":"Old Tam","reason":"Tam swings his cudgel at the player","visibility":"shown","expression":"1d20", ... "rollId":"...:proposal:gm-roll:tam-cudgel-attack:gm-roll", ... "total":20}
```

Narration after the roll: "Tam steps out from behind the bar with the cudgel already rising, and he brings it down with the full weight of a man who has done this a hundred times ... Do you duck under the swing toward those casks, or wait with your hands open ...". The narration does not state a hit or a miss.

## Desktop roll tray

The journey `npcRoll` in `apps/desktop/src/capture.ts` opens the first campaign, sends the action above and waits for the roll tray and the GM reply. It needs a real GM, so it is not in the smoke test.

```bash
RPG_DESKTOP_SMOKE=1 RPG_DESKTOP_JOURNEY=npcRoll RPG_DESKTOP_CAPTURE_DIR=/tmp/rpg-42a100-shots2 \
  RPG_DATA_DIR=$D RPG_GM=claude-code RPG_GM_MODEL=haiku pnpm --filter @rpg/desktop start
```

Screenshot: `/tmp/rpg-42a100-shots2/npc-roll-light.png` (also `-dark`, `-high-contrast-light`, `-high-contrast-dark`). The tray shows "d20 12, modifier +0, total 12, rolled by Old Tam". The screenshot is not committed: the roll and the narration change on every real run, so it cannot be a visual baseline.

`JOURNEY_TIMEOUT_MS` went from 15000 to 60000 because a real GM turn with a `gm-roll` takes two Claude calls and passed the old limit.

## Engine fix

`gmRollIdsAfter` in `packages/engine/src/gameplay.ts` took every GM roll after the turn. It is now `gmRollIdsOf` and keeps only rolls whose action id starts with `<turn action id>:proposal:`. A roll proposed under another action no longer resolves an outcome claim of the same id. Test: `rpg-42a.100` in `packages/engine/src/gameplay.test.ts`.
