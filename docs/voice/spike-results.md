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

```bash
RPG_VOICE_SAMPLES_DIR=/tmp/voice-samples node scripts/voice-samples/sound-demo.ts
```

- Writes `sound-demo-PLACEHOLDER-ambience.wav`: narration over ducked procedural noise. The ambience is a synthetic placeholder, not a CC0 recording.
- Uses `en-US-narration-after.wav` from the same folder as narration when present, otherwise a tone placeholder.

## F5-TTS pt-BR spike (rpg-cm63.52)

Measured on 2026-11-05 on the same Apple M3 Max, 64 GB, macOS 26.6.2. Python 3.12.13 from `uv`, `f5-tts` 1.1.22, `torch` 2.15.0, `f5-tts-mlx` 0.2.6, `mlx` 0.32.4. Run once per row, with nothing else running. Not repeated, so expect run-to-run noise.

```bash
# throwaway venv outside the repo, then:
python -I scripts/voice-spike/f5_bench.py --model-dir <model> --ref-audio <clip.wav> --ref-text "<clip text>" \
  --passages <pt-BR passages.json> --out <dir> --device cpu|mps --nfe-step 32|16 [--threads 4]
python -I scripts/voice-spike/f5_bench.py --backend mlx ...   # MLX route, venv with f5-tts-mlx
```

- Model: `firstpixel/F5-TTS-pt-br` at `5ebc6913f2d92e4c0cb5396a9867aa1c0c1c4281`, file `pt-br/model_last.safetensors`, 1,348,431,976 bytes, sha256 `c25e2678bdd4304071e3d0e39a283a7d23ffbc23678080c5b0b741dda2e07f0f`, licence `cc-by-nc-4.0` (card). `fuuuzzy/F5-TTS-pt-br` (`7c71fa7115fbbad3782ece7c0435c0444264be08`, `cc-by-nc-4.0`) holds files with the same sha256, so it is a copy. Config `F5TTS_Base`, vocab from `SWivid/F5-TTS` `F5TTS_Base/vocab.txt` at `84e5a410d9cead4de2f847e7c9369a6440bdfaca` (13,800 bytes). Vocoder `charactr/vocos-mel-24khz` at `0feb3fdd929bcd6649e0e7c5a688cf7dd012ef21` (MIT, 54,365,991 bytes).
- Passages: the four pt-BR passages of the tables above, lower-cased as the model card asks. Sentence split at `.`, `!`, `?`. One `generate` call per sentence; first audio is the time to the first sentence.
- Voice: reference clip `f5-pt-f1` (5.88 s) for every row. The cost grows with reference length plus generated length.
- RTF: total synthesis time divided by audio duration. Peak memory from `/usr/bin/time -l`.
- Intelligibility check, since nobody listened: each output was transcribed with `openai/whisper-small` (pt) and the word error rate (WER) against the passage text was computed. It shows words are understood. It does not rate voice quality.

### Summary

| Route | Device | Steps | Load ms | Warm-up ms | Median first audio ms | Median RTF | Peak RSS MiB | Peak footprint MiB | Mean WER |
|---|---|---|---|---|---|---|---|---|---|
| PyTorch, default threads | CPU | 32 | 8726 | 10933 | 15445 | 10.73 | 3338 | 2137 | 0.07 |
| PyTorch, default threads | CPU | 16 | 8605 | 5351 | 6408 | 4.81 | 3338 | 2136 | 0.06 |
| PyTorch, 4 threads | CPU | 32 | 7747 | 10742 | 13945 | 6.83 | 3337 | 2138 | not run |
| PyTorch | MPS | 32 | 12020 | 4033 | 2159 | 1.31 | 3087 | 4734 | 0.04 |
| PyTorch | MPS | 16 | 15199 | 1461 | 1111 | 0.68 | 3731 | 4734 | 0.06 |
| f5-tts-mlx (v1 architecture, see below) | MLX | 8 x rk4 | 741 | 2359 | 3034 | 1.07 | 1665 | 15392 | 2.96 |

Model size on disk: 1,348,431,976 + 54,365,991 + 13,800 + 461 = 1,402,812,228 bytes (1338 MiB). The PyTorch venv is 1549 MiB (macOS wheel). The four reference clips add 1.7 MB.

### Per passage, PyTorch CPU (required route)

