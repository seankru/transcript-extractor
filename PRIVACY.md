# Privacy & Permissions — Transcript Extractors

This repository ships a small family of Edge / Chrome extensions
(currently Stream, Substack, and YouTube, with more siblings planned). The same
privacy posture applies to every extension in the family:

* Each extension extracts the transcript from the page you are
  currently viewing and saves it locally as a `.vtt` or `.md` file.
  Published captions are processed inside your browser.
* For published transcripts, the only network
  calls go to the same hosts the page you are looking at already
  loaded — Stream / SharePoint for the Stream extension, Substack's
  own CDN for the Substack extension, or YouTube's timed-text endpoint
  for the YouTube extension — reusing the page's existing signed URLs
  or your existing cookies. So the extension cannot read anything you
  do not already have permission to view.
* With the optional local helper installed, a recording without published
  captions is downloaded from its provider/CDN and transcribed by local
  `faster-whisper`. Audio is not sent to Word, a cloud speech API, or the
  extension author. Model weights are downloaded from Hugging Face on first use.
  Before this fallback starts, the popup asks for confirmation unless you opt in
  with **Automatically transcribe when captions are unavailable**. This setting
  defaults off and is saved in each extension's local storage. Cancelling or
  closing an unconfirmed prompt starts no recording download or transcription job.
* The extensions communicate with the helper through browser native messaging,
  not an HTTP server. Only registered extension IDs can call it. The helper
  receives the selected recording URL, duration, source page and output name;
  browser cookies are not exported. Download access still depends on the
  provider. DRM, sign-in failures, and disabled downloads are not bypassed.
* Job status persists in extension-local storage and
  `%LOCALAPPDATA%\TranscriptExtractor\jobs`. Signed media URLs are retained only
  while their job runs, then removed from the request record on success/failure.
  Temporary audio is deleted when the worker exits normally. An interrupted
  process or machine shutdown may leave temporary audio; it can be removed from
  that job's `audio-*` directory after the worker has stopped.
* No telemetry, analytics, or transcription-service account. Output files,
  completion paths and job status remain on your PC until you remove them.

Per-extension permission scopes are listed in the extension's own
README (under `extensions/<name>/README.md`).
