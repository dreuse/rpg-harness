import hmac
import io
import json
import os
import signal
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

MODEL = "ResembleAI/chatterbox"
REVISION = "5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18"
MODEL_FILES = [
    "ve.pt",
    "t3_mtl23ls_v2.safetensors",
    "s3gen.pt",
    "grapheme_mtl_merged_expanded_v1.json",
    "conds.pt",
]
VOICES = {"chatterbox-default"}
LANGUAGE_ID = "pt"
DEVICES = ("cuda", "mps", "cpu")
WARMUP_TEXT = "Olá."
DEFAULT_EXAGGERATION = 0.5
DEFAULT_CFG_WEIGHT = 0.5
MIN_EXAGGERATION = 0.25
MAX_EXAGGERATION = 2.0
MIN_CFG_WEIGHT = 0.0
MAX_CFG_WEIGHT = 1.0
HOST = "127.0.0.1"
ANY_FREE_PORT = 0
TOKEN_ENV = "RPG_CHATTERBOX_TOKEN"
MODEL_DIR_ENV = "RPG_CHATTERBOX_MODEL_DIR"
BEARER = "Bearer "
SYNTHESIZE_PATH = "/synthesize"
MAX_BODY_BYTES = 16 * 1024
MAX_TEXT_CHARS = 2000
PCM_MAX = 32767
PCM_SAMPLE_WIDTH = 2
MONO = 1
SERVE = "serve"
DOWNLOAD = "download"
PARENT_POLL_SECONDS = 1.0
HTTP_OK = 200
HTTP_BAD_REQUEST = 400
HTTP_UNAUTHORIZED = 401
HTTP_NOT_FOUND = 404
HTTP_TOO_LARGE = 413
HTTP_SERVER_ERROR = 500


def model_dir():
    return os.environ[MODEL_DIR_ENV]


def download():
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL, revision=REVISION, allow_patterns=MODEL_FILES, local_dir=model_dir())


def pick_device():
    import torch

    if torch.cuda.is_available():
        return DEVICES[0]
    return DEVICES[1] if torch.backends.mps.is_available() else DEVICES[2]


def load():
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    model = ChatterboxMultilingualTTS.from_local(model_dir(), pick_device())
    synthesize(model, WARMUP_TEXT, DEFAULT_EXAGGERATION, DEFAULT_CFG_WEIGHT)
    return model


def synthesize(model, text, exaggeration, cfg_weight):
    import numpy as np

    wav = model.generate(text, language_id=LANGUAGE_ID, exaggeration=exaggeration, cfg_weight=cfg_weight)
    pcm = (np.clip(wav.squeeze(0).cpu().numpy(), -1, 1) * PCM_MAX).astype(np.int16)
    out = io.BytesIO()
    with wave.open(out, "wb") as target:
        target.setnchannels(MONO)
        target.setsampwidth(PCM_SAMPLE_WIDTH)
        target.setframerate(model.sr)
        target.writeframes(pcm.tobytes())
    return out.getvalue()


def in_range(value, low, high):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and low <= value <= high


def parse(body):
    request = json.loads(body)
    text, voice = request.get("text"), request.get("voice")
    exaggeration, cfg_weight = request.get("exaggeration"), request.get("cfg_weight")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
        return None
    if voice not in VOICES:
        return None
    if not in_range(exaggeration, MIN_EXAGGERATION, MAX_EXAGGERATION):
        return None
    if not in_range(cfg_weight, MIN_CFG_WEIGHT, MAX_CFG_WEIGHT):
        return None
    return text, float(exaggeration), float(cfg_weight)


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

    def stop(*_):
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