| Steps | Passage | First audio ms | Total ms | Audio s | RTF |
|---|---|---|---|---|---|
| 32 | pt-BR-narration | 16550 | 50475 | 13.77 | 3.67 |
| 32 | pt-BR-npc-warning | 9503 | 27435 | 1.76 | 15.59 |
| 32 | pt-BR-npc-innkeeper | 20985 | 41831 | 3.27 | 12.77 |
| 32 | pt-BR-emotional | 14340 | 30308 | 3.49 | 8.69 |
| 16 | pt-BR-narration | 8385 | 24693 | 13.77 | 1.79 |
| 16 | pt-BR-npc-warning | 4587 | 9773 | 1.76 | 5.55 |
| 16 | pt-BR-npc-innkeeper | 5650 | 20360 | 3.27 | 6.22 |
| 16 | pt-BR-emotional | 7166 | 14171 | 3.49 | 4.06 |

### Per passage, PyTorch MPS

| Steps | Passage | First audio ms | Total ms | Audio s | RTF |
|---|---|---|---|---|---|
| 32 | pt-BR-narration | 3377 | 9911 | 13.77 | 0.72 |
| 32 | pt-BR-npc-warning | 1759 | 3701 | 1.76 | 2.10 |
| 32 | pt-BR-npc-innkeeper | 2319 | 4423 | 3.27 | 1.35 |
| 32 | pt-BR-emotional | 1999 | 4432 | 3.49 | 1.27 |
| 16 | pt-BR-narration | 1698 | 5248 | 13.77 | 0.38 |
| 16 | pt-BR-npc-warning | 930 | 1974 | 1.76 | 1.12 |
| 16 | pt-BR-npc-innkeeper | 1211 | 2304 | 3.27 | 0.70 |
| 16 | pt-BR-emotional | 1011 | 2311 | 3.49 | 0.66 |

### Per passage, MLX (output is not usable)

| Passage | First audio ms | Total ms | Audio s | RTF | WER |
|---|---|---|---|---|---|
| pt-BR-narration | 4701 | 14359 | 24.61 | 0.58 | 5.72 |
| pt-BR-npc-warning | 2262 | 5113 | 3.23 | 1.58 | 2.67 |
| pt-BR-npc-innkeeper | 3245 | 6484 | 5.93 | 1.09 | 1.69 |
| pt-BR-emotional | 2822 | 6529 | 6.30 | 1.04 | 1.75 |

### Provider run (the shipped code path)

`packages/voice/src/f5-tts-engine.integration.test.ts` runs the real Python service through `createF5Provider`, with the 16-step default, on MPS, shaping off, service already loaded. Four voices times six deliveries, each line `Fala baixo. O capitão escuta tudo.` (two clause pieces):

- First audio 841 to 1389 ms (the first piece). Service start 6.8 s.
- RTF 0.88 to 1.42 on these short lines.

### Verdict against the bar (RTF < 0.5 and first audio < 1.5 s with sentence streaming)

- CPU only (the route every platform has): fails both, by about 10 times on first audio at 32 steps and about 4 times at 16 steps. Median RTF is 4.8 at best.
- MPS, 16 steps: first audio passes (median 1.1 s; 0.84 to 1.39 s through the provider). RTF fails for short lines (0.66 to 1.12) and passes only for the long narration (0.38).
- So F5-TTS is registered as the slower, more expressive option, not as a live-turn engine. The measured wait is stored in `F5_MEASURED_FIRST_AUDIO_MS` and shown in the consent text.
- The 16-step default halves the wait. Its WER is the same as 32 steps in this run (0.06 against 0.04 to 0.07). Nobody listened, so the quality cost, if any, is unknown. The 32-step outputs are in the sample folder for comparison.

### MLX on the pt-BR checkpoint: does not work

- `f5-tts-mlx` 0.2.6 builds the F5TTS v1 network (`text_mask_padding=True`, no `pe_attn_head`) and loads `model_v1.safetensors`. The pt-BR checkpoint is a fine-tune of the older `F5TTS_Base` (`pe_attn_head=1`).
- Attempt 1: point `fetch_from_hub` at a folder with the checkpoint and vocab. The weights load without a key or shape error. Output is gibberish: WER 2.96.
- Attempt 2: build the DiT with `text_mask_padding=False`. Whisper heard a repeated unrelated sentence.
- `mlx` 0.32.4 also needs `mx.random.normal` to receive integer shapes. `f5_bench.py` patches that.
- Both attempts stopped there. A working MLX route needs a port of `pe_attn_head` or a v1-based pt-BR fine-tune. Neither was found at the time. A v1 fine-tune was found later and works (next section). The PyTorch MPS route stays the Apple Silicon fast path.

