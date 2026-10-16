# Spotify WIP handoff

This checkpoint preserves earlier extractor improvements and the initial Spotify
drafts. **It is not a Spotify release.** Import the checkpoint commit rather than
reconstructing the files. In another local worktree of this repository, Git
objects are shared but uncommitted files are not.

Preserve receiving-worktree changes. Stop on conflicts rather than overwriting
them. Do not access or modify the main checkout.

After importing, regenerate the ignored shared runtime copies:

```powershell
pwsh -NoProfile -File .\scripts\prepare-extensions.ps1
npm test
python -m unittest discover -s tools\local-transcription -p test_*.py
```

The canonical shared files are under `extensions\_shared`. Do not edit their
generated per-extension copies.

## Confirmed scope and implementation plan

The user chose: "Finish Spotify with shared foundations; defer broader features."

1. Keep four independent extensions. Finish Spotify with published transcripts
   first, Markdown default, optional WebVTT, timestamps and published speakers.
2. Add a small shared normalized transcript model and Markdown/WebVTT renderer
   for Spotify first. Include title, creator/show, canonical URL, platform, date,
   duration and language when available; timed segments with optional speakers;
   provenance distinguishing creator captions, provider-generated captions and
   local Whisper. Do not rewrite the three working extractors or change their
   output layouts.
3. Complete native public-feed resolution. After existing confirmation or
   default-off automatic opt-in, independently resolve exact Spotify metadata,
   find a unique publisher episode by show/title/date/duration, prefer supported
   full publisher RSS captions, otherwise download full public audio for local
   multilingual Whisper. No previews, unrelated description links, music tracks,
   protected-playback bypass, browser cookies or token exports.
4. Add regressions for matching, provenance, Unicode/Hebrew, both formats,
   malformed/empty/partial captions, ambiguous feeds, unsupported redirects,
   bounded downloads, full-audio checks, and cancellation/default-off behavior.
5. Finish icons, preparation/build packaging, helper installer and directly
   related documentation. Document Apple's directory lookup and bounded host
   support. Include any new shared renderer in preparation and packaging.
6. Verify real published extraction and, with consent, Hebrew fallback. Build
   and inspect the Spotify ZIP. Obtain approval before installing the new
   extension or changing persistent permissions. Clean temporary browser access.

Defer universal/merged extension, arbitrary-site capture, additional platforms,
library/indexing, side-panel reader, seek sync, corrections, diarization,
chapters, summaries, translation, Q&A, cloud transcription and richer exports.

## Current drafts and gaps

| Surface | State |
| --- | --- |
| `extensions\spotify\manifest.json`, `popup.html`, `popup.js` | Initial fourth extension. Reads loaded Spotify transcript component data in MAIN world, not credentials. Renderer is inline; shared document/export foundations are not implemented. |
| `extensions\spotify\tests\run.mjs` | Seven synthetic VM tests; no live extension export verification yet. |
| `extensions\_shared\transcription-worker.js` | Spotify resolver forwards only a canonical episode URL. Native helper independently resolves full public audio after consent. |
| `tools\local-transcription\podcast.py` | Draft public Spotify metadata, Apple directory, RSS matching, publisher VTT/SRT/JSON parsing, bounded HTTPS redirects/downloads. No dedicated podcast tests or live pipeline validation yet. |
| `tools\local-transcription\native_host.py` | Draft Spotify integration into durable jobs. Existing nine tests do not cover this new path. |
| `tools\local-transcription\install.ps1` | Copies podcast module; installed helper has not been refreshed for Spotify. |
| `scripts\prepare-extensions.ps1`, `package.json` | Spotify preparation/test entries added. |
| Spotify icons/README, root privacy/docs, release ZIP | Missing or incomplete. Manifest references icons not yet generated. |

