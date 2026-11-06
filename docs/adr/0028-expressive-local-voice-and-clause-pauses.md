# ADR 0028 — Clause pauses on Kokoro and an optional expressive local engine (rpg-cm63.47)

**Status:** Accepted. Amended 2026-11-05 (F5-TTS reopened, see Amendment 1) and 2026-11-06 (cross-platform Chatterbox route, see Amendment 2). **Decision:** (1) Kokoro speech splits at clause marks and appends a named silence after each piece, so commas, semicolons, colons and dashes are audible. (2) Chatterbox Multilingual is added as an optional local provider, id `chatterbox`, for Brazilian Portuguese (pt-BR) with emotion control. It is off by default, downloads only with consent, and never replaces Kokoro as the default or the fallback.

**Context:** The owner reported that pt-BR voices run clauses together and show no emotion (bead rpg-cm63.47). Kokoro takes a voice and a speed only (ADR 0019). ADR 0019 Amendment 2 measured Chatterbox as too slow for live turns and did not compare other engines. Facts below were read on 2026-11-05 from the Hugging Face API, PyPI and the `chatterbox-tts` 0.1.7 wheel, or come from `docs/voice/spike-results.md`. Anything else is marked unverified.

## Clause pauses

- `shapeSentences` (`delivery-shaping.ts`) now splits each sentence after `,` `;` `:` followed by a space, and after a spaced em or en dash. A closing quote after the mark stays with the piece. A decimal comma (`1,5`) and a leading dialogue dash do not split.
- `CLAUSE_PAUSE_MS`: `,` 180 ms, `;` 280 ms, `:` 280 ms, dash 250 ms. Sentence ends keep their pauses (`.` 350, `!` 300, `?` 400, `…` 500). The delivery emotion scales every pause.
- Each piece keeps its own mark, so `?` and `!` reach the engine. One chunk is yielded per piece, with `sequence` and `final` counted over pieces.
- Tests: fake-engine PCM silence assertions in `kokoro-provider.test.ts` and one real Kokoro run in `kokoro-js-engine.integration.test.ts` (English text, because kokoro-js has no pt-BR). A pt-BR run through the real mlx-audio service is in `mlx-audio-engine.integration.test.ts`. It is skipped until `RPG_MLX_AUDIO_DIR` points at an install.
- Not done: abbreviations such as `Sr.` still end a sentence in the English sentence segmenter, as before.

## Engine comparison

| | Chatterbox Multilingual (v2 checkpoint, `chatterbox-tts` 0.1.7) | F5-TTS and its pt-BR fine-tunes | Other pt-BR candidates seen on Hugging Face |
|---|---|---|---|
| Licence | MIT for the code (PyPI) and the weights (card `license: mit`, repo `ResembleAI/chatterbox` at `5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18`). Verified. Passes | Base weights `SWivid/F5-TTS` are `cc-by-nc-4.0` (verified). Fine-tunes `firstpixel/F5-TTS-pt-br` and `fuuuzzy/F5-TTS-pt-br` are `cc-by-nc-4.0` (verified). `Tharyck/multispeaker-ptbr-f5tts` is tagged `apache-2.0`, with 0 downloads. Whether it can drop the base non-commercial term was not checked. Fails for the main line | Tagged `apache-2.0`: `marcosremar2/orpheus-ptbr-v1`, `freds0/parler-tts-mini-v1.1-ptbr`, `neocia/cosyvoice2-cml-ptbr`. Tags only. Upstream licences and training data were not checked |
| Size | The five files we need total 3,207,031,585 bytes (about 3059 MiB), from the repo tree. Venv install measured at 987 MiB. Card: 500M parameters | Not measured. Unverified | Not measured. Unverified |
| Speed on Apple Silicon | Measured in the spike (M3 Max, MPS, PyTorch): median first audio 8247 ms, real-time factor 3.14, peak footprint 18204 MiB. Fails the 1.5 s live bar | Not run. Unverified | Not run. Unverified |
| pt-BR quality | Not judged by listening. Unverified. Language id `pt` (generic Portuguese). The card lists a dedicated Brazilian Portuguese fine-tune `ResembleAI/Chatterbox-Multilingual-pt-br` (MIT, `t3_pt_br.safetensors` 2,143,990,296 bytes, revision `b3952f18bc2eaa72b9bd7c17d2c4653bcad4770d`). `chatterbox-tts` 0.1.7 loads only the v2 file names, so that pack needs newer loader code. Unverified | Not heard. Unverified | Not heard. Unverified |
| Emotion control | `exaggeration` and `cfg_weight` arguments of `generate` (checked in the wheel). Card: default 0.5 and 0.5; lower `cfg_weight` and higher `exaggeration` for dramatic speech | Not checked. Unverified | Not checked. Unverified |
| Other | Perth watermark in every output (card). Voice cloning by `audio_prompt_path`, not used. Community MLX and CoreML pt-BR ports exist (`theoracleguy/Chatterbox-Multilingual-pt-br-MLX`, `itsmechico/chatterbox-multilingual-pt-br-coreml-ane`, both tagged MIT, unmeasured). They could change the speed verdict | Code licence assumed MIT. Unverified | Piper pt_BR voices are fast and not expressive. They belong to rpg-cm63.45 |

