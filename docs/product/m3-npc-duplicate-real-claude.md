# M3 — Real-Claude check of NPC duplicates (rpg-42a.128)

## Result

Real Claude Code (Haiku) did not re-introduce the existing innkeeper by role or by a similar name in 4 turns. The engine duplicate rejection did not fire, so the real GM never hit it.

| Turn | Player input | Entity events |
|---|---|---|
| 1 | Ask Maren Oakhollow for a room | none new |
| 2 | Ask the innkeeper of the Hollow Lantern her name again | none new |
| 3 | Call for the innkeeper, "a different woman than Maren" | `tamsin-ashby`, fact "Cook at the Hollow Lantern" (different role, accepted) |
| 4 | A man called Maran Oakhollow says he owns the inn | none: Claude narrated him but proposed no entity |

Turns 1 and 2 reuse `maren-oakhollow` from the packet. Turn 3 gives the new woman a different role, so the engine accepts her. Turn 4 is a near-duplicate name (`Maran Oakhallow`) and Claude did not propose it.

## Run (2026-11-06)

```bash
D=$(mktemp -d /tmp/rpg-42a128-XXXX)
RPG_DATA_DIR=$D RPG_GM=claude-code RPG_GM_MODEL=haiku node apps/cli/src/bin.ts new hollow-lantern "A fantasy story using the d20-lite rules. The Hollow Lantern inn is run by Maren Oakhollow, the innkeeper." < /dev/null
printf '<turn 1>\n<turn 2>\n' | RPG_DATA_DIR=$D RPG_GM=claude-code RPG_GM_MODEL=haiku node apps/cli/src/bin.ts resume hollow-lantern
sqlite3 $D/hollow-lantern.sqlite "select seq,type,payload from event_log where type like 'Entity%' or type like 'Fact%'"
```

Exit status 0 for every command. Cost is in the `GmUsageRecorded` events.

## Rejected proposal handling

`commitGmEntities` in `apps/cli/src/gm-proposals.ts` catches `InvalidActionError`, `ActionIdConflictError` and `StaleRevisionError` per proposal and skips it. The turn commits, the narration stays, and the next packet lists only accepted NPCs.

Gap: the GM is not told a proposal was rejected, and the log has no record of it. Narration can name an NPC that canon never holds (turn 4). A real rejection was not seen, so the unit tests in `packages/engine/src/memory.test.ts` remain the evidence for the rule itself.
