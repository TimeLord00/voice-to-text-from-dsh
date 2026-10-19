"""Minimal client for the local voice-to-text HTTP API (standard library only).

Start the server first:

    node .\\bin\\vtt.mjs serve --port 8791

Then (on Windows use ``py`` when ``python`` is only the Microsoft Store alias):

    py examples\\python_client.py meeting.wav          # transcribe a file
    py examples\\python_client.py --health             # readiness check
    py examples\\python_client.py --dictate            # record 4s, print what was heard
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = "http://127.0.0.1:8791"


def call(path: str, body: bytes | None = None, token: str | None = None, content_type: str | None = None) -> dict:
    """POST (or GET, when body is None) to the API and return the decoded JSON body."""
    request = urllib.request.Request(f"{BASE}{path}", data=body, method="POST" if body is not None else "GET")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    if content_type:
        request.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace").strip()
        raise SystemExit(f"{path} failed: HTTP {error.code} {detail}") from error
    except urllib.error.URLError as error:
        raise SystemExit(f"cannot reach {BASE}: {error.reason}\nis `vtt serve` running?") from error


def transcribe_file(path: str, language: str, token: str | None) -> None:
    """Send a WAV file as a raw body."""
    with open(path, "rb") as handle:
        audio = handle.read()
    started = time.perf_counter()
    result = call(f"/transcribe?language={language}", body=audio, token=token, content_type="audio/wav")
    elapsed = (time.perf_counter() - started) * 1000
    print(result["text"])
    print(f"--- {result['seconds']}s audio, inference {result['inferenceMs']}ms, round trip {elapsed:.0f}ms", file=sys.stderr)


def transcribe_multipart(path: str, language: str, token: str | None) -> None:
    """Send a WAV file the way OpenAI-compatible clients do: multipart/form-data with a `file` field."""
    boundary = uuid.uuid4().hex
    with open(path, "rb") as handle:
        audio = handle.read()
    parts = [
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n',
        b"Content-Type: audio/wav\r\n\r\n",
        audio,
        b"\r\n",
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="language"\r\n\r\n',
        language.encode(),
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    result = call("/v1/audio/transcriptions", body=b"".join(parts), token=token, content_type=f"multipart/form-data; boundary={boundary}")
    print(result["text"])


def dictate(seconds: float, token: str | None) -> None:
    """Drive the microphone through the dictation API."""
    call("/dictate", body=b"{}", token=token)
    print(f"recording for {seconds:g}s ...", file=sys.stderr)
    time.sleep(seconds)
    result = call("/dictate/stop", body=b"{}", token=token)
    print(result.get("text", ""))
    print(f"--- {result.get('audioSeconds', 0):.2f}s audio, inference {result.get('inferenceSeconds', 0) * 1000:.0f}ms", file=sys.stderr)


def main() -> int:
    """Parse arguments and run the requested operation."""
    parser = argparse.ArgumentParser(description="client for the local voice-to-text HTTP API")
    parser.add_argument("wav", nargs="?", help="WAV file to transcribe")
    parser.add_argument("--language", default="zh", choices=["auto", "zh", "en", "yue", "ja", "ko"])
    parser.add_argument("--token", default=None, help="bearer token, when the server was started with --token")
    parser.add_argument("--multipart", action="store_true", help="use the OpenAI-compatible endpoint")
    parser.add_argument("--dictate", action="store_true", help="record from the microphone instead of a file")
    parser.add_argument("--seconds", type=float, default=4.0, help="microphone recording length for --dictate")
    parser.add_argument("--health", action="store_true", help="print server readiness and exit")
    args = parser.parse_args()

    if args.health:
        print(json.dumps(call("/health", token=args.token), indent=2, ensure_ascii=False))
        return 0
    if args.dictate:
        dictate(args.seconds, args.token)
        return 0
    if not args.wav:
        parser.error("give a WAV file, or use --dictate / --health")
    if args.multipart:
        transcribe_multipart(args.wav, args.language, args.token)
    else:
        transcribe_file(args.wav, args.language, args.token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
