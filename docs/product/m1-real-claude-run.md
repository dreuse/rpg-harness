# M1 — Real-Claude play session

## Result

Claude Haiku narrated the opening scene and submitted one action through the `submit_action` MCP tool. The CLI then resumed the same campaign and showed the committed action. The seeded GM-only fact did not appear in the narration or any tool result.

| Part | File |
|---|---|
| Skill | `.claude/skills/rpg-gm/SKILL.md` |
| MCP tool `submit_action` | `packages/mcp/src/tools.ts` |
| Engine entry point `submitAction` | `packages/engine/src/engine.ts` |
| MCP server | `apps/mcp-server/src/main.ts` |

## Setup (2026-11-04)

```bash
D=$(mktemp -d /tmp/rpg-m1-XXXX)
RPG_DATA_DIR=$D node apps/cli/src/bin.ts new m1   # exit 0, opens The Crossroads Inn
```

GM-only fact: no domain type models GM-only facts yet. The run seeds one as a raw `event_log` row with `type = GmNoteRecorded` and payload `{"gmOnly":"The stranger is Duke Varn in disguise."}`. No MCP tool returns event payloads, so the model never received the secret. The check shows the tools have no path that leaks it. It does not show that the model withheld it.

`$D/mcp.json` uses the shape of `packages/mcp/mcp.json`, with an absolute server path and `RPG_DATABASE_PATH=$D/m1.sqlite`.

## Run

```bash
claude -p "/rpg-gm <campaignId> <actorId> I ask the stranger by the fire for news of the road." \
  --model haiku --mcp-config $D/mcp.json --strict-mcp-config \
  --allowedTools "mcp__rpg__get_campaign,mcp__rpg__get_scene,mcp__rpg__submit_action,Skill" \
  --output-format stream-json --verbose --max-budget-usd 0.5 < /dev/null
```

| Field | Value |
|---|---|
| Exit status | 0 |
| `is_error` | false |
| Turns | 5 |
| Cost | $0.0061 |
| Tool calls | `get_campaign`, `get_scene`, `submit_action` (`expectedRevision: 1`, before `actionId` was an input) |

Narration: "The campaign **m1** is at scene **The Crossroads Inn**, where **The Wanderer** sits near the fire. A stranger is there too." A `proposal` block and the not-committed line followed. Final line: "The engine accepted the action. The campaign revision is now 2."

`--output-format json` keeps only the final message. Use `stream-json --verbose` to record the narration.

## Resume

```bash
RPG_DATA_DIR=$D node apps/cli/src/bin.ts resume m1 < /dev/null   # exit 0
```

```text
The Crossroads Inn
The Wanderer: I ask the stranger by the fire for news of the road.
The world shifts in answer.
```

## GM-only check

```bash
grep -c Varn $D/run.jsonl   # 0: absent from narration and tool results
```
