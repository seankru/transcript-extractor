# Stream Transcript Extractor

A small Edge/Chrome extension (MV3) that saves the transcript from a
Microsoft Stream / SharePoint recording — or a **Teams meeting recap**
(including transcribed-only meetings with no recording) — that you can
already view to a clean **WebVTT** or **Markdown** file in your Downloads
folder, with speaker names preserved.

Tested against Stream's May 2026 build. Selectors used:
`listItemWithSpeaker-*`, `baseTimestamp-*`, `itemHeader-*`. The Teams
Recap tab embeds the same SharePoint transcript viewer in a cross-origin
iframe, so the same selectors and download path apply there.

## Install (unpacked)

Run `pwsh .\scripts\prepare-extensions.ps1` from the repository root first.

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

Published transcripts need no external helper. A service worker integrates the
optional [local Whisper helper](../../tools/local-transcription/README.md) for
recordings without transcripts. Markdown is selected by default; WebVTT remains
available. `nativeMessaging`, `storage`, and `alarms` support durable local jobs.
Without published captions, confirmation is required before downloading and
transcribing. **Automatically transcribe when captions are unavailable** opts
this extension out of that prompt; the saved checkbox defaults off.
The fallback requires an enabled recording-download link and does not bypass
organizational export restrictions, DRM, or sign-in.

## Use

### Stream / SharePoint recording

1. Open a Stream recording page in SharePoint (the URL with
   `/personal/<someone>/.../<file>.mp4?...`).
2. **Open the transcript pane** — `...` menu → **Transcript**. The cue
   list must be visible on the right.
3. Click the extension's toolbar icon.
4. (Optional) Enter a custom filename. Blank = page title minus the
   "- Microsoft Stream" suffix.
5. Click **Extract & Download**.

### Teams meeting recap

One click, from **either** starting point — the extension does the rest
(same as the Stream experience):

- **From the meeting chat:** the Recap tab does not have to be open. The
  extension switches to the **Recap** tab, shows the **Transcript**, and
  extracts. For a recurring meeting it selects the **most recent**
  occurrence (unless you've already opened the recap on a specific one).
- **From the calendar event peek:** click the extension while the event's
  **"View recap"** card is showing. The extension clicks **View recap**
  (which opens the exact occurrence you selected), shows the Transcript,
  and extracts. This is the unambiguous way to grab a specific occurrence.

This works whether or not the meeting was recorded — a transcribed-only
meeting and a recorded meeting are both extracted straight from Teams
(no "Open in Stream" detour).

Blank filename = a descriptive default built from the meeting title and
instance date/time, e.g. `Sean _ Blake 1_1 - 20260702_1305 Recap.vtt`
(local start time; title from the chat header, or the document title when
opened from the calendar).

The popup reports cue count, byte size, and the highest timestamp
covered. The `.vtt` (or `.md`) lands in your default Downloads folder.

The extractor uses a tiered extraction path (first that succeeds wins):

1. **Fetch** the canonical transcript JSON (with speakers) from Stream's
   own URL — the SharePoint media-transcripts API for recordings, or the
   Teams recap `streamContent` endpoint for meeting recaps — saved under
   our own filename. For Teams recaps this is preferred over the native
   download (whose filename is site-controlled).
2. **Native click** on Stream's `#downloadTranscript` menu → "Download as
   .vtt" (Stream recordings only; skipped for Teams recaps).
3. **DOM scrape** with a virtualised-scroll loop using
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
- **Transcribed-only meetings** (transcribed but never recorded) have
  no Download button in the transcript pane. The extension detects this
  and scrapes the visible cue list directly — you still get a `.vtt` /
  `.md`, just without Stream's authoritative cue IDs.
- **Sensitivity / DLP-labeled items** may render the transcript pane
  while disabling (or hiding) the Download control and blocking the
  transcript API. When that happens the extension falls back to the DOM
  scrape as a backup and tells you the download was blocked — re-label
  the item to one that permits export if you want Stream's byte-for-byte
  `.vtt`. If the label also blanks the pane, no rows are visible and
  there is nothing to scrape until it is re-labeled.
- **Teams meeting recaps** render the transcript in a cross-origin
  SharePoint iframe. The extension injects into that iframe via
  `host_permissions`; production tenants use `*.sharepoint.com` and
  dogfood tenants use `*.sharepoint-df.com` (both are declared). The
  calendar event peek's **"View recap"** button lives in the
  `outlook.office.com` calendar iframe, so that host is declared too. You
  can start from the meeting chat or the calendar event peek.
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