### MLX route, v1 pt-BR fine-tune: works, but no faster than PyTorch MPS (rpg-cm63.57, 2026-11-06)

Same machine, venvs and bench script as above. Hugging Face was searched with the `huggingface_hub` API (`F5-TTS`, `f5tts`, `portuguese`, `pt-br` and similar queries). Most pt-BR repos are fine-tunes of the older `F5TTS_Base` (no `F5TTS_v1_Base` config, or no card). One is a v1 fine-tune:

- Model: `Tharyck/multispeaker-ptbr-f5tts` at `984a19879e2fcff4a1db586f6a74994c9dfed537`. Card `license: apache-2.0`, `base_model: SWivid/F5-TTS` (so the base `cc-by-nc-4.0` term likely still applies; not resolved), trained on `Tharyck/multispeaker-tts-ptbr` plus private data, 390.78 h, `F5TTS_v1_Base` config, `pe_attn_head: null`, char tokenizer, "educational and research" notice.
- File `model_last.safetensors`, 1,348,431,976 bytes, sha256 `39435f0d0179abc166cd443c6bc60b8a55f7908e368b58887853e4a7d94d488b`. Vocab `vocab.txt`, 11,255 bytes, 2546 entries, sha256 `4e173934be56219eb38759fa8d4c48132d5a34454f0c44abce409bcf6a07ec46`. The embedding has 2546 rows, so it matches `f5-tts-mlx` unchanged.
- No port is needed. `f5-tts-mlx` 0.2.6 loads the checkpoint through its own key conversion with no change. The vocoder is `lucasnewman/vocos-mel-24khz` (as in the earlier MLX row).
- Not evaluated: `BornSaint/F5-TTS-PT-BR` (`cc-by-nc-4.0`, 5.4 GB `.pt`, no config), `ModelsLab/F5-tts-brazilian`, `traderpedroso/F5-TTS-BRAZILIAN-PORTUGUESE`, `Tharyck/f5-tts-ptbr-multispeaker` (all from 2024 to early 2025, older base by date and size), `RodrigoLimaRFL/f5tts-pt-br` (April 2026, 5.4 GB `.pt`, no card or config, base unknown). The pe_attn_head port (step 2 of the plan) was not attempted, because step 1 succeeded.

Passages, reference clip `f5-pt-f1`, one run each, WER from `openai/whisper-small` (pt). Median over the four passages:

| Route | Device | Steps | Load ms | Warm-up ms | Median first audio ms | Median RTF | Peak RSS MiB | Peak footprint MiB | Mean WER |
|---|---|---|---|---|---|---|---|---|---|
| f5-tts-mlx, Tharyck v1 | MLX | 8 x rk4 (MLX default) | 946 | 2535 | 2156 | 1.12 | 1661 | 11559 | 0.08 |
| f5-tts-mlx, Tharyck v1 | MLX | 4 x rk4 | 1336 | 1091 | 956 | 0.53 | 1635 | 11505 | 0.70 (unusable) |
| PyTorch, Tharyck v1 (`F5TTS_v1_Base`) | MPS | 32 | 7310 | 2420 | 2255 | 1.39 | 3754 | 4731 | 0.10 |
| PyTorch, Tharyck v1 (`F5TTS_v1_Base`) | MPS | 16 | 11222 | 1777 | 1143 | 0.70 | 3754 | 4731 | 0.10 |
| PyTorch, firstpixel (shipped, from the table above) | MPS | 16 | 15199 | 1461 | 1111 | 0.68 | 3731 | 4734 | 0.06 |

Per passage WER, MLX 8 x rk4: narration 0.32, warning 0.00, innkeeper 0.00, emotional 0.00. The narration miss is a leaked "uma história" at the start and mangled proper nouns ("Varrow", "portões"). PyTorch MPS 16 steps: narration 0.09, warning 0.33 (drops "Fala baixo"), innkeeper 0.00, emotional 0.00. The WER differences between the two checkpoints are single words on short lines. Nobody listened.

Verdict:

