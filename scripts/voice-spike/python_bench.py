import gc
import json
import os
import re
import shutil
import sys
import tempfile
import time
import wave
from importlib.metadata import version
from pathlib import Path

import numpy as np

RESULT_TAG = "BENCH_RESULT "
SENTENCE_SPLIT = r"(?<=[.!?])\s+"
WARMUP_TEXT = "Hello."
MS_PER_SECOND = 1000
PCM_MAX = 32767
PCM_SAMPLE_WIDTH = 2
MONO = 1

MLX_MODEL = "mlx-community/Kokoro-82M-bf16"
MLX_LANG_CODES = {"en": "a", "pt-BR": "p"}
MLX_VOICES = {"en": "af_heart", "pt-BR": "pf_dora"}
ESPEAK_DATA_COPY = "espeak-ng-data"

CHATTERBOX_LANGUAGES = {"en": "en", "pt-BR": "pt"}
CHATTERBOX_DEVICE = "mps"
CHATTERBOX_DEFAULT_STYLE = {"exaggeration": 0.5, "cfg_weight": 0.5}
CHATTERBOX_EMOTIONAL_STYLE = {"exaggeration": 0.8, "cfg_weight": 0.3}


def elapsed_ms(start):
    return (time.perf_counter() - start) * MS_PER_SECOND


def write_wav(path, samples, sample_rate):
    pcm = (np.clip(samples, -1, 1) * PCM_MAX).astype(np.int16)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(MONO)
        out.setsampwidth(PCM_SAMPLE_WIDTH)
        out.setframerate(sample_rate)
        out.writeframes(pcm.tobytes())


class MlxKokoro:
    name = "mlx-audio"
    device = "mlx-gpu"
    packages = ["mlx-audio", "mlx", "misaki"]

    def load(self):
        import espeakng_loader
        import misaki.espeak
        from mlx_audio.tts.utils import load_model
        from phonemizer.backend.espeak.wrapper import EspeakWrapper

        data_copy = os.path.join(tempfile.mkdtemp(), ESPEAK_DATA_COPY)
        shutil.copytree(espeakng_loader.get_data_path(), data_copy)
        EspeakWrapper.set_data_path(data_copy)
        self.model = load_model(MLX_MODEL)

    def chunks(self, passage):
        for result in self.model.generate(
            text=passage["text"],
            voice=MLX_VOICES[passage["language"]],
            lang_code=MLX_LANG_CODES[passage["language"]],
            split_pattern=SENTENCE_SPLIT,
        ):
            yield np.array(result.audio), result.sample_rate

    def unload(self):
        import mlx.core as mx

        del self.model
        gc.collect()
        mx.clear_cache()


class Chatterbox:
    name = "chatterbox"
    device = CHATTERBOX_DEVICE
    packages = ["chatterbox-tts", "torch"]

    def load(self):
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        self.model = ChatterboxMultilingualTTS.from_pretrained(device=CHATTERBOX_DEVICE)

    def chunks(self, passage):
        style = CHATTERBOX_EMOTIONAL_STYLE if passage["kind"] == "emotional" else CHATTERBOX_DEFAULT_STYLE
        for sentence in re.split(SENTENCE_SPLIT, passage["text"]):
            wav = self.model.generate(sentence, language_id=CHATTERBOX_LANGUAGES[passage["language"]], **style)
            yield wav.squeeze(0).cpu().numpy(), self.model.sr

    def unload(self):
        import torch

        del self.model
        gc.collect()
        torch.mps.empty_cache()


ADAPTERS = {"mlx-audio": MlxKokoro, "chatterbox": Chatterbox}


def synthesize(adapter, passage, out_dir):
    start = time.perf_counter()
    first_audio_ms = None
    parts = []
    sample_rate = 0
    for samples, sample_rate in adapter.chunks(passage):
        if first_audio_ms is None:
            first_audio_ms = elapsed_ms(start)
        parts.append(samples)
    total_ms = elapsed_ms(start)
    audio = np.concatenate(parts)
    write_wav(out_dir / f"{passage['id']}.wav", audio, sample_rate)
    return {
        "passageId": passage["id"],
        "ok": True,
        "firstAudioMs": first_audio_ms,
        "totalMs": total_ms,
        "audioSeconds": len(audio) / sample_rate,
    }


def run(adapter, passages, out_dir):
    start = time.perf_counter()
    adapter.load()
    load_ms = elapsed_ms(start)
    start = time.perf_counter()
    list(adapter.chunks({"id": "warmup", "language": "en", "kind": "npc", "text": WARMUP_TEXT}))
    warmup_ms = elapsed_ms(start)
    results = []
    for passage in passages:
        try:
            results.append(synthesize(adapter, passage, out_dir))
        except Exception as error:
            results.append({"passageId": passage["id"], "ok": False, "error": f"{type(error).__name__}: {error}"})
    start = time.perf_counter()
    adapter.unload()
    return {
        "candidate": adapter.name,
        "versions": {package: version(package) for package in adapter.packages},
        "device": adapter.device,
        "loadMs": load_ms,
        "warmupMs": warmup_ms,
        "unloadMs": elapsed_ms(start),
        "results": results,
    }


def main():
    candidate, passages_path, out_dir = sys.argv[1:4]
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    passages = json.loads(Path(passages_path).read_text(encoding="utf-8"))
    print(RESULT_TAG + json.dumps(run(ADAPTERS[candidate](), passages, out)), flush=True)


main()
