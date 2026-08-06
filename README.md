# Transcript Extractors

A small family of Edge / Chrome extensions (MV3) that save the
transcript of whatever you're watching to a clean `.vtt` or `.md` file
in your Downloads folder, with speaker names preserved.

Each extension is independent — its own toolbar button, its own
permissions scoped to a single host, its own marketplace listing. The
repo is a monorepo because the extractors share a workflow (build,
icons, listing checklist) more than they share code.

## Family

| Extension | Folder | Hosts | Status |
| --- | --- | --- | --- |
| Stream Transcript Extractor | [extensions/stream](extensions/stream) | SharePoint / Microsoft Stream / Teams recap | Edge Add-ons draft (v0.2.0) |
| Substack Transcript Extractor | [extensions/substack](extensions/substack) | `*.substack.com` video posts | Unpacked install only (v0.1.4) |

Planned siblings: YouTube (timed-text track), Zoom (cloud-recording
VTT export). Will appear under `extensions/youtube/` and
`extensions/zoom/` when implemented.

## Why separate extensions instead of one mega-extension?

* Permissions stay tight. The Stream extension never gets to touch
  Substack pages, and vice versa.
* Marketplace listings stay honest: each store page describes exactly
  one workflow.
* Each one ships independently. A regression on Substack does not
  block a Stream update.
* Once 3+ extensions exist and we feel real duplication, we can lift
  shared bits (VTT-to-Markdown converter, save-to-Downloads helper)
  into `extensions/_shared/` and import. Until then, each extension's
  `popup.js` is self-contained.

## Repo layout

```
extensions/
  stream/        # Microsoft Stream extractor
  substack/      # Substack extractor
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
```

The build script zips only the files the browser actually loads
(`manifest.json`, `popup.html`, `popup.js`, `icons/`) — no README,
no screenshots, no test scaffolding.

## Regenerate icons

```pwsh
./scripts/generate-icons.ps1 -OutDir extensions/stream/icons   -Hex 0078D4   # Stream / Microsoft blue
./scripts/generate-icons.ps1 -OutDir extensions/substack/icons -Hex FF6719   # Substack orange
```

Both produce 16/32/48/128 PNGs: a brand-coloured rounded square with
three white transcript bars.

## Install (developer mode)

For any extension in the family:

1. Open `edge://extensions` (or `chrome://extensions`).
2. Toggle **Developer mode**.
3. Click **Load unpacked** and pick the appropriate
   `extensions/<name>/` folder.

## Privacy

No telemetry, no third-party network calls. Each extension only reads
the page you're actively viewing, after you click its toolbar button.
See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE).