The new Spotify shared-worker test appears nested inside the YouTube restriction
test in runner output; make it top-level. Review error reporting in RSS/caption
parsing: do not silently swallow malformed data or pretend access failures mean
captions are absent. Validate final cue timing. Coverage thresholds guard against
previews, not prove every word is present. Isolate fragile page-state inspection
and require exact current episode identity.

## Verified Spotify observations

### Published transcript example

`https://open.spotify.com/episode/2SrZHaBoktCM0hlfk8NObx`

- Crime Junkie, MISSING: Gregory 'Keith' Mann Jr., duration 1875.461 seconds.
- Signed-in Spotify exposes `[data-testid="transcript-tab"]` and
  `#transcript-panel`.
- Opening Transcript loads Spotify's own
  `/transcript-read-along/v2/episode/2SrZHaBoktCM0hlfk8NObx`.
- Observed payload: 508 sections, `startMs`, speaker `title.title`,
  `text.sentence.text`, highlights and final `musicClosedCaption.endMs`.
  Final music caption ends at 1874.880 seconds.
- Transcript component props contain exact `episodeUri` and `readAlongUrl`;
  a query hook contains `memoizedState.data.section`. The draft reads this
  already-loaded data only. React/internal shapes are unofficial and can change.
- DOM visible text alone was incomplete. Live extension export remains unverified.

### Fallback example

`https://open.spotify.com/episode/5w1J27rlNDSnyVXS6CFAxC`

- Hebrew, Tech and the City TLV, release 2025-03-17, duration 1889.232 seconds.
- Public script `#initialState` is base64 JSON. Exact episode metadata lives at
  `entities.items["spotify:episode:<id>"]`.
- Public Spotify audio/OG fields expose previews, not full audio.
  Description's YouTube link is theme music, not the episode.
- Apple podcast search found `https://anchor.fm/s/101b9ae54/podcast/rss`.
  Feed has exact episode title/date, duration `00:31:29`, full audio enclosure,
  and no published transcript for that item.
- Full download and Hebrew Whisper output remain unverified.

## Earlier dependencies included

Previous user requests implemented shared durable Windows native Whisper jobs,
Markdown defaults, default-off automatic fallback and consent, Substack
primary-media/full-transcript safeguards, Stream speakerless Clipchamp rows and
published API probe, badge acknowledgment/reset, and stale terminal-job race
protection. Preserve these; Spotify depends on them.

Before Spotify drafting, full Substack Whisper and Stream published extraction
were verified live, and the existing three installed extensions reloaded.
Existing release archives predate several later fixes and are stale.

## Checkpoint validation

During handoff preparation:

- `npm test`: 141 passing tests: YouTube 84, Substack 21, Stream 7, Spotify 7,
  shared 22.
- `python -m unittest discover -s tools\local-transcription -p test_*.py`:
  nine passing tests.
- `git diff --check`: clean.

These synthetic tests do not establish live Spotify or packaging readiness.
Do not commit real transcripts, authenticated URLs, credentials, browser
inspection output, media, or local helper configuration.

## Local setup and browser cleanup

Windows, PowerShell, Python, faster-whisper, yt-dlp and FFmpeg were available.
Helper is under `%LOCALAPPDATA%\TranscriptExtractor`; output uses Windows
Downloads known folder. Another host requires setup.

Existing Edge IDs:

- Stream: `npjpoodkbhghmljfoclmpncbfcmfeddd`
- Substack: `pikkjldhlmabepamobjpepclpjfdncgo`
- YouTube: `aiphmmjppmeohdfmlfoajigaaenhllkl`

Spotify is not installed. Helper retains older allowed origins; no origin cleanup
was requested.

Temporary signed-in Edge debugging was approved. Attached browser was detached
and isolated `spotify-inspect` closed. Unchecking debugging timed out; a later
reconnection was rejected but port 62334 still appeared to listen. Do not assume
debugging is off: verify the checkbox at `edge://inspect/#remote-debugging` with
the user before ending browser work. Do not close the user's browser.
