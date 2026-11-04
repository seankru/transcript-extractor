# YouTube Caption Extractor

A small Edge / Chrome extension (MV3) that saves an available YouTube
caption track as a clean `.vtt` or `.md` file.

## Use

1. Open a YouTube video.
2. Click **YouTube Caption Extractor** in the browser toolbar.
3. Optionally choose a caption track and output format (Markdown is default).
4. Click **Extract & Download**.

The popup lists both creator-provided and auto-generated caption tracks.
Tracks are sorted using the browser/system language preferences (for example,
English first for US-English), preferring publisher-supplied captions within
each language and an exact regional match when otherwise equivalent. The first
track is selected. If no preferred language matches and auto-generated tracks
identify a single language, that language is ranked next; other choices retain
their platform order. Multiple auto-generated languages are not treated as
evidence of the video's original spoken language.
This is only the initial default: **Transcript language / version** lets you choose any advertised
language, regional variant, or auto-generated track. The selected track is used
for either output format; a changed track list requires reopening the popup
rather than extracting a different track at the same index.

Labels use the platform's language name without repeating the language code or
auto-generated marker, for example **English (auto-generated)**. Saved filenames
include the chosen track after the video title or custom basename, for example
`My video-Hebrew (auto-generated).md`, so different language exports are distinct.

Shorts uses YouTube's `shorts-player`, not the hidden regular `movie_player`.
The extractor requests fresh captions through the active player and waits for
the complete player-generated URL, including its client context. Shorts does
not normally offer Show transcript: if YouTube still returns empty captions,
the error links to the equivalent regular watch page instead of asking for a
nonexistent Shorts panel. No audio transcription starts on that retrieval error.

If direct caption downloads
fail or return an empty/unreadable body, the extension tries YouTube's published
**Show transcript** panel instead of treating a download failure as missing captions. Open that panel
if it is not already open. The fallback attempts to switch the panel's native
language menu to your chosen track. If the site cannot switch or identify that
track, it asks you to select the matching panel language; it never substitutes
the current panel's language. The fallback reads
timestamped transcript rows, scrolls the list, restores its scroll position, and
rejects partial, searched, or mismatched-language results. It does not record
audio or wait for the video to play through.

A failed caption fetch or unreadable panel is reported as a retrieval error,
not proof that captions are absent; it does not automatically invoke Whisper.
When the video advertises no caption tracks,
the button asks before downloading and starting local Whisper. The optional
**Automatically transcribe when captions are unavailable** checkbox remembers
opt-in for this extension; it defaults off. Transcription uses the optional
[native helper](../../tools/local-transcription/README.md).
Markdown output contains one timestamped line per YouTube cue and preserves
YouTube chapters as timestamped section headings when the video provides them.

## Install (developer mode)

Run `pwsh .\scripts\prepare-extensions.ps1` from the repository root first.

1. Open `edge://extensions` or `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `extensions/youtube/`.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Temporary access to the tab you invoked the extension on. The popup additionally checks that tab's origin and refuses to run anywhere but YouTube. |
| `scripting` | Read the current player's caption-track metadata and download the selected track. |
| `nativeMessaging` | Call the optional local Whisper helper when published captions are unavailable. |
| `storage`, `alarms` | Persist local job status and poll progress after the popup closes. |
| `https://*.youtube.com/*` | Declares YouTube as the extension's host scope. |
| `https://*.youtube-nocookie.com/*` | The origin checks accept privacy-enhanced embeds, so the host scope declares them rather than relying on `activeTab` alone. |

Published-caption processing happens in the current browser tab. Caption downloads are
fetched only from `youtube.com` / `youtube-nocookie.com` hosts, enforced in
`popup.js`. Fallback transcription runs on your PC; `yt-dlp` downloads the
recording and Whisper transcribes it locally. Model weights download on first
use. The extension has no telemetry or cloud transcription service.

## Tests

```powershell
npm install
node tests\run.mjs
```

The harness covers the pure transcript logic — JSON3 and XML/SRV3 cue parsing,
rejection of non-timedtext bodies (an HTTP 200 bot interstitial must not parse
as captions), double-escaped entity handling, cue ordering, VTT escaping,
Markdown chapter placement (including chapters after the last cue and the
video-id-guarded `ytInitialData` fallback), filename sanitisation, the
caption-host allowlist, and the caption-URL matching used by the
Proof-of-Origin fallbacks.

`xmlToCues` needs a DOM parser. Node has no global `DOMParser`, so the harness
loads `@xmldom/xmldom` and **fails** if neither is available — it does not skip.
It is declared in the repository-root `package.json` as a dev dependency, so
`npm install` from the repository root is enough.

`findRuntimeCaptionUrl` is exercised against a fake `movie_player` and a stubbed
resource-timing buffer, covering the `setOption` sequencing, stale-resource
rejection and the caption-module restore round-trip. These synthetic checks do
not guarantee live token discovery for every browser session.
Shorts player selection and complete-request preference are covered by
regressions. On `JPE22wtnDo0`, isolated Edge also received empty responses to
YouTube's native caption request; successful live Shorts extraction is not
established by those synthetic tests.

`node tests\panel.mjs` exercises the transcript-panel fallback, including
virtualized rows, scroll restoration, track identity, filtered/partial results
and navigation. These are synthetic DOM tests, not verification against every
YouTube transcript-panel layout.

### Live direct-path diagnosis

On `tTcxVv8HHNw` in Edge, the player-response URL and a POT-bearing audio-track
URL returned HTTP 200 with empty bodies. A fresh player-generated request with
both POT and browser/client context returned 566 creator-provided cues.
Removing either POT or the browser/client-context parameter group from that
same working URL returned an empty body; replaying the complete URL still worked.
POT presence alone is therefore not sufficient in this observed session.
The runtime fallback preserves the player's complete URL rather than assembling
tokens or client context itself. No cookies or token values need to be logged.

The installed extension's panel fallback was also exercised on that video with
timedtext responses deliberately made empty: it exported 273 creator-provided
panel rows through 31:47, without starting Whisper. The panel groups text into
different segments than the 566-cue direct track.

## Limitations

* Without captions, the local helper must be installed and `yt-dlp` must be
  able to download the recording. Sign-in-only or bot-blocked videos can fail.
* Translated tracks that YouTube generates only after a language is chosen
  in the player are not synthesized by this extension.
* Live captions may be incomplete until the stream or premiere finishes.
