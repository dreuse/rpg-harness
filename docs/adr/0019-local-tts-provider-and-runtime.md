# ADR 0019 — Local TTS: Kokoro-82M through kokoro-js, in-process in Node

**Status:** Accepted, amended for pt-BR (see Amendment 1). **Decision:** The default local TTS provider is Kokoro-82M through `kokoro-js` with the `fp32` ONNX model on CPU. It runs in-process in the Node engine. There is no local Python service. Speech is English only. Other languages fall back to text narration.

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

## Amendment 1 — Brazilian Portuguese through an optional mlx-audio service (rpg-cm63.9)

**Status:** Accepted. **Decision:** pt-BR speech uses an optional local mlx-audio service, provider id `kokoro-mlx`. English stays on in-process kokoro-js. The service is installed only with consent, runs only on Apple Silicon Macs, and starts on demand. Every other platform keeps text narration for pt-BR, as before.

### In-process route (tried first)

- kokoro-js 1.2.1 rejects every voice outside its English table and phonemizes with English language ids only. A pt-BR route would drive the ONNX model directly, load `voices/pf_dora.bin` from the ONNX repo, and phonemize with an espeak-ng WASM build.
- The session that built this amendment had no permission to run the downloaded espeak-ng WASM. So pt-BR phonemes from WASM were never produced or heard. The route is unmeasured, not rejected.
- espeak-ng and its WASM builds are GPL-3. The `phonemizer` package that kokoro-js bundles already embeds an espeak-ng WASM build. The owner must check the licence before this route ships.
- mlx-audio already ran pt-BR end to end in the spike, so it is the measured route.

### Design

- `packages/voice/src/mlx-audio-service.py` is a stdlib `http.server` on `127.0.0.1` with a random port. It accepts only `POST /synthesize`. Each start gets a new random 32-byte bearer token, passed by environment and compared with `hmac.compare_digest`.
- Requests are checked: at most 16 KiB of body and 2000 characters of text, a fixed voice allowlist (`pf_dora`, `pm_alex`, `pm_santa`), and a numeric speed from 0.5 to 2.0. Campaign text goes in the request body only, never in arguments or a shell.
- The engine starts `venv/bin/python -I mlx-audio-service.py serve`. The environment has `PATH`, `HOME`, `TMPDIR`, `LANG`, `HF_HOME`, `HF_HUB_OFFLINE=1` and the token, and nothing else. The service prints `READY <port>`. It exits on SIGTERM or when stdin closes, so it cannot outlive the engine.
- The model is pinned to `mlx-community/Kokoro-82M-bf16` at revision `a71e4d38b236d968966a2002c4c895dbd12b1c3c`. Only the config, the weights and the three pt-BR voices are loaded.
- The service copies the espeak-ng data to a short temp path. This works around the mlx-audio path length bug that the spike found.
- `KokoroProvider` gains `preload()`. A cold service start took 2.1 to 3.4 s, which is close to the 5 s first-chunk timeout. A caller should preload when a pt-BR campaign opens.
- The installer runs only with a `ModelConsent` that matches the offer (about 1499 MiB: 1159 MiB of Python packages plus a 340 MiB model). It runs `uv venv`, `uv pip install` with the spike's pinned specs from public PyPI, and then the service `download` mode. A missing `uv` gives a plain message.
- Narrator default per language: `af_heart` for English and `pf_dora` for pt-BR. Important NPCs get a stable hashed voice from the same language that differs from the narrator, so in pt-BR they get `pm_alex` or `pm_santa`.
- `noVoiceNotice` tells the player in plain English when no voice exists for their language, for example European Portuguese, or when the pt-BR voices are not available on this computer.

### Measured basis (M3 Max, 64 GB)

Spike rerun with `node scripts/voice-spike/run.ts --skip-install --candidates mlx-audio`, mlx-audio 0.6.4, mlx 0.32.4 and misaki 0.9.4 on the MLX GPU:

