# RPG Harness

## Run

```bash
open rpg-harness-darwin-arm64.dmg  # macOS desktop app from the latest release; drag RPG Harness to Applications
curl -fsSL https://raw.githubusercontent.com/dreuse/rpg-harness/main/install.sh | sh  # install or update
curl -fsSL https://raw.githubusercontent.com/dreuse/rpg-harness/main/install.sh | sh -s -- --uninstall
rpg tui [campaign]
```

From source:

```bash
pnpm install
pnpm check:prereqs
pnpm rpg
pnpm rpg new <campaign>
pnpm rpg play <campaign>
pnpm rpg tui [campaign] [--voice]  # terminal UI
pnpm rpg claude [campaign]  # Claude Code as game master, game tools preloaded
pnpm rpg help
```

MCP server for Claude Code, from source:

```bash
claude mcp add rpg -e RPG_DATABASE_PATH="$HOME/Library/Application Support/rpg/<campaign>.sqlite" -- node "$PWD/apps/mcp-server/src/main.ts"  # <campaign> URL-encoded, e.g. My%20adventure
```

MCP server for Claude Code, from the installed macOS app:

```bash
claude mcp add rpg -e ELECTRON_RUN_AS_NODE=1 -e RPG_DATABASE_PATH="$HOME/Library/Application Support/rpg/<campaign>.sqlite" -- "/Applications/RPG Harness.app/Contents/MacOS/RPG Harness" "/Applications/RPG Harness.app/Contents/Resources/app/apps/mcp-server/src/main.ts"
```

## Test

```bash
pnpm test
pnpm test:integration
```

## Build

```bash
pnpm install --prod --config.node-linker=hoisted --ignore-scripts  # flat install for packaging
pnpm --config.verify-deps-before-run=false package:desktop --platform=darwin --arch=arm64  # writes out/RPG Harness-<platform>-<arch>
ELECTRON_RUN_AS_NODE=1 "out/RPG Harness-darwin-arm64/RPG Harness.app/Contents/MacOS/RPG Harness" "out/RPG Harness-darwin-arm64/RPG Harness.app/Contents/Resources/app/apps/cli/src/bin.ts"  # packaged CLI
git tag v0.1.0 && git push origin v0.1.0  # CI publishes the binaries to a GitHub release
```

## Environment

Optional:

```bash
RPG_RELEASE_URL=  # install.sh only; default: https://github.com/dreuse/rpg-harness/releases/latest/download
RPG_DATA_DIR=  # default: OS data folder + /rpg, created on first run
XDG_DATA_HOME=
APPDATA=
RPG_LANG=  # default: LC_ALL, LC_MESSAGES, LANG, then the OS locale; en or pt-BR
```

MCP server, required:

```bash
RPG_DATABASE_PATH=  # campaign SQLite file: <RPG_DATA_DIR>/<URL-encoded campaign>.sqlite
```
