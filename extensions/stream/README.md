# Stream Transcript Extractor

A small Edge/Chrome extension (MV3) that saves the transcript from a
Microsoft Stream / SharePoint recording you can already view to a clean
**WebVTT** or **Markdown** file in your Downloads folder, with speaker
names preserved.

Tested against Stream's May 2026 build. Selectors used:
`listItemWithSpeaker-*`, `baseTimestamp-*`, `itemHeader-*`.

## Install (unpacked)

1. Open `edge://extensions` (or `chrome://extensions`).
2. Toggle **Developer mode** on (top-right corner).
3. Click **Load unpacked** and pick this folder
   (`extensions/stream/`).
4. Pin **Stream Transcript Extractor** to the toolbar (puzzle-piece
   icon → pushpin next to the extension).

To produce a publishable zip, from the repo root:

```pwsh
./scripts/build.ps1 -Name stream
```

No external dependencies, no service worker, no remote calls.

## Use

1. Open a Stream recording page in SharePoint (the URL with
   `/personal/<someone>/.../<file>.mp4?...`).
2. **Open the transcript pane** — `...` menu → **Transcript**. The cue
   list must be visible on the right.
3. Click the extension's toolbar icon.
4. (Optional) Enter a custom filename. Blank = page title minus the
   "- Microsoft Stream" suffix.
5. Click **Extract & Download**.

The popup reports cue count, byte size, and the highest timestamp
covered. The `.vtt` (or `.md`) lands in your default Downloads folder.

The extractor uses a 3-tier extraction path:

1. Native click on Stream's `#downloadTranscript` menu → "Download as
   .vtt" item.
2. Authenticated fetch against the SharePoint media-transcripts API
   for the JSON variant with speakers, with raw VTT fallback.
3. DOM scrape with virtualised-scroll loop using
   `[class*="listItemWithSpeaker-"]`, `[class*="baseTimestamp-"]`, and
   `[class*="itemDisplayName-"]` selectors + aria-posinset/aria-setsize
   for canonical dedupe.

**Keep the popup open and stay on the tab** while it runs (≈10–30 s
for a 50-minute recording).

## Output format

```
WEBVTT

00:00:06.000 --> 00:00:09.990
<v Speaker One>Okay, I'll share my screen so we can walk through it.

00:00:10.000 --> 00:00:22.990
<v Speaker Two>Sounds good, go ahead.
```

`<v Speaker>` is standard WebVTT voice-tag syntax. Compatible with
ffmpeg, web players, most transcription pipelines.

## Limitations

- **Transcript pane must be open** before extraction (or the menu
  tier must be reachable). The extension does not click "show
  transcript" for you.
- Selectors are tied to Stream's current React build. If Microsoft
  renames the CSS-modules class prefixes, the extension reports an
  error rather than producing garbage output — file an issue and
  update the selectors in `popup.js` (the three `[class*="..."]`
  strings).
- If the recording has no transcript available on the page, there's
  nothing to extract. Open the transcript pane and confirm cues are
  visible first.
- The page must remain the **active** tab; throttled background-tab
  timers slow the scroll loop and may cause stagnation cutoff to fire
  too early.

## Privacy

The extension only reads the transcript pane of the page you're
currently looking at, after you click its toolbar icon. It makes no
remote calls beyond authenticated fetches to the same SharePoint /
Stream URLs the page already uses. Ships no telemetry, bundles no
third-party code. See [PRIVACY.md](../../PRIVACY.md).

## License

[MIT](../../LICENSE).
