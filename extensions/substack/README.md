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
   tags) for the primary recording's VTT URL and speaker map. Podcast
   previews and sidebar posts are excluded, even when a preview shares
   the current post's ID.
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

## Transcript language / version

The popup lists the primary recording's published `signed_captions` variants
when Substack supplies them, including language codes. Choose a specific entry
to export it as either Markdown or WebVTT. Explicit choices use that caption
file, not the original-language `transcription.json`, so a translated selection
cannot silently export the original text. Preview and sidebar captions remain
excluded. An unavailable or partial explicit choice reports an error instead
of substituting another language or starting Whisper.
Explicit selections append the language code to the filename, for example
`My post-fr.md`, including when a custom basename is entered.

**Automatic** preserves the existing original-JSON-first Markdown path and
English/first-caption WebVTT preference. Open the popup again after navigating
to another post or when the site publishes new choices.

## Permissions

* `activeTab`, `scripting` — to inject the extractor when you click
  the button.
* `host_permissions: https://*.substack.com/*` — to run on any
  publication's post pages.
* `host_permissions: https://*.substackcdn.com/*` — to fetch the
  signed VTT from Substack's CDN.

## Install (developer mode)

From the repository root, run `pwsh .\scripts\prepare-extensions.ps1` first.

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
* Some posts publish captions only for a short podcast preview, not the
  full recording. Preview captions are excluded; the extension falls back to
  local Whisper for the full recording when the helper is installed.
* The signed VTT URL has a TTL; if extraction fails with "URL may have
  expired", just reload the page and try again.
* Audio-only podcast posts use a different rendering path and are not
  always transcribed by Substack. Published captions on a primary podcast
  upload are supported; preview-only captions are not used.

## Local fallback and default format

Markdown is the default; WebVTT remains selectable. Without a full published
transcript, **Extract & Download** asks before downloading and starting local
Whisper. The optional **Automatically transcribe when captions are unavailable**
checkbox remembers opt-in for this extension; it defaults off. Set up the
[native helper](../../tools/local-transcription/README.md) once. Jobs survive
closing the popup and save into Downloads. The player must have loaded its
full recording, and provider restrictions are not bypassed.

In addition to `activeTab`/`scripting`, the extension uses `nativeMessaging`
to contact the helper, `storage` for job status, and `alarms` for background
status updates. Published-transcript extraction does not require the helper.

## Regression tests

```pwsh
npm run test:substack
```

## License

MIT.