Not compared: XTTS-v2 (licence believed non-commercial, unverified here) and cloud engines (the epic is local only).

## Decision

- Chatterbox Multilingual v2 is the only engine that passes the licence check and has a measured run, so it becomes the optional provider. F5-TTS pt-BR fails on the non-commercial weights licence.
- It fails the live speed bar by 5.5 times. So it is opt-in, never the default, and a campaign that picks it still falls back to Kokoro when it is not installed, not supported (needs Apple Silicon) or unhealthy.
- Each clause piece is a separate `generate` call, so the first chunk is shorter than the earlier per-sentence chunk. Whether this brings first audio near the bar was not measured.
- The Brazilian Portuguese single-language pack and the MLX and CoreML ports are the next candidates. Evaluate them before investing in Chatterbox v2 further.

## Provider design

- Mirrors the mlx-audio route: `packages/voice/src/chatterbox-engine.ts`, `chatterbox-install.ts` and `chatterbox-service.py`. The shared process code moved to `local-service-engine.ts`, which `mlx-audio-engine.ts` now uses too.
- The service listens on `127.0.0.1` with a random port and a per-start bearer token. It checks body size, text length, a voice allowlist and the numeric ranges. It runs with `HF_HUB_OFFLINE=1` and loads the model from a local directory with `ChatterboxMultilingualTTS.from_local`, which the wheel confirms.
- Consented download: `CHATTERBOX_OFFER` states the source (PyPI pins, Python 3.12 via uv, model repo at the pinned revision) and the byte size (987 MiB venv plus the file sizes). `install` refuses without a matching `ModelConsent`, off Apple Silicon and without `uv`.
- Checksum: the installer hashes every model file with SHA-256 after the download and deletes a file that does not match. The hashes come from the Hugging Face LFS metadata (large files) or from a download at the pinned revision (the JSON file).
- Installed means: Apple Silicon, the venv Python exists and every model file has its exact byte size. Otherwise `healthy()` is false and the existing no-voice notice applies. Nothing claims the voice is installed when it is not.
- Delivery to emotion: `chatterboxExpression` maps each delivery emotion to `exaggeration` and `cfg_weight`, scaled from neutral (0.5, 0.5) by intensity. `angry` and `excited` are the strongest (0.9, 0.3), standing in for a shout. `tense` is 0.7 and 0.4. `calm` is 0.35 and 0.4. `whisper` is the minimum 0.25 and 0.4. Chatterbox has no whisper mode, so this is only a quieter, flatter delivery. The values are starting points taken from the card's advice, not tuned by listening. The delivery vocabulary has no `shout` name. A test keeps the table in step with `KOKORO_DELIVERY_SPEED`.
- The provider reuses `createKokoroProvider` (queueing, idle unload, clause pauses, shaping). `KokoroEngine.synthesize` gained an optional last `delivery` argument. Chatterbox has no speed control, so the speed argument is ignored.
- Voices: one, `chatterbox-default` (the built-in voice from `conds.pt`). Its gender and age are not known, so it is not in `VOICE_CATALOG`, not in `LANGUAGE_VOICES`, and never picked automatically. `voicesFor('pt-BR')` still returns Kokoro.

## Coordination with rpg-cm63.45

The voices of this engine count toward the target of rpg-cm63.45 once the owner listens and labels gender and age for `chatterbox-default`. Until then it counts as zero. More voices would need reference clips. The project forbids cloning without consent, so a clip needs a licence or a recorded consent. rpg-cm63.45 owns that work.

## Consequences

