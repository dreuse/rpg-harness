# Local TTS benchmark results (rpg-cm63.1)

Measured on 2026-11-05. Apple M3 Max, 64 GB, macOS 26.6.2, Node v24.22.1, Python 3.12.13 (from `uv`).

## Run

```bash
node scripts/voice-spike/run.ts                                  # install all candidates, then measure
node scripts/voice-spike/run.ts --skip-install                   # measure with the installed candidates
node scripts/voice-spike/run.ts --candidates kokoro-js-fp32,mlx-audio
```

- The script installs each candidate into `.voice-spike/<candidate>/`. Git ignores this folder.
- Models download into `.voice-spike/<candidate>/models` or `.voice-spike/<candidate>/hf` on the first run only.
- Audio files go to `.voice-spike/<candidate>/out`. Results go to `.voice-spike/results.md`.
- Unit tests (`node --test scripts/voice-spike/*.test.ts`) never install or download anything.

## Method

- Passages: `scripts/voice-spike/passages.ts`. Per language: one narration, two short NPC lines, one emotional line.
- Each candidate runs in its own child process under `/usr/bin/time -l`.
- Load: model construction from the local cache. The numbers below come from a run with all models cached.
- Warm-up: one English call (`Hello.`) after load, timed on its own.
- First audio: time from the call to the first sentence chunk. Passages split at `.`, `!` and `?`.
- RTF: total synthesis time divided by audio duration. Below 1 is faster than real time.
- Unload: release the model, run garbage collection and clear the GPU cache.
- Peak RSS and peak footprint: from `time -l`. Footprint includes GPU (Metal) memory on Apple Silicon.
- Model size: bytes in the model cache folder. Install size: `node_modules` or the Python venv.
- Voices: Kokoro `af_heart` (en) and `pf_dora` (pt-BR). Chatterbox: built-in default voice, no reference clip.
- Chatterbox style: `exaggeration=0.5, cfg_weight=0.5`; emotional line `exaggeration=0.8, cfg_weight=0.3`.

## Summary

| Candidate | Versions | Device | Load ms | Warm-up ms | Unload ms | Median first audio ms | Median RTF | Peak RSS MiB | Peak footprint MiB | Model MiB | Install MiB | Passages ok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| kokoro-js-q8 | kokoro-js 1.2.1, @huggingface/transformers 3.8.1, onnxruntime-node 1.21.0 | cpu | 284 | 560 | 13 | 802 | 0.398 | 540 | 474 | 88 | 402 | 4/8 |
| kokoro-js-fp32 | kokoro-js 1.2.1, @huggingface/transformers 3.8.1, onnxruntime-node 1.21.0 | cpu | 336 | 226 | 6 | 243 | 0.127 | 1229 | 1163 | 310 | 402 | 4/8 |
| mlx-audio | mlx-audio 0.6.4, mlx 0.32.4, misaki 0.9.4 | mlx-gpu | 1401 | 5553 | 69 | 72 | 0.040 | 798 | 3985 | 340 | 1159 | 8/8 |
| chatterbox | chatterbox-tts 0.1.7, torch 2.6.0 | mps | 17969 | 5465 | 982 | 8247 | 3.142 | 5034 | 18204 | 3318 | 987 | 8/8 |

Models: `onnx-community/Kokoro-82M-v1.0-ONNX` (kokoro-js), `mlx-community/Kokoro-82M-bf16` (mlx-audio), `ResembleAI/chatterbox` multilingual checkpoint `t3_mtl23ls_v2` (Chatterbox).

## Per passage

