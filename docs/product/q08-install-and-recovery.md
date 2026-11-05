# Q08 — Install, RulePack authoring and recovery

Every command below exists in `package.json` or `apps/cli/src/main.ts`. Every variable is read by code under `apps/` or `packages/`. No commercial rules ship with the harness. Imports use files you own.

## Clean install

Prerequisites: Node 24 or newer, pnpm 11 or newer.

```bash
pnpm install
pnpm check:prereqs
pnpm rpg new Ember
pnpm rpg play Ember
pnpm rpg resume Ember
pnpm rpg help
```

Run the checks and the build:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Campaign files live in the data folder. Set it before the first run to choose the place.

```bash
RPG_DATA_DIR=/path/to/rpg-data pnpm rpg list
```

Without `RPG_DATA_DIR` the CLI uses the OS data folder plus `rpg` (`XDG_DATA_HOME` or `APPDATA` apply). See `apps/cli/src/setup-check.ts`.

## RulePack authoring

A RulePack manifest names the rules and the capabilities they cover. The contract lives in `packages/rules/src/rulepack.ts`. `validateManifest` accepts or rejects a manifest with a list of issues.

```json
{
  "contractVersion": 1,
  "id": "my-rules",
  "edition": "original",
  "revision": "1",
  "capabilities": { "checks": true, "combat": false },
  "sourceRefs": []
}
```

1. Copy the shape of `D20_LITE_MANIFEST` in `packages/rules/src/d20-lite.ts`. Set `edition` to the real edition of your source. The harness never substitutes another edition.
2. Write each mechanic as a rule DSL value (`packages/rules/src/dsl.ts`). The DSL is data. It has size and depth limits and runs no arbitrary code.
3. Import your own rule files with the CLI. The importer stages them as untrusted data, shows a preview and asks before it activates anything.

```bash
pnpm rpg import my-rules.md
```

Formats and provenance are listed in `docs/product/i01-importer-formats-and-provenance.md`. A campaign pins the RulePack revision it uses. The pin is part of every backup.

## Backup and recovery

The campaign database is one SQLite file per campaign in the data folder. `backup`, `export` and `restore` use the archive code in `apps/cli/src/campaign-archive.ts`.

```bash
pnpm rpg backup Ember
pnpm rpg export Ember ember.rpg-archive.json
pnpm rpg restore ember.rpg-archive.json
pnpm rpg resume Ember
```

- `backup` writes a dated `.rpg-archive.json` file into the `backups` folder inside the data folder.
- `export` writes the same archive format to a path you choose.
- `restore` checks the archive (format, checksum, schema, integrity, RulePack pins) before it writes the campaign.
- `archive` hides a campaign and keeps its saved state. `delete` asks you to confirm the campaign name.

```bash
pnpm rpg archive Ember
pnpm rpg list
```

Updates take a campaign backup first. See `packages/updater/src/schedule.ts` and `apps/cli/src/update.ts`.

```bash
pnpm rpg update --check
```

`RPG_RELEASES_URL` overrides the release feed.

```bash
RPG_RELEASES_URL=https://example.invalid/releases pnpm rpg update --check
```

## Audio and desktop

Voice is optional. The CLI works with it off.

```bash
pnpm rpg tui --voice
```

- Voice settings and consent live in `packages/voice/src/voice-settings.ts`. A sample is `examples/voice-preferences.json`.
- A provider key comes from the OS credential store or from `RPG_VOICE_<PROVIDER>_API_KEY`. `<PROVIDER>` is the provider id in upper case, with other characters replaced by `_`.

```bash
RPG_VOICE_<PROVIDER>_API_KEY=
```

The desktop client is an Electron app. It talks to the same engine as the CLI.

```bash
RPG_CAMPAIGN=Ember pnpm --filter @rpg/desktop start
```

`RPG_DATA_DIR` applies to the desktop too. Desktop details are in `docs/product/ui07-desktop-packaging-spike.md` and `docs/product/ui08-desktop-renderer.md`.

## Subscription-based Claude Code

Use this route to let your own local Claude Code session act as Game Master.

1. Claude Code runs on your own machine and signs in the way its documentation describes.
2. It reaches the engine through the `rpg` MCP server (`apps/mcp-server/src/main.ts`) and the `rpg-gm` skill (`.claude/skills/rpg-gm/SKILL.md`).
3. The harness never reads or stores that login. It only sees tool calls through `--mcp-config`.

```bash
RPG_DATABASE_PATH=/path/to/rpg-data/Ember.sqlite node apps/mcp-server/src/main.ts
```

`packages/mcp/mcp.json` shows the server entry for `--mcp-config`. A recorded run is in `docs/product/m1-real-claude-run.md`.

## API-key desktop providers

The desktop engine is a separate program that the harness distributes. It does not use a Claude login. Set `ANTHROPIC_API_KEY` to a key from the provider console.

```bash
ANTHROPIC_API_KEY= RPG_CAMPAIGN=Ember pnpm --filter @rpg/desktop start
```

- Without `ANTHROPIC_API_KEY` the desktop plays with the fake GM.
- The desktop app removes Claude Code session variables before it starts the engine. If you start the engine directly with them set, it refuses and exits with code 3. See `apps/cli/src/desktop-daemon.ts`.
- Voice providers use their own keys. See Audio and desktop.
