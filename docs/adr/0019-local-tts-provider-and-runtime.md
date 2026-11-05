# ADR 0019 — Local TTS: Kokoro-82M through kokoro-js, in-process in Node

**Status:** Accepted. **Decision:** The default local TTS provider is Kokoro-82M through `kokoro-js` with the `fp32` ONNX model on CPU. It runs in-process in the Node engine. There is no local Python service. Speech is English only. Other languages fall back to text narration.

**Context:** rpg-cm63.1, Phase 0 of the local voice epic rpg-cm63. Three candidates ran on the dev machine (M3 Max, 64 GB): kokoro-js (ONNX in Node), mlx-audio (Kokoro-82M on MLX, Python) and Chatterbox multilingual (PyTorch on MPS, Python). Measurements, versions and the run command are in `docs/voice/spike-results.md`.

## Measured basis

| Candidate | Median first audio ms | Median RTF | Peak footprint MiB | Model MiB | pt-BR |
|---|---|---|---|---|---|
| kokoro-js fp32 | 243 | 0.127 | 1163 | 310 | no |
| kokoro-js q8 | 802 | 0.398 | 474 | 88 | no |
| mlx-audio | 72 | 0.040 | 3985 | 340 | yes |
| Chatterbox | 8247 | 3.142 | 18204 | 3318 | yes |

## Rationale

- Latency is close enough. kokoro-js fp32 gives first audio in about a quarter second and runs about 8 times faster than real time. mlx-audio is faster, but both are well inside a live turn.
- Quality is the same model. kokoro-js and mlx-audio both run the Kokoro-82M weights. The difference is the runtime, not the voice.
- In-process Node removes a second runtime. mlx-audio needs a Python venv (1159 MiB), extra packages that its own install skips, and a workaround for an espeak-ng path length bug. MLX runs only on Apple Silicon. kokoro-js runs wherever Node runs.
- `fp32` over `q8`. On this CPU, q8 was about 3 times slower (RTF 0.398, first audio 802 ms). q8 is smaller and uses less memory, so it stays a possible low-memory setting.
- Chatterbox is not usable for live narration. It ran about 3 times slower than real time, with an 18 GB peak footprint and a 3.3 GB model.

## Consequences

- rpg-cm63.2 adds `kokoro-js` 1.2.1 to the voice package. Its dependencies `@huggingface/transformers` and `onnxruntime-node` come with it.
- The model (310 MiB) downloads only after an explicit user action. Nothing downloads at install, at start or in tests.
- Expect about 1.2 GB peak memory while the model is loaded. Unload took under 15 ms.
- Streaming is per sentence: the provider yields audio one sentence at a time.

### Unsupported features

- pt-BR speech and every non-English language. kokoro-js 1.2.1 ships only English voices, and its `phonemizer` package accepts English language ids only. pt-BR falls back to text narration.
- Emotion or style control. Kokoro takes a voice and a speed only. The spike sent the emotional line as plain text with no style setting.
- Voice cloning.
- Streaming below sentence level.
- GPU or CoreML acceleration for kokoro-js. Only CPU was measured.

### Follow-up options, not decided here

- pt-BR in-process: the ONNX model repo has the pt-BR voices (`pf_dora`, `pm_alex`, `pm_santa`). kokoro-js needs a pt-BR phonemizer and a way around its fixed voice table. Not measured.
- pt-BR through an optional local mlx-audio service: measured at 47 to 80 ms first audio for short lines. It brings back the Python runtime and works only on Apple Silicon.
- Expressive NPC lines through Chatterbox: only for pre-rendered audio, not for live turns.
