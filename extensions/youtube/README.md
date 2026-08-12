# YouTube Caption Extractor

A small Edge / Chrome extension (MV3) that saves an available YouTube
caption track as a clean `.vtt` or `.md` file.

## Use

1. Open a YouTube video that has captions.
2. Click **YouTube Caption Extractor** in the browser toolbar.
3. Choose a caption track and output format.
4. Click **Extract & Download**.

The popup lists both creator-provided and auto-generated caption tracks.
Markdown output contains one timestamped line per YouTube cue and preserves
YouTube chapters as timestamped section headings when the video provides them.

## Install (developer mode)

1. Open `edge://extensions` or `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `extensions/youtube/`.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Temporary access to the tab you invoked the extension on. The popup additionally checks that tab's origin and refuses to run anywhere but YouTube. |
| `scripting` | Read the current player's caption-track metadata and download the selected track. |
| `https://*.youtube.com/*` | Declares YouTube as the extension's host scope. |
| `https://*.youtube-nocookie.com/*` | The origin checks accept privacy-enhanced embeds, so the host scope declares them rather than relying on `activeTab` alone. |

All processing happens in the current browser tab. Caption downloads are
fetched only from `youtube.com` / `youtube-nocookie.com` hosts, enforced in
`popup.js`. The extension has no telemetry and sends no data to third parties.

## Tests

```powershell
node tests\run.mjs
```

The harness covers the pure transcript logic — JSON3 and XML/SRV3 cue parsing,
double-escaped entity handling, cue ordering, VTT escaping, Markdown chapter
placement (including chapters after the last cue and the `ytInitialData`
fallback), filename sanitisation, the caption-host allowlist, and the
caption-URL matching used by the Proof-of-Origin fallbacks.

`xmlToCues` needs a DOM parser. Node has no global `DOMParser`, so the harness
loads `@xmldom/xmldom` and **fails** if neither is available — it does not skip.
Install it first:

```powershell
npm install --no-save @xmldom/xmldom
```

It does not exercise the live YouTube player: Proof-of-Origin token discovery,
the runtime resource-timing fallback and caption-module restoration are covered
only at the boundaries reachable without a real player.

## Limitations

* The video must expose at least one caption track.
* Translated tracks that YouTube generates only after a language is chosen
  in the player are not synthesized by this extension.
* Live captions may be incomplete until the stream or premiere finishes.