| Candidate | Passage | First audio ms | Total ms | Audio s | RTF |
|---|---|---|---|---|---|
| kokoro-js-q8 | en-narration | 2204 | 6147 | 15.27 | 0.402 |
| kokoro-js-q8 | en-npc-warning | 749 | 1710 | 3.95 | 0.433 |
| kokoro-js-q8 | en-npc-innkeeper | 854 | 1537 | 3.90 | 0.394 |
| kokoro-js-q8 | en-emotional | 587 | 1777 | 5.07 | 0.350 |
| kokoro-js-fp32 | en-narration | 690 | 1997 | 15.38 | 0.130 |
| kokoro-js-fp32 | en-npc-warning | 236 | 507 | 3.98 | 0.128 |
| kokoro-js-fp32 | en-npc-innkeeper | 250 | 488 | 3.92 | 0.124 |
| kokoro-js-fp32 | en-emotional | 226 | 627 | 4.95 | 0.127 |
| mlx-audio | en-narration | 149 | 527 | 15.10 | 0.035 |
| mlx-audio | en-npc-warning | 69 | 165 | 3.95 | 0.042 |
| mlx-audio | en-npc-innkeeper | 74 | 159 | 3.90 | 0.041 |
| mlx-audio | en-emotional | 69 | 207 | 5.05 | 0.041 |
| mlx-audio | pt-BR-narration | 2920 | 3275 | 16.00 | 0.205 |
| mlx-audio | pt-BR-npc-warning | 47 | 122 | 3.13 | 0.039 |
| mlx-audio | pt-BR-npc-innkeeper | 80 | 162 | 4.45 | 0.036 |
| mlx-audio | pt-BR-emotional | 58 | 166 | 4.55 | 0.037 |
| chatterbox | en-narration | 15091 | 42714 | 13.80 | 3.095 |
| chatterbox | en-npc-warning | 5658 | 15755 | 6.04 | 2.609 |
| chatterbox | en-npc-innkeeper | 7639 | 19205 | 7.60 | 2.527 |
| chatterbox | en-emotional | 8855 | 16734 | 6.72 | 2.490 |
| chatterbox | pt-BR-narration | 16442 | 50647 | 15.88 | 3.189 |
| chatterbox | pt-BR-npc-warning | 7506 | 13624 | 4.20 | 3.244 |
| chatterbox | pt-BR-npc-innkeeper | 10410 | 17668 | 4.92 | 3.591 |
| chatterbox | pt-BR-emotional | 6757 | 22201 | 6.96 | 3.190 |

- kokoro-js, all four pt-BR passages, both dtypes: failed with `Voice "pf_dora" not found. Should be one of: af_heart, ... bm_fable.` The list holds only American and British English voices. The script output repeats the full list per row; it is shortened here.
- mlx-audio `pt-BR-narration` first audio (2920 ms) includes the one-time creation of the pt-BR pipeline. The warm-up call covers English only. Later pt-BR lines take 47 to 80 ms.
- Chatterbox logged `forcing EOS token, long_tail=...` warnings on some lines. Audio durations differ from Kokoro for the same text.

## Features

| | kokoro-js 1.2.1 | mlx-audio 0.6.4 (Kokoro-82M) | Chatterbox 0.1.7 (multilingual) |
|---|---|---|---|
| Runtime | in-process Node, ONNX Runtime on CPU | Python, MLX on the Apple GPU; Apple Silicon only | Python, PyTorch on MPS |
| pt-BR | no: no pt voices, and the bundled `phonemizer` npm package accepts English language ids only (checked: `phonemize(text, 'pt-br')` throws `Invalid language identifier`) | yes, measured: voice `pf_dora`, lang code `p`, espeak-ng G2P | yes, measured: language id `pt` (generic Portuguese, not tagged as Brazilian) |
| pt-BR quality | n/a | from model docs: Kokoro's non-English voices have little training data and use espeak-ng G2P; expect lower quality than English. Not judged by listening | from model docs: Portuguese is one of 23 supported languages. Not judged by listening |
| English quality | from model docs: same Kokoro-82M weights as mlx-audio; q8 is a quantised variant. Not judged by listening | from model docs: Kokoro-82M. Not judged by listening | from model docs: Resemble AI describes Chatterbox as expressive, with emotion exaggeration control. Not judged by listening |
| Emotion control | none: voice and speed only | none: voice and speed only | yes: `exaggeration`, `cfg_weight`, `temperature` arguments (checked in the `generate` signature) |
| Streaming | sentence chunks via `stream(TextSplitterStream)`, measured | sentence chunks via `generate(split_pattern=...)`, measured | no streaming API: `generate()` returns one full waveform. The script feeds sentences one by one to get first audio |
| Voice cloning | no | no | yes, by `audio_prompt_path`; not used (project rules forbid cloning without consent) |

