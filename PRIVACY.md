# Privacy & Permissions — Transcript Extractors

This repository ships a small family of Edge / Chrome extensions
(currently Stream and Substack, with more siblings planned). The same
privacy posture applies to every extension in the family:

* Each extension extracts the transcript from the page you are
  currently viewing and saves it locally as a `.vtt` or `.md` file.
  All processing happens inside your browser.
* The extension makes no requests to any third party. Its only network
  calls go to the same hosts the page you are looking at already
  loaded — Stream / SharePoint for the Stream extension, Substack's
  own CDN for the Substack extension — reusing the page's existing
  signed URLs or your existing cookies. So the extension cannot read
  anything you do not already have permission to view.
* No telemetry. No analytics. No account. No data shared with the
  publisher of the page or with the extension author. Nothing is
  stored between sessions.

Per-extension permission scopes are listed in the extension's own
README (under `extensions/<name>/README.md`).
