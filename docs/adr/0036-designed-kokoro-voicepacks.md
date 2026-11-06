# ADR 0036 — Designed pt-BR Kokoro voicepacks

**Status:** Accepted (rpg-cm63.63). **Decision:** Ship four Kokoro style tensors (`pf_luiza`, `pf_beatriz`, `pm_davi`, `pm_henrique`) found offline by a seeded search against human reference clips. They load on the ONNX and MLX routes like any other voice.

**Context:** A Kokoro voice is one style tensor (510 rows x 256 float32). A tensor found offline plays at normal Kokoro speed (rpg-cm63.45 blends only mix two existing tensors). Chatterbox and F5 sound better but cost seconds per sentence.

**Decision details:**
- Search: `scripts/voice-spike/design-voicepacks.ts`. A candidate is `sum(w_k * base_k) + delta`. The `base_k` are the local Kokoro voices of the target gender, `w` is on the simplex and `delta` is one 256-value vector added to every row (clamped to half the base RMS). Steps: score every base, hill-climb the weights, then a (1+1) evolution strategy on `delta`. The generator is seeded (`seededRandom`), so a run repeats. No new dependency.
- Score: mean cosine between the Wespeaker embedding of the synthesized sentence and the embedding of the reference clips, over two probe sentences. The reported score uses two other sentences. `otherTargetsMax` is the best score against the other three targets, so a voice that only sounds generic shows up.
- Features: `speaker-embedding.ts` has resampling, Kaldi-style 80-bin fbank and mean normalisation in plain TypeScript. The ONNX runtime comes from `defaultPorts().loadRuntime()`.
- Packs: `packages/voice/voicepacks/<id>.bin` (raw float32, same layout as a base voice file) and `packages/voice/src/designed-manifest.ts`. Four files of 522,240 bytes, about 2 MB. They are our own output and small, so they live in git and are not part of the consented download.
- Loading: `designed-voices.ts` reads the manifest. The ONNX engine reads a designed id from the pack file instead of the model folder. The MLX service gets `RPG_VOICEPACK_DIR`, accepts `p[fm]_[a-z]+` ids that have a `.bin` there, and loads it as a `(510, 1, 256)` tensor. No other path reaches the file system.
- Provider: a designed id is sent to the engine under its own id with no blend. An engine without `blends` stays silent, so the next provider speaks. A per-character random blend never uses a designed voice, as a first or second voice.
- Listing: `MLX_KOKORO_CAPABILITIES.voices` and `VOICE_CATALOG` include the designed voices, with gender, ages, timbre and licence from the manifest.

**Results** (held-out score; best single base voice on the probe sentences; best other target):

| Voice | Gender | Age | Reference | Score | Best base | Other max |
|---|---|---|---|---|---|---|
| `pf_luiza` | female | young | FLEURS train clip (1) | 0.2377 | 0.0498 (`af_sarah`) | 0.2182 |
| `pf_beatriz` | female | adult | FLEURS train clip (1) | 0.3074 | 0.1461 (`bf_emma`) | 0.1833 |
| `pm_davi` | male | young | FLEURS dev speaker B (8 clips) | 0.3052 | 0.0664 (`pm_alex`) | 0.1781 |
| `pm_henrique` | male | adult | FLEURS dev speaker A (8 clips) | 0.2656 | 0.1999 (`am_liam`) | 0.1061 |

MLX and ONNX render each pack with the same voice: embedding cosine between the two renders is 0.95 to 0.96.

**Inputs and licences** (also in `packages/voice/src/designed-manifest.ts`):
- Reference clips: Google FLEURS pt_br, CC-BY-4.0, anonymous read-speech volunteers, revision `70bb2e84b976b7e960aa89f1c648e09c59f894dd`. Attribution is in the manifest. The clips stay outside git.
- Not used: the F5 renders, because the F5 weights are CC-BY-NC-4.0. The Chatterbox renders, because they are one voice.
- Similarity model: `Wespeaker/wespeaker-voxceleb-resnet34-LM`, CC-BY-4.0. Dev-time only, not shipped.
- Kokoro-82M ONNX model and base voices: Apache-2.0. The packs are marked Apache-2.0.

**Limits (owner listening is a separate bead):**
- Scores of 0.24 to 0.31 mean timbre transfer, not a clone. The packs do not reproduce the volunteers.
- Ages are declared tags: `young` for the higher-pitch reference and `adult` for the lower one, per gender. Reference pitch was the only evidence. No voice is tagged `old`. Timbre tags come from the base voice with the highest weight. None is verified by listening.
- `pm_henrique` is 80% `am_liam`, an English voice. Phonemes are pt-BR, but the accent is not checked.
- The first F5 references `f5-pt-m1` and `f5-pt-m2` were the same speaker (embedding cosine 0.86, same cluster over all 386 FLEURS dev clips). Fixed in bead rpg-cm63.65: `f5-pt-m2` is now a clip from another dev speaker, cosine 0.185 to `f5-pt-m1`. Clustering estimates three dev speakers, and `f5-pt-m1` has the lower pitch.
- Packaging: `packages/**` goes into `app.asar`, which the ONNX engine reads in the Electron process. The MLX engine copies the packs to `<engine dir>/voicepacks` before it starts the service, like the service source, because Python cannot read inside an asar. A packaged run is not tested.

**Run** (dev machine, needs the ONNX model and base voices under `~/rpg-voice-samples/blends/onnx-model`):

```
curl -L -o ~/rpg-voice-samples/speaker-model/voxceleb_resnet34_LM.onnx https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM/resolve/main/voxceleb_resnet34_LM.onnx
node scripts/voice-spike/design-voicepacks.ts --weight-steps 60 --delta-steps 150
node scripts/voice-spike/design-voicepacks.ts --only pm_davi
```

Reference clips: `~/rpg-voice-samples/f5/reference-clips/*.wav` and the FLEURS dev archive extracted to `~/rpg-voice-samples/fleurs-dev/extract/dev`. Samples go to `~/rpg-voice-samples/kokoro-designed`. A full run takes about 30 minutes on CPU.