- The MLX route speaks intelligible pt-BR with a v1 fine-tune. Previous gibberish came from the architecture mismatch, as suspected.
- It is not faster. `f5-tts-mlx` has no 16-evaluation setting that works: 8 x rk4 is 32 network evaluations and gives RTF 1.12, against 0.70 for PyTorch MPS at 16 steps. 4 x rk4 is fast (RTF 0.53) and unintelligible.
- MLX wins only on load time (about 1 s against 7 to 15 s) and process RSS (1.7 GiB against 3.8 GiB). Its peak footprint is 11.5 GiB, 2.4 times the PyTorch figure.
- Decision: no integration. The shipped PyTorch route on CUDA, MPS and CPU stays. A second checkpoint (1.3 GB), a second venv and a second backend in the service would buy start-up time at the cost of speed.
- Not run: MLX quantised weights (`quantization_bits` in `f5-tts-mlx`), MLX with fewer or different solver settings than the two above, Windows, Linux, CUDA, listening.
- Side result worth an A/B listening test: the Tharyck v1 checkpoint runs on the shipped PyTorch route at the same speed as the firstpixel checkpoint (RTF 0.70 against 0.68), trained on 390 h of multispeaker data. Whether it sounds better is unknown.

### Reference voices

All four clips come from Google FLEURS `pt_br` (`google/fleurs` at `70bb2e84b976b7e960aa89f1c648e09c59f894dd`). The dataset card says `license: cc-by-4.0`. Speakers are anonymous. Gender comes from the FLEURS `gender` column. FLEURS has no age column, so age is recorded as `adult` and is unverified. Timbre words follow the measured median pitch (`torchaudio` pitch detector, crude), not listening.

| Voice | Gender | Median pitch Hz | Seconds | Archive member | Bytes | sha256 |
|---|---|---|---|---|---|---|
| `f5-pt-f1` | female | 239 | 5.88 | `train/10037811280993524975.wav` | 376378 | `3ffc02e569d3794458183d3a1912180795b86310a2be0f39538e574dad117189` |
| `f5-pt-f2` | female | 176 | 8.16 | `train/11084584502097351417.wav` | 522298 | `fcf372dfe679fd013fd216c16e6e80dea0ea39e7b117f5e58bd9027814168e9c` |
| `f5-pt-m1` | male | 140 | 6.12 | `dev/1331833229962432141.wav` | 391738 | `169a25c13fe054bfde45c3adb5712b6c2ecd8c0c911fedea7c30a6d945ff6c0d` |
| `f5-pt-m2` | male | 165 | 6.00 | `dev/14597665433717979060.wav` | 384058 | `dd4ce1cfc91ad9bcb73d744d8bd5ea3b37e6c51b134302b2d4e40ec93a31a5b0` |

- Attribution: Google FLEURS pt_br, CC BY 4.0, anonymous read-speech volunteer. Conneau et al., FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech, arXiv:2205.12446.
- Licence gaps: the licence is read from the dataset card only. The FLEURS sentences come from FLoRes (a separate licence, not checked). Speaker consent is not stated per clip in the card. FLEURS has no speaker id, so two clips could share a speaker. The pitch gap (140 to 239 Hz) makes it unlikely, not certain.
- The clips are not in git. The installer streams the two archives from the pinned revision (read caps 62.3 MB and 113.2 MB), keeps only these four members, and checks every sha256.

### Delivery to speed

F5-TTS has a `speed` argument and no emotion argument. Each delivery emotion maps to the provider speed already computed from `KOKORO_DELIVERY_SPEED` (calm 0.9, whisper 0.8, tense 1.1, angry 1.15, excited 1.25, clamped to 0.5 to 2). Per-voice emotion reference clips would give real expression. No licensed emotional pt-BR clip was found, so none are used. A test keeps the mapping in step with the shared vocabulary.

### Install problems found and fixed

- `f5-tts` pulls `torch` 2.15.0 and `torchaudio` from the default index. The macOS venv is 1549 MiB. Linux and Windows wheels were not installed here and are likely larger (CUDA libraries on Linux). The offer shows the macOS figure.
- `F5TTS` (the `f5_tts.api` class) accepts `ckpt_file`, `vocab_file` and `vocoder_local_path`, so the service runs with `HF_HUB_OFFLINE=1` after the download step.
- `pydub` prints `SyntaxWarning` on import. Harmless.

### Not measured

