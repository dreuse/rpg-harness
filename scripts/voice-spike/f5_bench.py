import json
import re
import sys
import time
import wave
from argparse import ArgumentParser
from importlib.metadata import version
from pathlib import Path

import numpy as np

RESULT_TAG = "BENCH_RESULT "
SENTENCE_SPLIT = r"(?<=[.!?])\s+"
WARMUP_TEXT = "olá."
MS_PER_SECOND = 1000
PCM_MAX = 32767
PCM_SAMPLE_WIDTH = 2
MONO = 1
MODEL_NAME = "F5TTS_Base"
DEFAULT_NFE_STEP = 32
PACKAGES = {"torch": ("f5-tts", "torch"), "mlx": ("f5-tts-mlx", "mlx")}
MLX_STEPS = 8
MLX_METHOD = "rk4"
MLX_CFG_STRENGTH = 2.0
MLX_SWAY_SAMPLING_COEF = -1.0
MLX_SAMPLE_RATE = 24000
MLX_HOP_LENGTH = 256


def elapsed_ms(start):
    return (time.perf_counter() - start) * MS_PER_SECOND


def write_wav(path, samples, sample_rate):
    pcm = (np.clip(samples, -1, 1) * PCM_MAX).astype(np.int16)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(MONO)
        out.setsampwidth(PCM_SAMPLE_WIDTH)
        out.setframerate(sample_rate)
        out.writeframes(pcm.tobytes())


def parse_args():
    parser = ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--ref-audio", required=True)
    parser.add_argument("--ref-text", required=True)
    parser.add_argument("--passages", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--backend", choices=("torch", "mlx"), default="torch")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threads", type=int, default=0)
    parser.add_argument("--nfe-step", type=int, default=DEFAULT_NFE_STEP)
    return parser.parse_args()


def load_mlx(args):
    import mlx.core as mx
    import f5_tts_mlx.cfm as cfm
    import numpy as np
    import soundfile as sf
    from f5_tts_mlx.generate import estimated_duration
    from f5_tts_mlx.utils import convert_char_to_pinyin

    model_dir = Path(args.model_dir)
    cfm.fetch_from_hub = lambda *_args, **_kwargs: model_dir
    normal = mx.random.normal
    mx.random.normal = lambda shape, **kwargs: normal(tuple(int(size) for size in shape), **kwargs)
    model = cfm.F5TTS.from_pretrained("local")
    audio = mx.array(sf.read(args.ref_audio)[0])

    def infer(text):
        frames = int(estimated_duration(audio, args.ref_text, text, 1.0) * MLX_SAMPLE_RATE / MLX_HOP_LENGTH)
        wave, _ = model.sample(
            mx.expand_dims(audio, axis=0),
            text=convert_char_to_pinyin([args.ref_text + " " + text]),
            duration=frames,
            steps=MLX_STEPS,
            method=MLX_METHOD,
            cfg_strength=MLX_CFG_STRENGTH,
            sway_sampling_coef=MLX_SWAY_SAMPLING_COEF,
        )
        wave = wave[audio.shape[0] :]
        mx.eval(wave)
        return np.array(wave), MLX_SAMPLE_RATE

    return infer


def load(args):
    if args.backend == "mlx":
        return load_mlx(args)
    import torch
    from f5_tts.api import F5TTS

    if args.threads:
        torch.set_num_threads(args.threads)
    model_dir = Path(args.model_dir)
    model = F5TTS(
        model=MODEL_NAME,
        ckpt_file=str(model_dir / "model_last.safetensors"),
        vocab_file=str(model_dir / "vocab.txt"),
        vocoder_local_path=str(model_dir),
        device=args.device,
    )

    def infer(text):
        wav, sample_rate, _ = model.infer(
            args.ref_audio, args.ref_text, text, nfe_step=args.nfe_step, show_info=lambda *_: None, progress=None
        )
        return wav, sample_rate

    return infer


def sentences(text):
    return re.split(SENTENCE_SPLIT, text.lower())


def run(args):
    start = time.perf_counter()
    generate = load(args)
    load_ms = elapsed_ms(start)
    start = time.perf_counter()
    generate(WARMUP_TEXT)
    warmup_ms = elapsed_ms(start)
    results = []
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for passage in json.loads(Path(args.passages).read_text(encoding="utf-8")):
        start = time.perf_counter()
        first_audio_ms = None
        parts = []
        for sentence in sentences(passage["text"]):
            wav, sample_rate = generate(sentence)
            if first_audio_ms is None:
                first_audio_ms = elapsed_ms(start)
            parts.append(wav)
        total_ms = elapsed_ms(start)
        audio = np.concatenate(parts)
        write_wav(out_dir / f"{passage['id']}.wav", audio, sample_rate)
        results.append(
            {
                "passageId": passage["id"],
                "firstAudioMs": first_audio_ms,
                "totalMs": total_ms,
                "audioSeconds": len(audio) / sample_rate,
            }
        )
    return {
        "backend": args.backend,
        "device": args.device,
        "threads": args.threads,
        "nfeStep": args.nfe_step,
        "versions": {name: version(name) for name in PACKAGES[args.backend]},
        "loadMs": load_ms,
        "warmupMs": warmup_ms,
        "results": results,
    }


if __name__ == "__main__":
    print(RESULT_TAG + json.dumps(run(parse_args())), flush=True)