- A second Python runtime of about 4 GB on disk and about 18 GB peak memory while loaded (measured). Idle unload stops the service.
- The listening test (acceptance criterion 4) needs a person and the real model. It was not run in this bead.
- Still to do: build the provider in the desktop and CLI composition roots, add a settings entry and an install action, run the Python service once with real weights, and measure first audio per clause.

## Amendment 1 (2026-11-05, rpg-cm63.52): F5-TTS pt-BR added as a second optional provider

**Owner decision.** The `CC-BY-NC-4.0` licence of F5-TTS is acceptable, because RPG Harness is not a commercial product. The licence rejection in the table above no longer applies. The engine must run on macOS, Windows and Linux. MLX may only be an Apple Silicon fast path.

**Measured** (full tables in `docs/voice/spike-results.md`, Apple M3 Max, one run each):

- PyTorch on CPU, `firstpixel/F5-TTS-pt-br`, 32 steps: median first audio 15445 ms, median RTF 10.73. At 16 steps: 6408 ms and 4.81. Peak footprint 2137 MiB, peak RSS 3338 MiB.
- PyTorch on MPS, 16 steps: median first audio 1111 ms, median RTF 0.68 (long narration 0.38, short NPC lines 0.66 to 1.12). Through the provider and the real service: first audio 841 to 1389 ms. Peak footprint 4734 MiB.
- Model: 1338 MiB on disk (acoustic model, vocab, vocoder). Venv: 1549 MiB on macOS.
- Intelligibility: Whisper-small word error rate 0.04 to 0.07 across the four passages. Nobody has listened.
- MLX (`f5-tts-mlx` 0.2.6): its network is the v1 architecture. The pt-BR checkpoint is a fine-tune of the older base. It loads and speaks gibberish (WER 2.96). Two attempts. Not shipped.
- MLX with a v1 pt-BR fine-tune (rpg-cm63.57, 2026-11-06): `Tharyck/multispeaker-ptbr-f5tts` at `984a19879e2fcff4a1db586f6a74994c9dfed537`, `model_last.safetensors` sha256 `39435f0d0179abc166cd443c6bc60b8a55f7908e368b58887853e4a7d94d488b`, card `apache-2.0` over a `cc-by-nc-4.0` base. It loads in `f5-tts-mlx` unchanged and is intelligible (WER 0.08), at median RTF 1.12 and first audio 2156 ms. PyTorch MPS at 16 steps with the same checkpoint: RTF 0.70, first audio 1143 ms, WER 0.10. Not shipped, no speed gain.
- Not run: Windows, Linux, CUDA, x86 CPU.

**Decision.**

- RTF below 0.5 with first audio below 1.5 s is not met on CPU, and only the first-audio half is met on Apple GPU. F5-TTS is therefore a "slower, more expressive" option, not a live-turn engine. The measured wait is `F5_MEASURED_FIRST_AUDIO_MS` and appears in the consent text through `F5_WAIT_NOTE`.
- Provider id `f5-tts`. Off by default. It never replaces Kokoro as the default or the fallback. The desktop host and the CLI live runtime now register it, and the settings voice picker lists it. It is never the default voice: the saved speech preference must name it. Live narration then puts it first and keeps the Kokoro entry behind it, so a campaign that picks it falls back to Kokoro when it is not installed, not healthy or fails. The CLI reads the choice from `desktop-preferences.json` in the data directory. `voicesFor('pt-BR')` still returns Kokoro.
- The default is 16 steps (`F5_NFE_STEP`), half of F5's own default. The WER did not change in the spike. The quality cost is unknown until someone listens. The 32-step samples are kept for comparison.
- The PyTorch route is the shipped route on every platform. The service picks CUDA, then MPS, then CPU.
- MLX is not shipped. A v1 pt-BR fine-tune now makes it work, but it is slower than PyTorch MPS at the quality that is intelligible. Revisit if `f5-tts-mlx` gains a cheaper solver setting or quantised v1 pt-BR weights appear.

**Voices.** Four named reference voices, two female and two male (`f5-pt-f1`, `f5-pt-f2`, `f5-pt-m1`, `f5-pt-m2`), cut from Google FLEURS `pt_br` clips (card: `cc-by-4.0`, anonymous volunteers). Each has gender, age, timbre words (in `VOICE_CATALOG`), source URL, sha256 and attribution (`f5-voices.ts`). Age is `adult` for all four and is unverified, because FLEURS has no age field. Timbre words follow measured pitch, not listening. The FLoRes sentence licence and per-speaker consent were not checked. No emotion reference clips exist, so delivery maps to speed only.