- Windows, Linux and CUDA: nothing was run on them. The CPU rows are Apple M3 Max CPU cores. A mid-range x86 laptop will be slower. The 4-thread row is not a substitute: it was not slower than the default.
- Listening quality, expression and voice similarity. WER only.
- Peak memory for long passages beyond these four.
- `num2words` for digits: the model card asks for numbers as words. The service now expands digits to pt_BR words before synthesis (`num2words==0.5.14`).

## Kokoro pt-BR on ONNX, CPU only (rpg-cm63.53)

Measured on 2026-11-06. Apple M3 Max (16 cores), macOS 26.6.2, Node v24.22.1. onnxruntime-node 1.21.0 with the `cpu` execution provider. MLX is not involved: nothing in this run imports mlx-audio or starts Python.

### Route

- Model: `onnx-community/Kokoro-82M-v1.0-ONNX`, `onnx/model.onnx` (fp32, 325532232 bytes), voices `pf_dora`, `pm_alex`, `pm_santa` from `voices/*.bin` (522240 bytes each). Every file is sha256-pinned in `packages/voice/src/kokoro-model.ts`.
- Phonemes: `@echogarden/espeak-ng-emscripten` 0.3.5, voice `pt-br`. The `phonemizer` 1.2.1 package that kokoro-js bundles was tried first and rejects `pt-br` (its data holds English voices only).
- Engine: `packages/voice/src/kokoro-onnx-engine.ts`. Text goes through espeak-ng per clause, punctuation is kept, phoneme separators are dropped, characters outside the model vocabulary are dropped, and the ids are padded with 0 at both ends (at most 510). The style row is `voice[tokenCount]`, where the token count excludes the two pad ids. Output is 24 kHz mono 16-bit WAV.
- Measured by `/tmp` script that loads the real engine with the real model, `Olá.` warm-up first, `scripts/voice-spike/passages.ts` pt-BR passages, split at `.`, `!`, `?`. First audio is the time to the first sentence. RTF is total synthesis time over audio duration. The script is not in the repo.

### Results

| Metric | Value |
|---|---|
| Load ms (session create) | 357 |
| espeak-ng WASM init ms | 36 |
| Warm-up ms | 135 |
| Peak RSS MiB (Node process, after all passages) | 1025 |
| Median first audio ms, pf_dora, run 2 | 271 (range 157 to 626) |
| Median RTF, pf_dora, run 2 | 0.125 |

| pt-BR passage (pf_dora) | First audio ms (run 1 / 2) | Audio s | RTF (run 1 / 2) |
|---|---|---|---|
| narration | 726 / 626 | 16.42 | 0.135 / 0.126 |
| npc-warning | 163 / 157 | 3.10 | 0.131 / 0.128 |
| npc-innkeeper | 342 / 321 | 4.70 | 0.130 / 0.124 |
| emotional | 248 / 221 | 4.75 | 0.140 / 0.123 |

| Voice, npc-innkeeper | First audio ms | RTF |
|---|---|---|
| pm_alex | 328 | 0.123 |
| pm_santa | 330 | 0.124 |

### Against MLX on the same machine

- MLX through the service (ADR 0019 Amendment 1): median first audio 63 ms, median RTF 0.036 in the spike. Through the provider and service: first audio 57 to 1029 ms, RTF 0.037 to 0.176.
- ONNX CPU is about 3.5 times slower in RTF and 2.5 to 5 times slower to first audio than the spike figures, and about on par with the provider-and-service figures. Both are well under real time. So MLX stays the Apple Silicon fast path, and ONNX serves every other platform and anyone who turns MLX off.
- ONNX needs no Python: 311 MiB of model and voice files against 1.5 GB for the mlx-audio venv plus model.

### Not measured

- Windows, Linux, Intel Macs and x86 CPUs. The numbers above are Apple M3 Max CPU cores. A mid-range x86 laptop will be slower; the RTF bar of 1 is likely still met, but nothing was run to show it.
- Listening quality and pronunciation. Nobody listened to the output and no speech-to-text check ran. Only duration, sample rate and non-empty audio were checked. The espeak-ng pt-br output uses its own phoneme set, not the misaki one the model was trained on, so some sounds may be off.
- The `kokoro-onnx-engine.integration.test.ts` test through the repo's own module resolution. This worktree had no `node_modules`, so the measurement injected the espeak and onnxruntime modules from a scratch install. The test skips unless `RPG_KOKORO_MODEL_DIR` holds the files.
- Peak memory per process beyond the Node RSS above.