| Metric | Value |
|---|---|
| Load ms | 1048 |
| Warm-up ms | 4651 |
| Median first audio ms | 63 |
| Median RTF | 0.036 |
| Peak footprint MiB | 3987 |
| Passages ok | 8/8 |

| pt-BR passage | First audio ms | Audio s | RTF |
|---|---|---|---|
| narration | 699 | 16.00 | 0.074 |
| npc-warning | 47 | 3.13 | 0.039 |
| npc-innkeeper | 73 | 4.45 | 0.034 |
| emotional | 58 | 4.55 | 0.034 |

Through the provider and the service (`mlx-audio-engine.integration.test.ts`, two runs):

| Voice | First audio ms | RTF |
|---|---|---|
| pf_dora (narration) | 567 to 1029 | 0.092 to 0.176 |
| pm_alex (NPC) | 57 to 199 | 0.042 to 0.137 |
| pm_santa (NPC) | 95 to 412 | 0.037 to 0.143 |

The first sentence after start is the slowest. The second run was slower overall, probably because of machine load.

### Narrator voice

`pf_dora` stays the pt-BR narrator default. Latency is the same across the three voices, so the measurements do not favour another voice. The samples for listening are not yet judged by a person. If the owner prefers another voice after listening, only the `narrator` entry in `LANGUAGE_VOICES` changes.

### Consequences

- pt-BR speech needs about 1.5 GB of disk and about 4 GB of peak footprint while the service is loaded. The idle unload stops the service.
- The Python packages are pinned at the top level only. Their dependencies resolve at install time.
- Only pt-BR is offered through mlx-audio. Other Kokoro languages are not measured and not claimed.

## Amendment 2 — Cinematic delivery on Kokoro, no expressive model (rpg-cm63.12)

**Status:** Accepted. **Decision:** Kokoro stays the default for both routes (`kokoro` and `kokoro-mlx`). Delivery gets more natural through deterministic shaping in the provider. No expressive model is adopted.

### Expressive model spike

- Chatterbox multilingual was already measured in the table above: median first audio 8247 ms, RTF 3.14, peak footprint 18204 MiB. It fails the 1.5 s first-audio bar by a wide margin.
- No other model was tried in this bead. Text narration stays the fallback. Prerender plus cache for scene openings stays possible and is not built.

### Delivery shaping

- Shaping lives in `packages/voice/src/delivery-shaping.ts`. Both routes use it through `createKokoroProvider`. It is on by default and the `shaping: false` option turns it off.
- Pauses: silence is appended to each sentence chunk, so the chunk count, sequence and `final` flag do not change. The pause depends on the end mark (`.` 350 ms, `!` 300 ms, `?` 400 ms, `…` 500 ms, otherwise 250 ms). It is 150 ms longer before a sentence that opens dialogue (a quote or a leading dash). The delivery emotion scales it, from 0.6 for `tense` to 1.5 for `sad`, weighted by intensity. The last sentence has no pause.
- Scene breaks: a blank line adds at least 600 ms after the sentence before it. A line of `***`, `---` or `___` adds at least 1400 ms. The marker is never sent to the engine.
- Speed: `KOKORO_DELIVERY_SPEED` gains `tense` (1.1). `whisper` (0.8) and `calm` (0.9) were already there.
- Loudness: each chunk is scaled to an RMS of 0.1, limited to a peak of 0.98 and a gain of 8. Near-silent chunks are left as they are. Audio that is not a 16-bit PCM or 32-bit float WAV passes through unchanged. kokoro-js returns 24 kHz mono 32-bit float WAV, and the mlx-audio service returns 24 kHz mono 16-bit PCM. The shaped chunk keeps the format of its input.
- Voice blend: `voiceBlendFor(npcId, voiceId, voices)` in `cinematic.ts` picks a second voice of the same accent and gender from the provider's own voice list, plus a weight from 0.2 to 0.4, using the existing hash. It returns nothing when no partner exists (for example `pf_dora`). The provider takes it through the `voiceBlend` option and passes it to the engine only when the engine sets `blends` and both voices are in the provider's capabilities. Otherwise the single voice is used.
- mlx-audio blends: the service accepts a `blend` field (`first`, `second`, `weight`), checks it against the voice allowlist, and mixes the two style vectors as `(1 - weight) * first + weight * second` before synthesis. It uses the private `_get_pipeline` of mlx-audio 0.6.4, so a version bump needs a recheck. A blended and a plain request were run against the installed service and both returned 24 kHz mono 16-bit WAV.
- kokoro-js does not blend. Mixing voice embeddings needs a way around its fixed voice table, which is not simple, so it keeps the single voice.
- Nothing calls `voiceBlend` yet. Wiring main NPC ids into it is left to the code that builds the providers.

