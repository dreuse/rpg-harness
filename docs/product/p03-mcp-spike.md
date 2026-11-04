# P03 — Claude Code skill, MCP and launch transport (spike)

## Result

A project skill called a typed, read-only MCP tool over stdio, and Claude narrated from it.

| Part | File |
|---|---|
| MCP server, tool `get_campaign_snapshot` (zod input/output schema, `readOnlyHint`) | `spikes/p03-mcp/server.js` |
| Protocol tests (3) | `spikes/p03-mcp/server.test.js` |
| Project skill | `.claude/skills/rpg-scene/SKILL.md` |
| MCP config | `spikes/p03-mcp/mcp.json` |

## Evidence (2026-11-04)

```bash
cd spikes/p03-mcp && pnpm test        # tests 3, pass 3, fail 0
claude -p "/rpg-scene demo" --model haiku \
  --mcp-config spikes/p03-mcp/mcp.json --strict-mcp-config \
  --allowedTools "mcp__rpg__get_campaign_snapshot,Skill" --output-format json
```

Live run: exit 0, `is_error: false`, 3 turns, $0.0074. Output used only player-visible fields, omitted the `gmSecret` field and ended `revision: 0`.

## Findings

- Transport: stdio subprocess works with no extra service. Use it for V04.
- Visibility filtering happens in the server before the tool returns. The test asserts `gmSecret` never appears in the payload.
- `--strict-mcp-config` plus `--allowedTools` scopes the model to one tool. Use the same scoping for unattended runs.
- Auth: see ADR 0007. The spike used the developer's own Claude Code login (terminal route). No credentials reach the MCP server.

## Open questions

1. V04 should move the server to TypeScript inside the V01 workspace and read SQLite. Delete this spike then.
