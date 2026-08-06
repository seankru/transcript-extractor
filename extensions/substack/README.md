# Substack Transcript Extractor

A small Edge / Chrome extension (MV3) that saves the transcript from a
Substack video post as a local `.vtt` or `.md` file, with speaker names
resolved.

## How it works

Substack video posts inline a `_preloads` JSON blob that contains a
pre-signed `substackcdn.com/.../*.vtt` URL plus a `speaker_map` such as
`{"SPEAKER_00": "Anya Leonard", "SPEAKER_01": "Philip Freeman"}`. The
extension:

1. Reads `window._preloads` (or, as a fallback, scans inline `<script>`
   tags) for the VTT URL and the speaker map.
2. Fetches the signed VTT directly from the Substack CDN — no extra
   auth, the URL carries its own `Expires=` query string.
3. Rewrites `<v SPEAKER_NN>` tags to `<v Real Name>` using the map.
4. For `.md` output, also fetches Substack's sibling `transcription.json`
   (word-level timing) and runs Substack's own paragraph-chunking
   algorithm against it, so the saved Markdown matches the paragraphs
   the reader sees in the transcript drawer (byte-perfect on the test
   post; falls back to a VTT-based heuristic if the JSON isn't
   reachable).
5. Saves to your Downloads folder.

No DOM scraping, no remote API beyond the same CDN your browser is
already loading the video from.

## Permissions

* `activeTab`, `scripting` — to inject the extractor when you click
  the button.
* `host_permissions: https://*.substack.com/*` — to run on any
  publication's post pages.
* `host_permissions: https://*.substackcdn.com/*` — to fetch the
  signed VTT from Substack's CDN.

## Install (developer mode)

1. Open `edge://extensions` (or `chrome://extensions`).
2. Toggle **Developer mode**.
3. Click **Load unpacked** and pick this folder
   (`extensions/substack`).

To produce a publishable zip, from the repo root:

```pwsh
./scripts/build.ps1 -Name substack
```

## Limitations

* Works only on Substack video posts that have a published transcript
  (the transcript panel must be visible on the post page).
* The signed VTT URL has a TTL; if extraction fails with "URL may have
  expired", just reload the page and try again.
* Audio-only podcast posts use a different rendering path and are not
  yet supported.

## Store description

<!-- BEGIN store Description field — paste everything between these two markers
     into Partner Center Step 7 "Description" (min 250 characters). -->

Substack Transcript Extractor saves the transcript from a Substack video post as a local WebVTT or Markdown file, with speaker names resolved from anonymous identifiers to real names.

Substack video posts embed a signed CDN URL for the transcript file and a speaker map (for example, SPEAKER_00 → Anya Leonard) in the page's preload data. The extension reads that data, fetches the signed VTT file directly from the Substack CDN, rewrites the anonymous speaker tags to real names, and saves the result to your Downloads folder. For Markdown output, it also fetches Substack's word-level transcription JSON and uses Substack's own paragraph-chunking algorithm so the saved Markdown matches the paragraphs visible in the transcript drawer; if that JSON is not reachable it falls back to a timing-gap heuristic, which approximates those paragraphs rather than reproducing them exactly. Works on any Substack publication's video posts that have a published transcript. No scraping of the rendered transcript drawer, no remote calls beyond the same CDN your browser already loads the video from. No telemetry, no third-party code.

<!-- END store Description field -->


## License

MIT.
