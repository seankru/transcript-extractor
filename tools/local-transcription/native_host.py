"""Windows native-messaging host and durable local transcription worker."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
import uuid

HOST_NAME = "com.transcript_extractor.local"
ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "config.json"
MAX_MESSAGE = 64 * 1024
ALLOWED_DOMAINS = (
    "substack.com", "substackcdn.com", "mux.com", "youtube.com",
    "youtube-nocookie.com", "googlevideo.com", "sharepoint.com",
    "sharepoint-df.com", "microsoftstream.com",
    "open.spotify.com",
)


def validate_url(value: str) -> str:
    if not isinstance(value, str) or len(value) > 16000:
        raise ValueError("Invalid media URL.")
    parsed = urlsplit(value)
    host = (parsed.hostname or "").lower()
    if (parsed.scheme != "https" or parsed.username or parsed.password or
            parsed.port not in (None, 443) or not any(
                host == domain or host.endswith("." + domain) for domain in ALLOWED_DOMAINS)):
        raise ValueError("Media must use HTTPS on a supported video provider.")
    return value


def job_id(value: str) -> str:
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("Invalid job ID.")
    return value


def safe_name(value: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value)).strip(" .")[:140]
    name = re.sub(r"\.(md|vtt|txt)$", "", name, flags=re.I).strip(" .")
    if not name or re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", name, re.I):
        name = "transcript"
    return name


def write_json(path: Path, data: dict) -> None:
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     suffix=".tmp", delete=False) as stream:
        json.dump(data, stream)
        temporary = Path(stream.name)
    os.replace(temporary, path)


def read_message(stream) -> dict | None:
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise ValueError("Incomplete native-message header.")
    length = struct.unpack("<I", header)[0]
    if not 0 < length <= MAX_MESSAGE:
        raise ValueError("Native message is too large.")
    payload = stream.read(length)
    if len(payload) != length:
        raise ValueError("Incomplete native message.")
    message = json.loads(payload)
    if not isinstance(message, dict):
        raise ValueError("Native message must be an object.")
    return message


def send_message(stream, data: dict) -> None:
    payload = json.dumps(data).encode("utf-8")
    stream.write(struct.pack("<I", len(payload)) + payload)
    stream.flush()


def clean_error(error: Exception) -> str:
    return re.sub(r"https?://[^\s<>\"']+", "[media URL]", str(error))[-1800:]


def public_status(directory: Path, origin: str) -> dict:
    request = json.loads((directory / "request.json").read_text(encoding="utf-8"))
    if request["origin"] != origin:
        raise ValueError("This job belongs to another extension.")
    status = json.loads((directory / "status.json").read_text(encoding="utf-8"))
    worker = directory / "worker.json"
    if status["state"] not in ("complete", "failed") and worker.exists():
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        pid = json.loads(worker.read_text(encoding="utf-8"))["pid"]
        process = kernel.OpenProcess(0x1000, False, pid)
        code = wintypes.DWORD()
        try:
            running = bool(process and kernel.GetExitCodeProcess(process, ctypes.byref(code)) and code.value == 259)
        finally:
            if process:
                kernel.CloseHandle(process)
        if not running:
            status.update(state="failed", message="The local worker stopped before completing. Click Extract to retry.")
            write_json(directory / "status.json", status)
            write_json(directory / "request.json", {"origin": origin})
    return {"ok": True, **status}


def handle(message: dict, origin: str, config: dict) -> dict:
    if message.get("command") == "ping":
        return {"ok": True, "model": config["model"]}
    identifier = job_id(message.get("id"))
    directory = Path(config["jobs"]) / identifier
    if message.get("command") == "status":
        return public_status(directory, origin)
    if message.get("command") != "start":
        raise ValueError("Unknown native command.")
    if directory.exists():
        return public_status(directory, origin)
    media_url = validate_url(message.get("url"))
    source = validate_url(message.get("source"))
    format_ = message.get("format", "md")
    if format_ not in ("md", "vtt"):
        raise ValueError("Choose Markdown or WebVTT output.")
    spotify = urlsplit(media_url).hostname == "open.spotify.com"
    if spotify and (not re.fullmatch(r"https://open\.spotify\.com/episode/[A-Za-z0-9]{22}", media_url)
                    or source != media_url):
        raise ValueError("A canonical Spotify podcast episode URL is required.")
    duration = message.get("duration")
    if not spotify and (not isinstance(duration, (int, float)) or not 0 < duration <= 24 * 3600):
        raise ValueError("A finite recording duration of up to 24 hours is required.")
    directory.mkdir(parents=True)
    write_json(directory / "request.json", {
        "origin": origin, "url": media_url, "source": source, "duration": duration,
        "name": safe_name(message.get("name") or "transcript"), "format": format_,
        "automatic_name": not bool(message.get("name")),
    })
    status = {"id": identifier, "state": "queued", "message": "Queued for local Whisper."}
    write_json(directory / "status.json", status)
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    try:
        process = subprocess.Popen(
            [sys.executable, str(ROOT / "native_host.py"), "--worker", identifier],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=flags, close_fds=True,
        )
        write_json(directory / "worker.json", {"pid": process.pid})
    except OSError as error:
        status.update(state="failed", message="Could not start local worker: " + clean_error(error))
        write_json(directory / "status.json", status)
        write_json(directory / "request.json", {"origin": origin})
        raise
    return {"ok": True, **status}


def work(identifier: str, config: dict) -> None:
    import msvcrt

    directory = Path(config["jobs"]) / job_id(identifier)
    request_path = directory / "request.json"
    request = json.loads(request_path.read_text(encoding="utf-8"))

    def update(state, message, **extra):
        write_json(directory / "status.json", {
            "id": identifier, "state": state, "message": message, **extra,
        })

    try:
        from transcribe import transcribe
        podcast_episode = None
        published = None
        if urlsplit(request["url"]).hostname == "open.spotify.com":
            from podcast import resolve_episode, published_transcript, download_audio
            update("checking", "Finding the full public podcast episode in the publisher's RSS feed.")
            podcast_episode = resolve_episode(request["url"])
            request["duration"] = podcast_episode["duration"]
            if request.get("automatic_name"):
                request["name"] = safe_name(podcast_episode["name"])
            published, warnings = published_transcript(podcast_episode, request["format"])
            if warnings:
                update("queued", "Publisher captions were unusable; continuing with local Whisper. " +
                       clean_error(ValueError(" ".join(warnings))))
        with (Path(config["jobs"]) / "worker.lock").open("a+b") as lock:
            lock.seek(0)
            if not lock.read(1):
                lock.write(b"\0")
                lock.flush()
            while True:
                try:
                    lock.seek(0)
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    time.sleep(2)
            try:
                update("checking" if published else "downloading",
                       "Saving the publisher's transcript." if published else "Downloading the recording's audio locally.")
                with tempfile.TemporaryDirectory(prefix="audio-", dir=directory) as temporary:
                    args = [
                        sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-playlist",
                        "--no-progress", "--no-warnings", "--no-cache-dir", "--socket-timeout", "30",
                        "--retries", "3", "--fragment-retries", "3", "--max-filesize", "2G",
                        "-f", "bestaudio/best", "--print", "after_move:filepath",
                        "-o", str(Path(temporary) / "audio.%(ext)s"),
                    ]
                    if config.get("ffmpeg"):
                        args += ["--ffmpeg-location", config["ffmpeg"]]
                    rendered = Path(temporary) / f"published.{request['format']}"
                    if published:
                        rendered.write_text(published, encoding="utf-8")
                    elif podcast_episode:
                        media = Path(temporary) / "audio.mp3"
                        download_audio(podcast_episode["url"], media)
                    else:
                        downloaded = subprocess.run(
                            [*args, "--", validate_url(request["url"])],
                            capture_output=True, text=True, timeout=1800,
                            creationflags=subprocess.CREATE_NO_WINDOW,
                        )
                        if downloaded.returncode:
                            raise RuntimeError("Audio download failed. The recording may require sign-in, "
                                               "may be protected, or its URL expired. " + downloaded.stderr)
                        paths = downloaded.stdout.strip().splitlines()
                        if not paths:
                            raise RuntimeError("The downloader returned no audio file.")
                        media = Path(paths[-1]).resolve()
                        if media.parent != Path(temporary).resolve() or not media.is_file():
                            raise RuntimeError("The downloader returned an invalid audio file.")
                    last_update = 0.0

                    def progress(end, duration):
                        nonlocal last_update
                        if duration < request["duration"] * 0.9 - 2:
                            raise ValueError("Downloaded audio is shorter than the full recording. "
                                             "Refusing to transcribe a preview.")
                        now = time.monotonic()
                        if now - last_update >= 2:
                            percent = min(99, int(end / duration * 100)) if duration else 0
                            update("transcribing", f"Transcribing locally: {percent}%", progress=percent)
                            last_update = now

                    if not published:
                        update("transcribing", "Loading local Whisper model (first use downloads model weights).")
                        vtt_path, md_path = transcribe(
                            media, config["model"], None, Path(temporary),
                            request["format"] == "vtt", request["format"] == "md",
                            progress=progress, source_name=request["source"],
                        )
                        rendered = md_path if request["format"] == "md" else vtt_path
                    if rendered is None or not rendered.is_file():
                        raise RuntimeError("Whisper did not produce a transcript.")
                    output_dir = Path(config["downloads"])
                    output_dir.mkdir(parents=True, exist_ok=True)
                    name = request["name"]
                    destination = None
                    for suffix in range(10000):
                        candidate = output_dir / f"{name}{f' ({suffix})' if suffix else ''}.{request['format']}"
                        try:
                            with candidate.open("xb") as target:
                                target.write(rendered.read_bytes())
                            destination = candidate
                            break
                        except FileExistsError:
                            continue
                    if destination is None:
                        raise RuntimeError("Could not choose an unused output filename.")
                    method = "published podcast" if published else "local Whisper"
                    update("complete", f"Saved {method} transcript to:\n{destination}", path=str(destination))
            finally:
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
    except (Exception, SystemExit) as error:
        update("failed", clean_error(error))
    finally:
        # Keep only the extension ownership marker, not signed URLs or titles.
        write_json(request_path, {"origin": request["origin"]})


def main() -> None:
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        work(sys.argv[2], config)
        return
    origin = sys.argv[1] if len(sys.argv) > 1 else ""
    if origin not in config["allowed_origins"]:
        raise ValueError("Unregistered extension origin.")
    while True:
        try:
            message = read_message(sys.stdin.buffer)
            if message is None:
                return
            response = handle(message, origin, config)
        except (ValueError, OSError, KeyError, TypeError) as error:
            response = {"ok": False, "error": clean_error(error)}
        send_message(sys.stdout.buffer, response)


if __name__ == "__main__":
    main()
