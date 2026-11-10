# RPG Harness

## Run

```bash
pnpm install
pnpm check:prereqs
pnpm rpg
pnpm rpg new <campaign>
pnpm rpg play <campaign>
pnpm rpg help
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
RPG_DATA_DIR=  # default: OS data folder + /rpg, created on first run
XDG_DATA_HOME=
APPDATA=
RPG_LANG=  # default: LC_ALL, LC_MESSAGES, LANG, then the OS locale; en or pt-BR
```
