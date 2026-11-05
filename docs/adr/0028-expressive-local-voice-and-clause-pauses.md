# ADR 0028 — Clause pauses on Kokoro and an optional expressive local engine (rpg-cm63.47)

**Status:** Accepted. **Decision:** (1) Kokoro speech splits at clause marks and appends a named silence after each piece, so commas, semicolons, colons and dashes are audible. (2) Chatterbox Multilingual is added as an optional local provider, id `chatterbox`, for Brazilian Portuguese (pt-BR) with emotion control. It is off by default, downloads only with consent, and never replaces Kokoro as the default or the fallback.

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