**Provider design.** Same shape as Chatterbox: `f5-tts-engine.ts`, `f5-tts-install.ts`, `f5-tts-service.py`, shared process code in `local-service-engine.ts`. The install steps shared by Chatterbox and F5 moved to `python-service-install.ts`, and `chatterbox-install.ts` now uses it.

- The service binds `127.0.0.1` on a random port, needs a bearer token, checks body size, text length, voice allowlist and speed range, and runs with `HF_HUB_OFFLINE=1`.
- The installer needs a `ModelConsent` that matches the offer (source with licences, plus bytes). It writes a manifest from the TS constants, so revisions, files, voices and reference text have one source. It downloads pinned revisions, streams the two FLEURS archives with a read cap and keeps only the four clips, then hashes every file with SHA-256 and deletes a mismatch.
- Attribution strings are in `F5_ATTRIBUTIONS`. The repo has no Settings > About voices screen for any provider yet, so nothing is surfaced.
- Not built, as for Chatterbox: composition-root wiring, a settings entry and an install action. `status().supported` is true on darwin, linux and win32.

**Still open.** Chatterbox is registered on all platforms; Windows, Linux, CUDA and CPU timings are not measured. Listening test and age labels. A run on Windows, Linux and CUDA. Digit expansion (the model card asks for numbers as words). An A/B listening test of the Tharyck v1 checkpoint against firstpixel on the PyTorch route. Whether the Chatterbox pt-BR pack or its MLX and CoreML ports beat F5 on speed (rpg-cm63.47 follow-up, still unmeasured).

## Amendment 2 (2026-11-06, rpg-cm63.47 AC4): cross-platform route and measured numbers

**Route.** The cross-platform route for Chatterbox Multilingual is PyTorch (`torch` 2.6.0, `chatterbox-tts` 0.1.7) on CUDA or CPU. MPS is the Apple Silicon fast path. MLX is not part of the route. Kokoro pt-BR on `mlx-audio` is Apple-only (ADR 0019 Amendment 1). Its cross-platform route is ONNX on CPU (`kokoro-onnx-engine.ts`, `docs/voice/spike-results.md`, rpg-cm63.53).

**Measured** (Apple M3 Max, 64 GB, pt-BR narration, npc-warning and emotional, full tables in `docs/voice/spike-results.md`; the machine was shared, so CPU rows are noisy):

| Route | Median first audio | Median RTF | Peak footprint |
|---|---|---|---|
| Kokoro `pf_dora`, mlx-audio, MLX | 57 ms | 0.040 | 4294 MiB |
| Chatterbox, MPS | 5069 ms | 2.15 | 16355 MiB |
| Chatterbox, PyTorch CPU (latest run per passage) | 12523 ms | 3.36 | 5135 MiB |

- Chatterbox on CPU, all five runs: RTF 2.93 to 4.61, first audio 8.8 to 32.6 s, peak footprint 4810 to 5300 MiB, peak RSS 6.7 GiB. Weights are 3.0 GiB on disk.
- Median RTF on CPU is about 1.6 times the MPS median (up to 2.1 times per passage). CPU uses about a third of the peak footprint (about 5 GiB against up to 16 GiB).

**Verdict against RTF below 0.5 and first audio below 1.5 s.**

- Kokoro on MLX passes both. Kokoro on ONNX CPU passes both (RTF 0.125, first audio 271 ms, from rpg-cm63.53).
- Chatterbox fails both on every measured device. MPS is 4 times over on RTF and 3.4 times over on first audio. CPU is 6 to 9 times over on RTF and 6 to 22 times over on first audio.
- So Chatterbox stays opt-in and never the default or the fallback. It suits prerendered scene openings, not live turns. The cross-platform route is named and measured, and it is usable only as a slow, non-live option.

**Code state.**

- Since rpg-cm63.51, `chatterbox-install.ts` offers the install on macOS, Windows and Linux and `chatterbox-service.py` picks CUDA, then MPS, then CPU. Only the CPU and MPS timings above are measured.
- This amendment changes no product code.

**Not run.**

- CUDA, Windows, Linux, x86 CPU.
- The Chatterbox MLX and CoreML ports and the single-language pt-BR pack. They are still unmeasured and could change the speed verdict.
- Whisper word error rate and listening (rpg-cm63.61).
- The provider and service path with real weights. Only the bench script ran.
- The `innkeeper` passage.