Audio files for listening are in `.voice-spike/<candidate>/out` after a run.

## Install problems found and fixed

- The user `uv` config adds a private index that times out. The script calls `uv` with `--no-config --default-index https://pypi.org/simple`.
- mlx-audio 0.6.4 does not pull `misaki`. Without it: `ImportError: Kokoro requires the optional 'misaki' package`. The script installs `misaki[en]==0.9.4`.
- misaki tried to download `en_core_web_sm` at run time through `uv` and failed with `No virtual environment found`. The script installs the spaCy model wheel up front.
- espeak-ng (from `espeakng-loader` 0.2.4) failed with `Error processing file '/Users/runner/.../espeak-ng-data/phontab'` in this worktree. Cause: espeak-ng keeps its data path in a 160-byte buffer, and the venv path was 175 bytes. Versions 0.2.1 and 0.2.3 failed the same way. The script copies the espeak data to a short temp folder.
- Chatterbox: `TypeError: 'NoneType' object is not callable` at `perth.PerthImplicitWatermarker()`, because `resemble-perth` 1.0.1 imports `pkg_resources`. The script pins `setuptools<81`.
- The Chatterbox model download stalled at 268 MB through `hf_xet`. The script sets `HF_HUB_DISABLE_XET=1`; the download and the whole run then finished in under 4 minutes.
- npm skipped install scripts for `sharp`, `protobufjs` and `onnxruntime-node` by default. kokoro-js ran on CPU without them.

## Not measured

- Listening quality for any candidate. All quality notes above come from model docs.
- Chatterbox on CPU, the English-only `ChatterboxTTS` model and other Chatterbox variants. Only the multilingual model on MPS was run.
- kokoro-js with a GPU or CoreML execution provider. Only `device: 'cpu'` was run.
- pt-BR in kokoro-js: not possible with 1.2.1 as shipped (see Features).
- Cold-disk load times. The reported loads follow an earlier run, so the OS file cache was warm.

## Expressive model spike (rpg-cm63.12)

The bar for adopting an expressive model in cinematic mode is first audio under 1.5 s on Apple Silicon.

| Candidate | Median first audio ms | Median RTF | Peak footprint MiB | Meets 1.5 s bar |
|---|---|---|---|---|
| chatterbox (multilingual, MPS) | 8247 | 3.142 | 18204 | no |

- The Summary and Per passage tables above already measure Chatterbox multilingual on the same machine. Its first audio is 5.5 times over the bar, and it runs 3 times slower than real time.
- No new model was tried. The numbers above are final for this bead.
- Kokoro stays the default. Text narration stays the fallback.
- Prerender plus cache stays an option for scene openings, as in ADR 0019. This bead does not build it.

### Listening samples

```bash
RPG_VOICE_SAMPLES_DIR=/tmp/voice-samples RPG_KOKORO_MODEL_DIR=<dir> RPG_MLX_AUDIO_DIR=<dir> node scripts/voice-samples/run.ts
```

- Each English and pt-BR line is written twice: `<language>-<line>-before.wav` (no shaping) and `<language>-<line>-after.wav` (pauses, loudness, and a voice blend for NPC lines on mlx-audio).
- The script writes only for engines whose model directory is set and ready. The unit test (`node --test scripts/voice-samples/run.test.ts`) uses a fake engine and never downloads or installs anything.
- Not judged by listening yet.
