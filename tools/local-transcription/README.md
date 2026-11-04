# Local transcription helper

One Windows native-messaging helper serves the independent Stream, Substack,
and YouTube extensions. The extension tries published captions first and uses
this helper only when there is no usable published transcript. Markdown is the
default in all three popups.

## Setup

Install Python 3.10+ and use PowerShell 7. From the repository root:

```pwsh
.\scripts\prepare-extensions.ps1
# Load the desired extensions unpacked, then copy their IDs from the browser.
.\tools\local-transcription\install.ps1 -ExtensionId @('EXTENSION_ID') -Model small
# For multiple extensions, provide an array of IDs.
# For Chrome rather than Edge, add -Browser Chrome.
```

The installer installs missing Python dependencies, copies the host and
transcription code into `%LOCALAPPDATA%\TranscriptExtractor`, and registers
`com.transcript_extractor.local` under the current user's browser registry.
Registered IDs accumulate across installer runs; no administrator rights or
open network port is needed. Rerun the installer to update host code or change
the model. Run preparation and reload extensions after shared JavaScript changes.

Whisper's first use downloads model weights. `small` balances speed/accuracy;
`base` or `tiny` is faster, while `medium`/`large-v3` requires more resources.
`yt-dlp` downloads the best available audio-only stream, falling back to the
recording container if no audio-only rendition exists. It may need FFmpeg for
some sources; install FFmpeg on PATH and rerun setup if the downloader requests it.

## One button

Click **Extract & Download**. Published captions use the existing extractor.
If none exist, a confirmation offers **Download & Transcribe with Whisper** or
**Cancel** before any recording download or local job starts. Enable
**Automatically transcribe when captions are unavailable** to skip confirmation
on future extractions. This defaults off, is saved per extension, and does not
affect published-caption downloads or jobs already queued. Closing the popup
without confirming starts nothing.

After confirmation (or automatic opt-in), the background worker resolves the
full recording and queues a local job. The helper serializes jobs so extensions do not
load three Whisper models concurrently.

You can close the popup or browser after the audio URL has been handed to the
helper. The helper completes independently and writes the chosen `.md` or
`.vtt` into your Windows Downloads folder, adding a numeric suffix rather than
overwriting a file. Reopen the popup to check progress; badge `Done` means saved,
and `!` means inspect the popup for the error. Keep the source tab open while
the popup says it is finding the recording.
Opening the popup acknowledges and clears `Done` or `!`, while retaining the
result message. The `...` badge remains until an active job finishes.
Starting a new extraction dismisses previous completed/failed job status so
it cannot replace a published-transcript result. Active jobs are retained.

Generated transcripts include timestamps, but do not diarize or recover speaker
names. Published transcripts remain preferable for accuracy and speaker labels.

## Provider limits

* **Substack:** only the primary recording is used. The helper reuses its signed
  Mux manifest already loaded by the player, not a podcast-preview manifest.
  Let the player load first. Other direct recording URLs are resolved using the
  signed-in browser, subject to CORS and provider download restrictions.
* **YouTube:** creator captions are preferred over auto-generated tracks.
  Without readable captions, `yt-dlp` downloads the current video's public
  watch URL. Private, age-restricted, paid, or bot-blocked downloads can fail;
  no browser cookies or authentication credentials are exported.
* **Stream/SharePoint:** published transcripts still work in meeting recaps,
  including meetings without recordings. Local audio transcription requires
  a finite recording and a visible enabled **download link** with an HTTPS URL.
  A player blob alone is insufficient. A download button that doesn't expose a
  URL, sign-in-only URL, DRM, or organizational export restriction is reported
  rather than bypassed. Open the recording in Stream/SharePoint when starting
  from Teams.
* Live/unbounded streams are unsupported. Maximum recording duration is
  24 hours; download size is capped at 2 GB and download timeout is 30 minutes.
  Audio shorter than 90% of the expected recording (with two seconds tolerance)
  is rejected as a potential preview rather than silently transcribed.
* Resolution can take up to 20 seconds. After the queued confirmation, closing
  the popup does not interrupt the job. Interrupting resolution itself (for
  example restarting Edge before queuing) requires retrying.

Failures are shown in the popup; a failed local job never pretends it saved a
transcript. If you shut down Windows, an unfinished worker is detected when
status is read and the popup allows retrying. Provider changes can require
updating `yt-dlp` with `python -m pip install -U yt-dlp`.

## Privacy and cleanup

See [PRIVACY.md](../../PRIVACY.md). There is no listening HTTP service, cloud
transcription request, or telemetry. Signed URLs are used only for the selected
job and removed from request metadata on normal completion/failure. Model
weights stay in the standard Hugging Face cache. Job state is local and
per-extension; one extension cannot inspect another extension's job.

To uninstall, finish/stop outstanding jobs, remove the current-user registry key
`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.transcript_extractor.local`
(or `Google\Chrome`), and remove `%LOCALAPPDATA%\TranscriptExtractor`. This
does not delete output transcripts or Python/model dependencies.

## Development checks

```pwsh
npm test
npm run test:local
```

The tests exercise format defaults, resolver scoping, protected-media rejection,
native protocol framing, origin/job ownership, filename safety, and durable jobs.
Live transcription additionally requires a reachable recording and model weights.
