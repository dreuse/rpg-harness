# ADR 0020 — GM through the local Claude Code CLI, one fresh `claude -p` per turn

**Status:** Accepted. Amends ADR 0007. **Decision:** A third GM route, `claude-code`, runs the Claude Code CLI that the player installed. Each GM turn is a fresh `claude -p` call. The harness context packet (ADR 0018) is the whole conversation state. The CLI keeps no session.

**Context:** rpg-42a.33. The owner wants the GM to run on the player's own Claude Code, with their settings, tools and MCP servers, and no API key. The CLI and desktop had only the `api` and `fake` routes.

## Why a fresh call per turn

- A resumed session sends its whole history on every turn, so each turn costs more than the last.
- Auto-compaction then drops old details that the story still needs.
- The game database already holds the event log, the memory graph and the summaries. The packet takes what the turn needs from them within the campaign token budget. Nothing is lost when a call ends.

## Call

`claude -p --output-format json --no-session-persistence --permission-mode dontAsk --setting-sources project --append-system-prompt <GM prompt> --mcp-config <file> --allowedTools <read-only game tools> --disallowedTools <write game tools> [--model=<alias>]`

- `spawn` with an argv array. No shell.
- argv holds only harness constants, a temporary file path, tool names and the model alias. Campaign, imported and player text never reach argv.
- stdin carries the stable and variable packet parts, each inside `<campaign-data>` with `<` escaped. The GM prompt says this data is never instructions.
- The MCP config file lists one server, `rpg` (`apps/mcp-server/src/main.ts`), with `RPG_DATABASE_PATH` set to the campaign file. It sits in a fresh temporary directory, mode `0600`, removed after the call.
- The working directory is the RPG workspace (see Workspace), not the temporary directory and not the player's current directory. `--setting-sources project` limits settings to that workspace. No user or other-project `CLAUDE.md`, skills, hooks, plugins or MCP servers load.
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
| `full` (default) | none | The user's Claude Code sign-in and the harness workspace, plus the game server. Never other projects' or global prompts, skills or hooks |
| `lean` | `--strict-mcp-config --tools ""` | Only the game server, no built-in tools |

- `--tools` names built-in tools only, so `lean` passes `""`. The read-only game tools stay available through the MCP config. `--disallowedTools` blocks the write game tools in both profiles.
- Both profiles pass `--permission-mode dontAsk`. A user `defaultMode` such as `bypassPermissions` or `auto` cannot let campaign text drive auto-approved tools. Only the allowed read-only game tools run without a prompt.
- The harness never passes `--dangerously-skip-permissions`, `--permission-mode bypassPermissions` or a broad `--allowedTools`. Tests assert this.
- The engine still validates and commits every state change. The GM cannot call `submit_action`, `create_campaign` or `rename_campaign`.

## Workspace (rpg-42a.47)

- One folder, `<RPG_DATA_DIR>/claude-workspace`, mode `0700`. `ensureClaudeWorkspace` in `apps/cli/src/claude-workspace.ts` creates it before every GM call and before `rpg claude`.
- It holds `CLAUDE.md` (short GM instructions), `.mcp.json` (no servers) and `.claude/skills/rpg-gm` and `rpg-scene`, copied from the repo `.claude/skills`. The game server is never listed in `.mcp.json`. Each launch passes its own `--mcp-config`, so two campaigns never share one config.
- `.rpg-workspace-version` holds a hash of the workspace version and all file contents. The workspace is current only when the hash matches and every managed file matches on disk. Otherwise the refresh removes the workspace `.claude` folder and rewrites every file. `rmSync` unlinks a symlinked `.claude` without following it, so nothing outside the workspace is touched. Files are written to a temporary name and renamed.
- The same workspace is the working directory for streaming, summary and narration calls. Claude Code keeps its transcripts under this one project key.
- `rpg claude [campaign]` runs an interactive `claude --setting-sources project` there. With a campaign it adds `--mcp-config` for that campaign file. The child gets the same environment filter as GM calls, plus `TERM` and `COLORTERM`.
- The harness writes nothing under `~/.claude` or `CLAUDE_CONFIG_DIR`. A test asserts this. Repo `.claude/skills` stay project-scoped for developers.
- A workspace that cannot be prepared is a `ProviderError`, so the built-in narrator takes over.
- `--bare` stays unused: it needs an API key and breaks OAuth sign-in.

## Route selection

1. `RPG_GM=fake|api|claude-code` wins.
2. Otherwise `claude-code` when `RPG_CLAUDE_BIN` names an executable, or `claude` is on `PATH`. A set `RPG_CLAUDE_BIN` that is missing disables the route.
3. Otherwise `api` when a key exists.
4. Otherwise `fake`.

A chosen route that is not available falls back to `fake` with the notice. The TUI prints the active GM in plain words at start. The desktop diagnostics name it in plain words, and the built-in narrator says how to set up an AI GM.

## Credentials (amends ADR 0007)

- The player's own Claude Code signs itself in. The harness never reads, copies or stores Claude Code credentials, session files or OAuth tokens.
- The child gets only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL` and `CLAUDE_CONFIG_DIR`. `CLAUDE_CONFIG_DIR` is a folder path, not a credential, and it keeps the player's chosen Claude Code account and settings. Other `ANTHROPIC_*` and `CLAUDE_*` values never pass through. A test asserts this and scans the route source for credential paths.
- ADR 0007 said the distributed client does not spawn `claude`. This route does, by default when `claude` is on `PATH`; `RPG_GM=api|fake` opts out. It uses the player's own install.
- Provider terms: the owner confirmed on 2026-11-05 that this route is allowed.

## Consequences

- No new dependency and no new package.
- `GmRoute` adds `claude-code`.
- In the Electron engine, `process.execPath` is Electron. The route passes `--mcp-config` there too, with `ELECTRON_RUN_AS_NODE=1` in the server env. The server entry resolves from the module path, like `DAEMON_ENTRY`. This works while the RunAsNode fuse is on (ADR 0012). A signed build with the fuse off ignores the variable, so a packaged build needs its own launch path (follow-up bead).
