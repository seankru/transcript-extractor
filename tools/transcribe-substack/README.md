# transcribe-substack

Companion CLI for the **Substack Transcript Extractor** browser extension.

Use this when a Substack post has a video but **no published captions** — i.e.
the extension's popup says "No transcript was found." This tool generates a
fresh transcript from the video's audio using a local Whisper model.

100% on-device. The only network call is a one-time model download on first
run, cached under your user profile.

---

## When to use this

| You see in the extension popup… | Use this tool? |
|---|---|
| A `.vtt` download button | No — you already have captions, just click it |
| "TTS-narrated audio (no transcript)" | No — the post body is already the transcript |
| "No transcript was found" but the post has an inline `<video>` | **Yes** |

---

## Quickstart

Pick the path that matches what you have:

### A. From a paid/auth-gated Substack post (one-shot)

If the post sits behind a paywall and the video plays via HLS (most modern
Substack videos do), use the **authed-Edge pipeline**:

```pwsh
# One-time: launch Edge with a persistent CDP-enabled profile, then sign in
# to the Substack publication. Leave Edge running.
pwsh .\.driver\launch-edge.ps1

# Open the Substack post in that Edge instance, then run:
pwsh .\tools\transcribe-substack\transcribe-from-tab.ps1 `
    -Tab "example-post-slug" `
    -Model small `
    -OutputDir "$HOME\Desktop"
```

`-Tab` is any substring of the open tab's URL — usually the post slug. The
script attaches to Edge over CDP, resolves the video URL inside the real
browser network stack (cookies + TLS fingerprint, so Cloudflare anti-bot is
not triggered), downloads the HLS stream via `yt-dlp`, transcribes via
faster-whisper, and deletes the downloaded `.mp4` afterwards.

### B. From a local audio/video file

Already have the file? Skip the probe:

```pwsh
python tools\transcribe-substack\transcribe.py "C:\path\to\video.mp4" --model small
```

### C. From a direct URL (free Substack CDN MP4, public stream, etc.)

```pwsh
python tools\transcribe-substack\transcribe.py `
    --url "https://example-newsletter.substack.com/cdn/example-post.mp4" `
    --model small
```

`transcribe.py` invokes `yt-dlp` internally. This path works for any
URL `yt-dlp` knows how to download — but **not** for Cloudflare-fronted
endpoints like Substack's `/api/v1/video/upload/<id>/src`. For those use
path **A**.

---

## What you get

For an input `video.mp4`, two files land next to it (or in `--output-dir`):

- `video.vtt` — WebVTT captions, openable in any video player
- `video.md` — Markdown with frontmatter and timestamped paragraphs:

```markdown
---
source: "video.mp4"
duration_seconds: 91.1
language: "en"
language_probability: 1.00
generator: faster-whisper
---

**[00:00:00.000]** Welcome to the show. Today we're talking about…

**[00:00:10.000]** …
```

---

## CLI reference

### `transcribe.py`

```text
python transcribe.py [INPUT_PATH] [--url URL] [--name NAME] [--keep-video]
                                  [--model MODEL] [--language LANG]
                                  [--output-dir DIR] [--no-vtt] [--no-md]
```

| Flag | Default | Notes |
|---|---|---|
| `INPUT_PATH` | — | Positional. Local audio/video file. Omit when using `--url`. |
| `--url` | — | Download from this URL first via `yt-dlp`, then transcribe. |
| `--name` | `video` | Basename for the downloaded file when using `--url`. |
| `--keep-video` | off | Retain the downloaded `.mp4` (default: delete after transcribing). |
| `--model` | `small` | One of `tiny`, `base`, `small`, `medium`, `large-v3`. |
| `--language` | auto | ISO code (`en`, `es`, …). Auto-detect is reliable for clean audio. |
| `--output-dir` | input's dir | Where to write `.vtt` / `.md`. Also where downloads land. |
| `--no-vtt` | off | Skip the WebVTT file. |
| `--no-md` | off | Skip the Markdown file. |

### `transcribe-from-tab.ps1`

```text
transcribe-from-tab.ps1 -Tab <fragment> [-Model MODEL] [-OutputDir DIR]
                                        [-Name NAME] [-KeepVideo]
                                        [-Language LANG]
```

| Param | Default | Notes |
|---|---|---|
| `-Tab` | (required) | URL fragment used to pick the open Edge tab. |
| `-Model` | `small` | Passed through to `transcribe.py`. |
| `-OutputDir` | temp dir | Where the `.vtt` / `.md` (and `.mp4` if `-KeepVideo`) land. |
| `-Name` | `video` | Output basename. |
| `-KeepVideo` | off | Keep the downloaded `.mp4`. |
| `-Language` | auto | ISO code. |

### Model size guide

| Model | Disk | Speed (CPU, int8) | Use when |
|---|---|---|---|
| `tiny` | ~75 MB | ~20× realtime | quick & dirty |
| `base` | ~140 MB | ~10× realtime | fast, decent |
| `small` | ~460 MB | ~3× realtime | **recommended default** |
| `medium` | ~1.5 GB | ~1× realtime | best ratio for long-form |
| `large-v3` | ~3.0 GB | ~0.3× realtime | publication-quality |

First run with a given model size downloads the weights from HuggingFace into
`~\.cache\huggingface\`. Later runs load instantly.

---

## Prerequisites

| For path… | Need |
|---|---|
| Any | Python 3.10+, `ffmpeg` on `PATH`, `pip install -U faster-whisper`, `pip install -U yt-dlp` |
| A | Node.js 18+, Playwright installed (`npm i -D playwright` in repo root), Edge installed |

GPU is auto-detected. If a CUDA-capable GPU is available, faster-whisper runs
there automatically; otherwise it falls back to CPU with int8 quantisation.

---

## Privacy

- **Path A** sends one HTTPS request to your authed Substack origin (to
  resolve the redirect) and downloads the video segments directly from the
  video CDN that the browser would have fetched them from anyway. No
  third-party services are involved.
- **Paths B and C** make no network calls beyond what `yt-dlp` does for the
  URL you supply.
- Transcription runs entirely on-device. No transcript text, audio bytes, or
  post URLs ever leave your machine.
- One exception: faster-whisper downloads model weights from HuggingFace on
  first use of a given size. That's a one-time anonymous HTTPS GET; no audio
  data is involved.

---

## Troubleshooting

**`Could not attach to Edge on CDP port 9222.`**
The CDP-enabled Edge isn't running. Start it with
`pwsh .\.driver\launch-edge.ps1`, sign in, then re-run.

**`No open tab matches "<fragment>"`.**
Open the Substack post in that Edge instance first.

**`HTTP 403` / Cloudflare from `yt-dlp` on a Substack endpoint.**
Don't point `yt-dlp` directly at `https://<sub>.substack.com/api/v1/video/...`.
That endpoint is Cloudflare-fronted and rejects `yt-dlp`'s TLS fingerprint.
Use path **A** so the redirect is resolved inside the real browser first.

**Whisper output is empty / nonsense.**
Try `--model small` or `--model medium`. The `tiny` model is fast but can
struggle with low-bitrate audio or non-standard accents.

**Transcription is very slow.**
You're on CPU. Drop to a smaller model (`base` or `tiny`), or transcribe a
short slice first:
`ffmpeg -ss 0 -t 60 -i input.mp4 sample.wav` then run `transcribe.py` on
`sample.wav` to gauge quality before committing to the full duration.
