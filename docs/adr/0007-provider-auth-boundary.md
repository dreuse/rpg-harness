# ADR 0007 — Provider authentication boundary

**Status:** Accepted, amended by ADR 0020 (local Claude Code CLI route). **Decision:** Two separate auth routes. They never share credentials.

| Route | Who runs it | Auth | Allowed |
|---|---|---|---|
| Terminal harness | The player, inside their own Claude Code | Their own Claude Code login | Project skill + local MCP server (`rpg` tools) |
| Distributed client (CLI `GameMaster` adapter, TUI, desktop) | RPG Harness process | Provider API key the player configures (e.g. `ANTHROPIC_API_KEY`) or another supported provider route | Direct API calls through the `GameMaster` port |

**Rules:**

- RPG Harness never reads, copies or proxies Claude Code OAuth tokens or session files.
- ~~The distributed client does not spawn `claude` to borrow a consumer login.~~ Superseded by ADR 0020 for the local Claude Code CLI route.
- The MCP server needs no model credentials. It exposes typed campaign tools only.
- No credentials configured → fake GM or text-only play, with a clear message.

**Context:** P03 spike (`docs/product/p03-mcp-spike.md`). Provider terms: https://code.claude.com/docs/en/legal-and-compliance. Re-check before desktop distribution (UI epic).

**Consequences:** Two `GameMaster` adapters: MCP (terminal harness) and API. The fake GM covers tests for both.
