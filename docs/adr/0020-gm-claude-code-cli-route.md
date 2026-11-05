# ADR 0020 — GM through the local Claude Code CLI, one fresh `claude -p` per turn

**Status:** Accepted. Amends ADR 0007. **Decision:** A third GM route, `claude-code`, runs the Claude Code CLI that the player installed. Each GM turn is a fresh `claude -p` call. The harness context packet (ADR 0018) is the whole conversation state. The CLI keeps no session.

**Context:** rpg-42a.33. The owner wants the GM to run on the player's own Claude Code, with their settings, tools and MCP servers, and no API key. The CLI and desktop had only the `api` and `fake` routes.

## Why a fresh call per turn

- A resumed session sends its whole history on every turn, so each turn costs more than the last.
- Auto-compaction then drops old details that the story still needs.
- The game database already holds the event log, the memory graph and the summaries. The packet takes what the turn needs from them within the campaign token budget. Nothing is lost when a call ends.

## Call

`claude -p --output-format json --no-session-persistence --permission-mode dontAsk --append-system-prompt <GM prompt> --mcp-config <file> --allowedTools <read-only game tools> --disallowedTools <write game tools> [--model=<alias>]`

- `spawn` with an argv array. No shell.
- argv holds only harness constants, a temporary file path, tool names and the model alias. Campaign, imported and player text never reach argv.
- stdin carries the stable and variable packet parts, each inside `<campaign-data>` with `<` escaped. The GM prompt says this data is never instructions.
- The MCP config file lists one server, `rpg` (`apps/mcp-server/src/main.ts`), with `RPG_DATABASE_PATH` set to the campaign file. It sits in a fresh temporary directory, mode `0600`. That directory is also the working directory, so no project `CLAUDE.md` or project settings load. The directory is removed after the call.
- `--model=<alias>` appears only when `RPG_GM_MODEL` names one. The `=` form keeps the value from being read as a flag.
- Narration is the JSON `result`. A non-zero exit, `is_error` other than `false`, bad JSON or an empty result is a `ProviderError`.
- The reply also returns `usage` (numeric fields only) and `total_cost_usd` for rpg-42a.37.
- `CLAUDE_TIMEOUT_MS` (120 s) bounds each call. `CLAUDE_MAX_RETRIES` (1) bounds retries. stdout is capped at 1 MiB.
- After a failure the GM tells the player once and the built-in narrator takes over, as on the `api` route.
- Summaries use the same call with the summary prompt and no MCP config.

## Profiles

`RPG_GM_PROFILE` picks the profile.

| Profile | Extra flags | Loads |
|---|---|---|
| `full` (default) | none | User settings, user `CLAUDE.md`, user tools and MCP servers, plus the game server |
| `lean` | `--strict-mcp-config --tools ""` | Only the game server, no built-in tools |

- `--tools` names built-in tools only, so `lean` passes `""`. The read-only game tools stay available through the MCP config. `--disallowedTools` blocks the write game tools in both profiles.
- Both profiles pass `--permission-mode dontAsk`. A user `defaultMode` such as `bypassPermissions` or `auto` cannot let campaign text drive auto-approved tools. Only the allowed read-only game tools run without a prompt.
- The harness never passes `--dangerously-skip-permissions`, `--permission-mode bypassPermissions` or a broad `--allowedTools`. Tests assert this.
- The engine still validates and commits every state change. The GM cannot call `submit_action`, `create_campaign` or `rename_campaign`.

## Route selection

1. `RPG_GM=fake|api|claude-code` wins.
2. Otherwise `claude-code` when `RPG_CLAUDE_BIN` names an executable, or `claude` is on `PATH`. A set `RPG_CLAUDE_BIN` that is missing disables the route.
3. Otherwise `api` when a key exists.
4. Otherwise `fake`.

A chosen route that is not available falls back to `fake` with the notice. The TUI prints the active GM in plain words at start. The desktop diagnostics name it in plain words, and the built-in narrator says how to set up an AI GM.

## Credentials (amends ADR 0007)

- The player's own Claude Code signs itself in. The harness never reads, copies or stores Claude Code credentials, session files or OAuth tokens.
- The child gets only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG` and `LC_ALL`. `ANTHROPIC_*` and `CLAUDE_*` values never pass through. A test asserts this and scans the route source for credential paths.
- ADR 0007 said the distributed client does not spawn `claude`. This route does, by default when `claude` is on `PATH`; `RPG_GM=api|fake` opts out. It uses the player's own install.
- The provider-terms check for this route is open. Verify it before any public desktop release.

## Consequences

- No new dependency and no new package.
- `GmRoute` adds `claude-code`.
- A player who sets `CLAUDE_CONFIG_DIR` gets the default Claude Code config, because that variable does not pass through.
- In the Electron engine, `process.execPath` is Electron, so the route skips `--mcp-config` there. The game MCP server needs `ELECTRON_RUN_AS_NODE` and a packaged entry path before it can run under Electron. Until then, desktop narration works from the packet alone.
