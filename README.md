# Transcript Extractors

A small family of Edge / Chrome extensions (MV3) that save the
transcript of whatever you're watching to a clean `.md` (default) or `.vtt`
file in Downloads. Published transcripts preserve available speaker names;
recordings without transcripts can be transcribed on-device with Whisper.

Each extension is independent — its own toolbar button, its own
permissions scoped to a single host, its own marketplace listing. The
repo is a monorepo because the extractors share a workflow (build,
icons, listing checklist) more than they share code.

## Family

| Extension | Folder | Hosts | Status |
| --- | --- | --- | --- |
| Stream Transcript Extractor | [extensions/stream](extensions/stream) | SharePoint / Microsoft Stream / Teams recap | Edge Add-ons draft (v0.2.0) |
| Substack Transcript Extractor | [extensions/substack](extensions/substack) | `*.substack.com` video posts | Unpacked install only (v0.1.4) |
| YouTube Caption Extractor | [extensions/youtube](extensions/youtube) | `*.youtube.com` videos | Unpacked install only (v0.1.0) |

Planned sibling: Zoom (cloud-recording VTT export). It will appear under
`extensions/zoom/` when implemented.

## Why separate extensions instead of one mega-extension?

* Permissions stay tight. The Stream extension never gets to touch
  Substack pages, and vice versa.
* Marketplace listings stay honest: each store page describes exactly
  one workflow.
* Each one ships independently. A regression on Substack does not
  block a Stream update.
* Caption extraction stays site-specific. The native Whisper client and
  background job worker are shared under `extensions/_shared/`, copied into
  each independently installable package by the preparation/build scripts.

## Repo layout

```
extensions/
  stream/        # Microsoft Stream extractor
  substack/      # Substack extractor
  youtube/       # YouTube timed-text extractor
  ...
scripts/
  build.ps1            # build extensions/<name>/ into dist/<name>-vX.Y.Z.zip
  generate-icons.ps1   # render brand-coloured icons into a target dir
dist/                  # zips ready for marketplace upload (gitignored)
PRIVACY.md             # privacy posture (applies to all extensions)
LICENSE                # MIT
```

## Build a release zip

```pwsh
./scripts/build.ps1 -Name stream     # → dist/stream-transcript-extractor-v0.2.0.zip
./scripts/build.ps1 -Name substack   # → dist/substack-transcript-extractor-v0.1.4.zip
./scripts/build.ps1 -Name youtube    # → dist/youtube-transcript-extractor-v0.1.0.zip
```

The build script prepares the shared runtime and zips only browser files
(`manifest.json`, `popup.html`, JavaScript, `icons/`) — no README,
no screenshots, no test scaffolding.

## Regenerate icons

```pwsh
./scripts/generate-icons.ps1 -OutDir extensions/stream/icons   -Hex 0078D4   # Stream / Microsoft blue
./scripts/generate-icons.ps1 -OutDir extensions/substack/icons -Hex FF6719   # Substack orange
./scripts/generate-icons.ps1 -OutDir extensions/youtube/icons  -Hex FF0033   # YouTube red
```

Both produce 16/32/48/128 PNGs: a brand-coloured rounded square with
three white transcript bars.

## Install (developer mode)

For any extension in the family:

Run `pwsh .\scripts\prepare-extensions.ps1` from the repository root first.
Repeat after changing shared JavaScript, then reload the extensions.

1. Open `edge://extensions` (or `chrome://extensions`).
2. Toggle **Developer mode**.
3. Click **Load unpacked** and pick the appropriate
   `extensions/<name>/` folder.

## One-click local transcription (Windows)

The button prefers published transcripts/captions. Markdown is selected by
default; WebVTT is still available. If published captions are absent (including
Substack preview-only captions), the extension asks before downloading the
recording and starting local Whisper. Enable **Automatically transcribe when
captions are unavailable** to skip this prompt. The setting defaults off and
is saved separately for each extension.

Install the helper once, using the IDs displayed at `edge://extensions` or
`chrome://extensions`:

```pwsh
.\tools\local-transcription\install.ps1 -ExtensionId @('YOUR_32_CHARACTER_EXTENSION_ID')
# Multiple extensions can share the helper:
.\tools\local-transcription\install.ps1 -ExtensionId @('FIRST_ID', 'SECOND_ID', 'THIRD_ID')
# Chrome: add -Browser Chrome. Default model is small; -Model base is faster.
```

Python 3.10+ is required. The installer restores `faster-whisper` and `yt-dlp`
when missing, installs a native-messaging host under
`%LOCALAPPDATA%\TranscriptExtractor`, and registers it for this Windows user.
Reload each extension afterward. No browser debugging connection is needed.
See [the helper README](tools/local-transcription/README.md) for behavior,
limits, privacy, testing, and uninstall instructions.

Generated transcripts run independently of the popup: close it while Whisper
works, then reopen for progress. The badge shows `...`, `Done`, or `!`.
Files are saved to the Windows Downloads known folder without overwriting
existing files. The first run downloads model weights and can take longer.
Generated transcripts do not identify speakers and can contain recognition errors.

## Privacy

No telemetry or cloud transcription. Published captions are fetched from their
provider; fallback audio is downloaded from the recording's provider/CDN and
transcribed locally. Model weights are downloaded on first use.
See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE).
