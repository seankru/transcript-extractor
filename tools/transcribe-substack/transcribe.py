#!/usr/bin/env python3
"""Transcribe a local audio/video file using faster-whisper.

Companion CLI to the Substack Transcript Extractor browser extension. Use this
when a Substack post has a video but no published captions: download the .mp4
via the extension (or the `download-video.js` console snippet), then run this
script to produce a transcript locally.

100% on-device. No network calls except the one-time model download on first
run (cached under ~/.cache/huggingface).

Usage:
    python transcribe.py <input> [--model MODEL] [--language LANG]
                                  [--output-dir DIR] [--no-vtt] [--no-md]

Models (faster-whisper):
    tiny       ~75 MB    fastest, lowest accuracy
    base       ~140 MB   fast, OK accuracy
    small      ~460 MB   recommended default
    medium     ~1.5 GB   better accuracy, slower
    large-v3   ~3.0 GB   highest accuracy, slowest

The first run with a given model downloads it to the HuggingFace cache; later
runs are instant to load.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def fmt_timestamp(seconds: float) -> str:
    """Format seconds as a WebVTT timestamp: HH:MM:SS.mmm."""
    if seconds < 0:
        seconds = 0.0
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds % 60
    return f"{hours:02d}:{minutes:02d}:{secs:06.3f}"


def write_vtt(segments: list, out_path: Path) -> None:
    """Write segments to a WebVTT file."""
    lines = ["WEBVTT", ""]
    for seg in segments:
        start = fmt_timestamp(seg["start"])
        end = fmt_timestamp(seg["end"])
        text = seg["text"].strip()
        lines.append(f"{start} --> {end}")
        lines.append(text)
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")


def write_md(segments: list, info: dict, out_path: Path, source_name: str) -> None:
    """Write segments to a Markdown file with frontmatter and timestamps."""
    duration = info.get("duration", 0.0)
    language = info.get("language", "?")
    language_probability = info.get("language_probability", 0.0)

    frontmatter = [
        "---",
        f'source: "{source_name}"',
        f"duration_seconds: {duration:.1f}",
        f'language: "{language}"',
        f"language_probability: {language_probability:.3f}",
        "generator: faster-whisper",
        "---",
        "",
    ]

    body = []
    for seg in segments:
        ts = fmt_timestamp(seg["start"])
        text = seg["text"].strip()
        body.append(f"**[{ts}]** {text}")
        body.append("")

    out_path.write_text("\n".join(frontmatter + body), encoding="utf-8")


def download_url(url: str, output_dir: Path, basename: str) -> Path:
    """Use yt-dlp to download a streaming URL to a local file. Returns the path.

    Works against direct file URLs and HLS manifests (e.g. Mux .m3u8 with a
    signed JWT token in the query string). Cloudflare-fronted endpoints will
    fail at this layer — resolve them to the post-redirect URL first.
    """
    ytdlp = shutil.which("yt-dlp")
    if ytdlp is None:
        print(
            "ERROR: yt-dlp is not installed or not on PATH.\n"
            "Install it with: pip install -U yt-dlp",
            file=sys.stderr,
        )
        sys.exit(2)

    output_dir.mkdir(parents=True, exist_ok=True)
    # %(ext)s lets yt-dlp pick the container (almost always mp4 for HLS sources).
    output_template = str(output_dir / f"{basename}.%(ext)s")

    print(f"Downloading via yt-dlp: {url[:80]}...", file=sys.stderr)
    t0 = time.time()
    result = subprocess.run(
        [
            ytdlp,
            "--no-warnings",
            "--no-progress",
            "--print",
            "after_move:filepath",
            "-o",
            output_template,
            url,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        print("ERROR: yt-dlp failed:", file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        sys.exit(result.returncode or 2)

    # yt-dlp's --print after_move:filepath emits the final file path on stdout.
    final_path = result.stdout.strip().splitlines()[-1] if result.stdout else ""
    if not final_path:
        # Fall back: scan output_dir for the most recent file matching basename.
        candidates = sorted(
            output_dir.glob(f"{basename}.*"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not candidates:
            print(
                "ERROR: yt-dlp reported success but no file was found.",
                file=sys.stderr,
            )
            sys.exit(2)
        final_path = str(candidates[0])

    elapsed = time.time() - t0
    size_mb = Path(final_path).stat().st_size / (1024 * 1024)
    print(
        f"Downloaded {size_mb:.1f} MB in {elapsed:.1f}s -> {final_path}",
        file=sys.stderr,
    )
    return Path(final_path)


def transcribe(
    input_path: Path,
    model_name: str,
    language: str | None,
    output_dir: Path | None,
    write_vtt_flag: bool,
    write_md_flag: bool,
) -> tuple[Path | None, Path | None]:
    """Run transcription. Returns (vtt_path, md_path), either of which may be None."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            "ERROR: faster-whisper is not installed.\n"
            "Install it with: pip install -U faster-whisper",
            file=sys.stderr,
        )
        sys.exit(2)

    if not input_path.exists():
        print(f"ERROR: input file does not exist: {input_path}", file=sys.stderr)
        sys.exit(2)

    out_dir = output_dir if output_dir is not None else input_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = input_path.stem

    print(f"Loading model: {model_name} (first run downloads weights)", file=sys.stderr)
    t0 = time.time()
    # int8 on CPU = fastest with negligible accuracy loss for English.
    model = WhisperModel(model_name, device="auto", compute_type="int8")
    print(f"Model loaded in {time.time() - t0:.1f}s", file=sys.stderr)

    print(f"Transcribing: {input_path.name}", file=sys.stderr)
    t1 = time.time()
    segments_iter, info = model.transcribe(
        str(input_path),
        language=language,
        vad_filter=True,
        beam_size=5,
    )

    # Materialise the generator and stream progress to stderr.
    segments: list[dict] = []
    for seg in segments_iter:
        segments.append(
            {
                "start": seg.start,
                "end": seg.end,
                "text": seg.text,
            }
        )
        # One dot per segment so the user knows it's alive.
        sys.stderr.write(".")
        sys.stderr.flush()
    sys.stderr.write("\n")

    elapsed = time.time() - t1
    duration = info.duration
    rt_factor = duration / elapsed if elapsed > 0 else 0
    print(
        f"Done in {elapsed:.1f}s for {duration:.1f}s of audio "
        f"({rt_factor:.1f}x realtime). Detected language: "
        f"{info.language} (p={info.language_probability:.2f})",
        file=sys.stderr,
    )

    info_dict = {
        "duration": info.duration,
        "language": info.language,
        "language_probability": info.language_probability,
    }

    vtt_path: Path | None = None
    md_path: Path | None = None
    if write_vtt_flag:
        vtt_path = out_dir / f"{stem}.vtt"
        write_vtt(segments, vtt_path)
    if write_md_flag:
        md_path = out_dir / f"{stem}.md"
        write_md(segments, info_dict, md_path, input_path.name)

    return vtt_path, md_path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Transcribe a local audio/video file with faster-whisper.",
    )
    parser.add_argument(
        "input",
        nargs="?",
        default=None,
        help="Path to a local audio/video file (mp4, m4a, mp3, wav, webm, etc.). Omit when using --url.",
    )
    parser.add_argument(
        "--url",
        default=None,
        help=(
            "Download from this URL first (via yt-dlp), then transcribe. "
            "Use the resolved Mux URL from .driver/resolve-mux-url.mjs, not the "
            "Cloudflare-fronted Substack endpoint."
        ),
    )
    parser.add_argument(
        "--name",
        default=None,
        help="Basename for downloaded file when using --url (default: 'video').",
    )
    parser.add_argument(
        "--keep-video",
        action="store_true",
        help="Keep the downloaded video file (default: delete after transcribing when --url is used).",
    )
    parser.add_argument(
        "--model",
        default="small",
        choices=["tiny", "base", "small", "medium", "large-v3"],
        help="Whisper model size (default: small)",
    )
    parser.add_argument(
        "--language",
        default=None,
        help="ISO language code (e.g. 'en'). Default: auto-detect.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Directory to write outputs (default: same dir as input).",
    )
    parser.add_argument(
        "--no-vtt",
        action="store_true",
        help="Skip writing the .vtt file.",
    )
    parser.add_argument(
        "--no-md",
        action="store_true",
        help="Skip writing the .md file.",
    )
    args = parser.parse_args()

    # Resolve input: either a local file or a URL we download first.
    if args.url and args.input:
        print("ERROR: pass either a local file path OR --url, not both.", file=sys.stderr)
        return 2
    if not args.url and not args.input:
        parser.error("either a local file path or --url is required")

    downloaded_to_clean: Path | None = None
    if args.url:
        # Download into output-dir if given, else a temp dir we'll clean up.
        if args.output_dir is not None:
            download_dir = args.output_dir
        else:
            download_dir = Path(tempfile.mkdtemp(prefix="transcribe-substack-"))
        basename = args.name or "video"
        input_path = download_url(args.url, download_dir, basename)
        if not args.keep_video:
            downloaded_to_clean = input_path
    else:
        input_path = args.input

    try:
        vtt_path, md_path = transcribe(
            input_path=input_path,
            model_name=args.model,
            language=args.language,
            output_dir=args.output_dir,
            write_vtt_flag=not args.no_vtt,
            write_md_flag=not args.no_md,
        )
    finally:
        if downloaded_to_clean is not None and downloaded_to_clean.exists():
            try:
                downloaded_to_clean.unlink()
                print(
                    f"Removed downloaded video: {downloaded_to_clean} "
                    "(pass --keep-video to retain it)",
                    file=sys.stderr,
                )
            except OSError as e:
                print(
                    f"Warning: could not delete {downloaded_to_clean}: {e}",
                    file=sys.stderr,
                )

    # Print final paths to stdout (machine-friendly).
    if vtt_path is not None:
        print(str(vtt_path))
    if md_path is not None:
        print(str(md_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