## Amendment 3 — Cross-platform pt-BR on Kokoro ONNX (rpg-cm63.53)

**Status:** Accepted. **Decision:** pt-BR speech gets a second route that runs the Kokoro-82M ONNX model from Node on the CPU, provider id `kokoro-onnx`. It works on Windows, Linux, Intel Macs and Apple Silicon with MLX switched off. mlx-audio (`kokoro-mlx`) stays the Apple Silicon fast path. Amendment 1 said every other platform keeps text for pt-BR. That no longer holds once the ONNX files are installed.

### Route choice

- `choosePtBrRoute` in `packages/voice/src/pt-br-route.ts` returns `mlx` on Apple Silicon and `onnx` everywhere else. `RPG_PT_BR_ROUTE=onnx` turns MLX off on Apple Silicon. No value forces MLX where it cannot run.
- Why MLX stays: measured on the same M3 Max, MLX is about 3.5 times faster in RTF (0.036 against 0.125) and has a lower first audio in the spike. See `docs/voice/spike-results.md`, section "Kokoro pt-BR on ONNX, CPU only".
- `languageVoicesFor(route)` in `language-voices.ts` gives the pt-BR narrator (`pf_dora`) on the provider of the chosen route. The CLI registers `kokoro-onnx` when the route is `onnx`.
- The desktop host and its page still list only `kokoro-mlx` as the Brazilian provider. Desktop pt-BR on other platforms needs a follow-up bead. Nothing else breaks there.

### Design

- `kokoro-onnx-engine.ts` implements the existing `KokoroEngine` interface. Ports for the phonemizer and for onnxruntime-node are injectable, so tests use fakes and the real modules load only in `load()`.
- Voices are checked against the three pt-BR names before any file path is built.
- Files live under the same model root as the English model. `KOKORO_PT_BR_MODEL_OFFER` in `kokoro-model.ts` defines the offer: the base files plus three sha256-pinned voice files (about 311 MiB). No CLI or desktop screen offers these files yet and nothing calls `ModelManager` for them. Until the follow-up bead "wire pt-BR ONNX download offer into CLI and desktop" lands, a person installs them by placing the pinned files in the model root by hand. `ready()` reports false until every file is there. Weights stay out of git. `.voice-spike/` is ignored for development copies.
- New dependencies in `packages/voice`: `onnxruntime-node` 1.21.0 (already installed through `@huggingface/transformers`, now direct) and `@echogarden/espeak-ng-emscripten` 0.3.5. The second is new because the `phonemizer` package that kokoro-js bundles only holds English voices.

### Licences

| Part | Licence | Note |
|---|---|---|
| espeak-ng (WASM build `@echogarden/espeak-ng-emscripten`) | GPL-3.0 | Linked into the voice package. The project is non-commercial. A commercial or closed distribution needs a different phonemizer or a legal review first. |
| Kokoro-82M ONNX model and voices (`onnx-community/Kokoro-82M-v1.0-ONNX`) | Apache-2.0 | From the model card. |
| onnxruntime-node | MIT | |

- Owner action: confirm that GPL-3.0 for the espeak-ng WASM package is acceptable for how the app is distributed.

### Consequences

- pt-BR speech works without Python on any platform onnxruntime-node supports, at about 311 MiB of disk.
- Quality is not judged. The espeak-ng pt-br phonemes are not the ones the model was trained on, so a person must listen before this route is called good.
- Only the CPU provider is used. GPU providers are not tried.
