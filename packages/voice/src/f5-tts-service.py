import hmac
import io
import json
import os
import re
import signal
import sys
import tarfile
import threading
import time
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

DEVICES = ("cuda", "mps", "cpu")
MODEL_NAME = "F5TTS_Base"
WARMUP_TEXT = "olá."
MIN_SPEED = 0.5
MAX_SPEED = 2
HOST = "127.0.0.1"
ANY_FREE_PORT = 0
TOKEN_ENV = "RPG_F5_TOKEN"
MODEL_DIR_ENV = "RPG_F5_MODEL_DIR"
MANIFEST_ENV = "RPG_F5_MANIFEST"
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
ARCHIVE_URL_PREFIX = "https://huggingface.co/"
READ_CHUNK_BYTES = 64 * 1024
NUMBER_LANGUAGE = "pt_BR"
DECIMAL_WORD = "vírgula"
NEGATIVE_WORD = "menos"
FEMININE_MARK = "ª"
NUMBER_PATTERN = re.compile(
    r"(?P<sign>(?<!\w)-)?"
    r"(?:(?P<grouped>\d{1,3}(?:\.\d{3})+)(?!\d)(?:,(?P<grouped_fraction>\d+))?"
    r"|(?P<whole>\d+)(?:[.,](?P<fraction>\d+))?)"
    r"(?P<ordinal>[ºª])?"
)
THOUSANDS_SEPARATOR = "."
MASCULINE_ENDING = re.compile(r"o\b")
CONVERSION_ERRORS = (ImportError, KeyError, OverflowError, ValueError)


def model_dir():
    return Path(os.environ[MODEL_DIR_ENV])


def manifest():
    with open(os.environ[MANIFEST_ENV], encoding="utf-8") as source:
        return json.load(source)


class LimitedStream:
    def __init__(self, source, max_bytes):
        self.source = source
        self.max_bytes = max_bytes
        self.read_bytes = 0

    def read(self, size=-1):
        data = self.source.read(READ_CHUNK_BYTES if size is None or size < 0 else size)
        self.read_bytes += len(data)
        if self.read_bytes > self.max_bytes:
            raise ValueError("archive read limit exceeded")
        return data


def extract_members(source, members, max_bytes, target_dir):
    wanted = {entry["member"]: entry["target"] for entry in members}
    stream = LimitedStream(source, max_bytes)
    with tarfile.open(fileobj=stream, mode="r|gz") as archive:
        for info in archive:
            target = wanted.get(info.name)
            if target is None or not info.isfile():
                continue
            path = Path(target_dir) / target
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(archive.extractfile(info).read())
            del wanted[info.name]
            if not wanted:
                return
    raise ValueError("archive is missing " + ", ".join(sorted(wanted)))


def download():
    from huggingface_hub import hf_hub_download

    plan = manifest()
    for item in plan["downloads"]:
        hf_hub_download(
            item["repo"],
            item["file"],
            revision=item["revision"],
            local_dir=model_dir() / item["dir"],
        )
    for archive in plan["archives"]:
        if not archive["url"].startswith(ARCHIVE_URL_PREFIX):
            raise ValueError("unexpected archive host")
        with urllib.request.urlopen(archive["url"]) as response:
            extract_members(response, archive["members"], archive["maxBytes"], model_dir())


def pick_device():
    import torch

    if torch.cuda.is_available():
        return DEVICES[0]
    return DEVICES[1] if torch.backends.mps.is_available() else DEVICES[2]


def expand_digits(text, to_words, to_ordinal=None):
    ordinal_words = to_ordinal or to_words

    def spell(match):
        token = match.group()
        try:
            words = spoken(match)
        except CONVERSION_ERRORS:
            return token
        if not words:
            return token
        before = text[match.start() - 1] if match.start() else ""
        after = text[match.end()] if match.end() < len(text) else ""
        return (" " if before.isalpha() else "") + words + (" " if after.isalpha() else "")

    def spoken(match):
        grouped = match["grouped"]
        whole = int(grouped.replace(THOUSANDS_SEPARATOR, "")) if grouped else int(match["whole"])
        fraction = match["grouped_fraction"] or match["fraction"]
        if match["ordinal"]:
            if fraction:
                return None
            words = ordinal_words(whole)
            if match["ordinal"] == FEMININE_MARK:
                words = MASCULINE_ENDING.sub("a", words)
        elif fraction:
            spelled = " ".join(to_words(int(digit)) for digit in fraction) if fraction.startswith("0") else to_words(int(fraction))
            words = f"{to_words(whole)} {DECIMAL_WORD} {spelled}"
        else:
            words = to_words(whole)
        return f"{NEGATIVE_WORD} {words}" if match["sign"] else words

    return NUMBER_PATTERN.sub(spell, text)


def number_words(value):
    from num2words import num2words

    return num2words(value, lang=NUMBER_LANGUAGE)


def ordinal_words(value):
    from num2words import num2words

    return num2words(value, lang=NUMBER_LANGUAGE, to="ordinal")


class Model:
    def __init__(self, voices):
        from f5_tts.api import F5TTS

        files = manifest()["model"]
        root = model_dir()
        self.voices = voices
        self.nfe_step = files["nfeStep"]
        self.engine = F5TTS(
            model=MODEL_NAME,
            ckpt_file=str(root / files["checkpoint"]),
            vocab_file=str(root / files["vocab"]),
            vocoder_local_path=str(root / files["vocoder"]),
            device=pick_device(),
        )
        self.sample_rate = self.engine.target_sample_rate

    def render(self, text, voice, speed):
        import numpy as np

        entry = self.voices[voice]
        wav, _, _ = self.engine.infer(
            str(model_dir() / entry["clip"]),
            entry["refText"],
            expand_digits(text, number_words, ordinal_words).lower(),
            speed=speed,
            nfe_step=self.nfe_step,
            show_info=lambda *_: None,
            progress=None,
        )
        pcm = (np.clip(wav, -1, 1) * PCM_MAX).astype(np.int16)
        out = io.BytesIO()
        with wave.open(out, "wb") as target:
            target.setnchannels(MONO)
            target.setsampwidth(PCM_SAMPLE_WIDTH)
            target.setframerate(self.sample_rate)
            target.writeframes(pcm.tobytes())
        return out.getvalue()


def load():
    voices = {entry["id"]: entry for entry in manifest()["voices"]}
    model = Model(voices)
    first = next(iter(voices))
    model.render(WARMUP_TEXT, first, 1)
    return model


def in_range(value, low, high):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and low <= value <= high


def parse(body, voices):
    request = json.loads(body)
    text, voice, speed = request.get("text"), request.get("voice"), request.get("speed")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
        return None
    if voice not in voices:
        return None
    if not in_range(speed, MIN_SPEED, MAX_SPEED):
        return None
    return text, voice, float(speed)


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
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return self.reply(HTTP_BAD_REQUEST)
            if length < 0:
                return self.reply(HTTP_BAD_REQUEST)
            if length > MAX_BODY_BYTES:
                return self.reply(HTTP_TOO_LARGE)
            try:
                parsed = parse(self.rfile.read(length), model.voices)
            except (ValueError, AttributeError):
                parsed = None
            if parsed is None:
                return self.reply(HTTP_BAD_REQUEST)
            try:
                audio = model.render(*parsed)
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
