import hmac
import io
import json
import os
import shutil
import signal
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

MODEL = "mlx-community/Kokoro-82M-bf16"
REVISION = "a71e4d38b236d968966a2002c4c895dbd12b1c3c"
VOICES = {"pf_dora", "pm_alex", "pm_santa"}
BLEND_PARTNERS = {"af_bella", "af_sarah", "am_adam", "am_liam", "am_onyx", "bf_emma"}
MODEL_FILES = [
    "config.json",
    "kokoro-v1_0.safetensors",
    *(f"voices/{voice}.safetensors" for voice in sorted(VOICES | BLEND_PARTNERS)),
]
WARMUP_VOICE = "pf_dora"
WARMUP_TEXT = "Olá."
HOST = "127.0.0.1"
ANY_FREE_PORT = 0
TOKEN_ENV = "RPG_MLX_AUDIO_TOKEN"
BEARER = "Bearer "
SYNTHESIZE_PATH = "/synthesize"
MAX_BODY_BYTES = 16 * 1024
MAX_TEXT_CHARS = 2000
BLEND_VOICE = "blend"
MIN_SPEED = 0.5
MAX_SPEED = 2.0
NO_SPLIT = r"\n+"
PCM_MAX = 32767
PCM_SAMPLE_WIDTH = 2
MONO = 1
ESPEAK_DATA_COPY = "espeak-ng-data"
SERVE = "serve"
DOWNLOAD = "download"
PARENT_POLL_SECONDS = 1.0
HTTP_OK = 200
HTTP_BAD_REQUEST = 400
HTTP_UNAUTHORIZED = 401
HTTP_NOT_FOUND = 404
HTTP_TOO_LARGE = 413
HTTP_SERVER_ERROR = 500


def download():
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL, revision=REVISION, allow_patterns=MODEL_FILES)


def short_espeak_data():
    import espeakng_loader
    import misaki.espeak
    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    root = tempfile.mkdtemp()
    shutil.copytree(espeakng_loader.get_data_path(), os.path.join(root, ESPEAK_DATA_COPY))
    EspeakWrapper.set_data_path(os.path.join(root, ESPEAK_DATA_COPY))
    return root


def load():
    from mlx_audio.tts.utils import load_model

    model = load_model(MODEL, revision=REVISION, allow_patterns=MODEL_FILES)
    synthesize(model, WARMUP_TEXT, WARMUP_VOICE, 1.0)
    return model


def blended_parts(model, text, voice, speed, blend):
    first, second, weight = blend
    pipeline = model._get_pipeline(voice[0])
    pipeline.voices = {}
    pipeline.voices[BLEND_VOICE] = (1 - weight) * pipeline.load_single_voice(first) + weight * pipeline.load_single_voice(second)
    for _, _, audio in pipeline(text, voice=BLEND_VOICE, speed=speed, split_pattern=NO_SPLIT):
        yield audio, model.config.sample_rate


def single_parts(model, text, voice, speed):
    for result in model.generate(text=text, voice=voice, speed=speed, lang_code=voice[0], split_pattern=NO_SPLIT):
        yield result.audio, result.sample_rate


def synthesize(model, text, voice, speed, blend=None):
    import numpy as np

    parts = []
    sample_rate = 0
    source = single_parts(model, text, voice, speed) if blend is None else blended_parts(model, text, voice, speed, blend)
    for audio, sample_rate in source:
        parts.append(np.array(audio))
    pcm = (np.clip(np.concatenate(parts), -1, 1) * PCM_MAX).astype(np.int16)
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(MONO)
        wav.setsampwidth(PCM_SAMPLE_WIDTH)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())
    return out.getvalue()


def parse_blend(blend, voice):
    if blend is None:
        return None
    if not isinstance(blend, dict):
        raise ValueError("blend")
    first, second, weight = blend.get("first"), blend.get("second"), blend.get("weight")
    if first != voice or second not in VOICES | BLEND_PARTNERS or second == first:
        raise ValueError("blend")
    if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not 0 < weight < 1:
        raise ValueError("blend")
    return first, second, float(weight)


def parse(body):
    request = json.loads(body)
    text, voice, speed = request.get("text"), request.get("voice"), request.get("speed")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
        return None
    if voice not in VOICES:
        return None
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not MIN_SPEED <= speed <= MAX_SPEED:
        return None
    return text, voice, float(speed), parse_blend(request.get("blend"), voice)


def handler(model, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, body=b"", content_type="text/plain"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path != SYNTHESIZE_PATH:
                return self.reply(HTTP_NOT_FOUND)
            if not hmac.compare_digest(self.headers.get("Authorization", ""), BEARER + token):
                return self.reply(HTTP_UNAUTHORIZED)
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY_BYTES:
                return self.reply(HTTP_TOO_LARGE)
            try:
                parsed = parse(self.rfile.read(length))
            except (ValueError, AttributeError):
                parsed = None
            if parsed is None:
                return self.reply(HTTP_BAD_REQUEST)
            try:
                audio = synthesize(model, *parsed)
            except Exception:
                return self.reply(HTTP_SERVER_ERROR)
            return self.reply(HTTP_OK, audio, "audio/wav")

    return Handler


def exit_when_orphaned(parent, stop, poll_seconds=PARENT_POLL_SECONDS, current_parent=os.getppid):
    while current_parent() == parent:
        time.sleep(poll_seconds)
    stop()


def serve():
    token = os.environ.get(TOKEN_ENV, "")
    if not token:
        sys.exit(f"{TOKEN_ENV} is not set")
    ready_out = sys.stdout
    sys.stdout = sys.stderr
    espeak_root = short_espeak_data()

    def stop(*_):
        shutil.rmtree(espeak_root, ignore_errors=True)
        os._exit(0)

    signal.signal(signal.SIGTERM, stop)
    threading.Thread(target=lambda: (sys.stdin.read(), stop()), daemon=True).start()
    threading.Thread(target=exit_when_orphaned, args=(os.getppid(), stop), daemon=True).start()
    server = HTTPServer((HOST, ANY_FREE_PORT), handler(load(), token))
    ready_out.write(f"READY {server.server_address[1]}\n")
    ready_out.flush()
    server.serve_forever()


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == DOWNLOAD:
        download()
    elif mode == SERVE:
        serve()
    else:
        sys.exit(f"usage: {SERVE} | {DOWNLOAD}")


if __name__ == "__main__":
    main()
