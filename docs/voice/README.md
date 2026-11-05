# Voice

## Install

```bash
pnpm install
pnpm check:prereqs                                  # checks Node and pnpm
pnpm --filter @rpg/desktop start                    # install voice models from the desktop voice setup
```

## Run

```bash
pnpm rpg tui --voice                                # spoken output in the terminal
RPG_VOICE=fake pnpm --filter @rpg/desktop start     # fake provider, no model download
```

## Test

```bash
node --test packages/voice/src/voice-reliability.test.ts packages/voice/src/audio-budget.test.ts packages/voice/src/audio-cache-store.test.ts
RPG_KOKORO_MODEL_DIR=<dir> node --test packages/voice/src/kokoro-js-engine.integration.test.ts
brew install uv                                     # mlx integration test only
RPG_MLX_AUDIO_DIR=<dir> node --test packages/voice/src/mlx-audio-engine.integration.test.ts
node scripts/voice-spike/run.ts --skip-install      # latency benchmark, see spike-results.md
```

## Providers

| Provider id | Engine | Languages | Platform | Model download |
| --- | --- | --- | --- | --- |
| `kokoro` | kokoro-js (ONNX) | `en` | Any | Desktop voice setup |
| `kokoro-mlx` | mlx-audio service | `pt-BR` | macOS arm64 | Integration test only; the desktop registers it only under `RPG_VOICE=fake` |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No audio, text only | Voice is off, no consent, or no healthy provider; the subtitle shows the reason |
| Model not found | `RPG_KOKORO_MODEL_DIR=<dir>` points to a directory with the model installed |
| Preview works, play does not | Run the integration tests above against the same directory |
| Provider keeps failing | Circuit breaker opens after 3 failures for 30 s; the next provider in the voice profile speaks |
| Slow first audio | `node scripts/voice-spike/run.ts --skip-install` |

## Cache

```
<data dir>/audio-cache     # preview audio, capped at 8 MiB, survives restart
```

## Environment

Optional:

```
RPG_VOICE=                  # "fake" selects the fake provider
RPG_KOKORO_MODEL_DIR=       # default <data dir>/voice-models
```
