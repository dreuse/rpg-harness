# ADR 0035 — Named pt-BR voice blends; Piper deferred

**Status:** Accepted (rpg-cm63.45). **Decision:** Ship six named Kokoro voice blends on top of `pf_dora`, `pm_alex` and `pm_santa`. Defer the Piper provider.

**Context:** Kokoro has three pt-BR voices. A campaign with more speaking characters repeated voices. The goal is at least four female and four male voices, each tagged for NPC auto-assignment (rpg-cm63.44).

**Decision details:**
- List: `PT_BR_BLENDS` in `packages/voice/src/pt-br-blends.ts`. Each entry has an id, a pt-BR first voice, a second Kokoro voice of the same gender, a fixed weight for the second voice, and gender, age and timbre tags. Result: 4 female (`pf_dora`, `pf_clara`, `pf_helena`, `pf_marta`) and 5 male (`pm_alex`, `pm_santa`, `pm_bruno`, `pm_caio`, `pm_otavio`) voices on `kokoro-mlx` and `kokoro-onnx`.
- Deterministic: the style vector is `(1 - weight) * first + weight * second`. The weights are constants in the list. Nothing is random.
- Phonemes: the first voice is the pt-BR voice, so espeak pt-BR phonemes and its voice language stay.
- Provider: `createKokoroProvider` resolves a blend id with `namedBlendOf`, asks the engine for the first voice plus the blend, and reports the blend id on the chunk. An engine with `blends` unset yields nothing for a blend id, so the next fallback provider speaks.
- Per-character random blend (`voiceBlendFor`) never uses a blend id as first or second voice. A named blend ignores it.
- Engines: the mlx-audio service accepts partner voices (`BLEND_PARTNERS`) as the second voice only, never as the primary voice. The ONNX engine now mixes the two style rows itself and sets `blends`.
- Installed means present: `mlxAudioInstalled` and the ONNX file list now include the six partner voice files (`af_bella`, `af_sarah`, `am_adam`, `am_liam`, `am_onyx`, `bf_emma`). An older pt-BR install that lacks them reports not installed until the download runs again. The download skips files that are already present. The offer size changes by about 3 MiB.
- Licence: every blend carries `licence: 'Apache-2.0'` (the Kokoro-82M model and voice licence) in `VOICE_CATALOG`.
- Tags: age and timbre come from the tags of the two source voices. They are not verified by a listening test. No old female voice exists because no Kokoro female voice reads as old.

**Route (b), Piper:** deferred.
- Voices: `rhasspy/piper-voices` has `pt_BR` `faber`, `cadu`, `jeff` and `edresson`. The model cards of `faber`, `cadu` and `jeff` list the dataset licence as CC0 and say the models are fine-tuned from the US English `lessac` voice. The licence of that parent voice has not been checked, so redistribution is not cleared.
- Coverage: the checked voices are single-speaker male voices, so they do not help the female target.
- Cost: a Piper provider needs a new runtime, a phonemizer with its own licence and the consented download flow (size, source, checksum) from rpg-cm63.53. That is a separate unit of work.
- Revisit when a pt-BR female Piper voice with a cleared licence exists, or when the blends do not give enough variety in a listening test.
