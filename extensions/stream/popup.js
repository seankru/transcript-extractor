// Stream Transcript Extractor — popup logic
// Click "Extract & Download VTT" → inject extractAndDownload into the active
// SharePoint/Stream tab → scrape transcript pane → write a clean WebVTT file
// to Downloads via an anchor-click. No background script needed.

const statusEl = document.getElementById('status');
const filenameEl = document.getElementById('filename');
const extractBtn = document.getElementById('extract');

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', !!isError);
}

extractBtn.addEventListener('click', async () => {
  setStatus('Extracting\u2026 keep this popup open and stay on the tab.');
  extractBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus('No active tab.', true);
      extractBtn.disabled = false;
      return;
    }

    const format = (document.querySelector('input[name="format"]:checked')?.value) === 'vtt' ? 'vtt' : 'md';

    // Phase 0: if the user clicked from a calendar event peek, open its recap.
    // "View recap" lives in the outlook.office.com calendar iframe; clicking it
    // navigates the Teams frame to the correct occurrence.
    let openedFromEvent = false;
    try {
      const r0 = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: clickViewRecap
      });
      openedFromEvent = !!r0?.some(x => x?.result === true);
    } catch { /* no calendar frame / not permitted; continue */ }

    // Phase 1: on Teams, open the meeting's Recap → Transcript for the user and
    // read the meeting title + date/time (for a descriptive filename). No-op on
    // non-Teams pages and inside the transcript iframe.
    let teamsCtx = null;
    try {
      const prep = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: prepareTeamsContext,
        args: [openedFromEvent]
      });
      teamsCtx = prep?.map(x => x?.result).find(r => r && r.isTeams) || null;
    } catch { /* injection blocked or non-Teams; continue to extraction */ }

    const userName = filenameEl.value.trim() || null;
    const contextName = userName ? null : buildRecapName(teamsCtx);

    // Phase 2: extract from whichever frame actually holds the transcript.
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: extractAndDownload,
      args: [userName, format, contextName]
    });

    // Multiple frames may run; pick the first successful extraction.
    // Native-click counts as success even though we never see cue bytes.
    const success = results?.find(x => x?.result && !x.result.error && (x.result.cueCount > 0 || x.result.mode === 'native-click'))?.result;
    if (success) {
      let modeLine;
      if (success.mode === 'fetched') {
        if (success.via === 'recap-streamcontent') {
          modeLine = 'Source: Teams meeting recap transcript (Stream JSON, speakers preserved).\n';
        } else {
          modeLine = `Source: Stream's own transcript URL (matches the Download button).\n${success.sourceUrl ? success.sourceUrl + '\n' : ''}`;
        }
      } else if (success.mode === 'native-click') {
        modeLine = `Source: Stream's native Download \u2192 ${success.buttonLabel || 'Download as .vtt'}.\n`;
      } else {
        modeLine = 'Source: DOM scrape (approximate timing, no Stream cue GUIDs).\n';
        if (success.downloadBlockReason === 'transcript-only') {
          modeLine += 'This looks like a transcribed-only meeting (no recording), so Stream '
            + 'offered no Download button \u2014 scraped the transcript pane instead.\n';
        } else if (success.downloadBlockReason === 'dlp') {
          const lbl = success.sensitivityLabel ? ` (\u201C${success.sensitivityLabel}\u201D)` : '';
          modeLine += `Stream\u2019s Download was unavailable, likely due to a sensitivity/DLP `
            + `label${lbl}. Scraped the transcript pane as a backup. For Stream\u2019s `
            + `authoritative .vtt, re-label the item to one that permits export and run again.\n`;
        } else if (success.downloadBlockReason === 'download-failed') {
          modeLine += 'Stream\u2019s Download/API path was unavailable, so the transcript pane '
            + 'was scraped as a backup.\n';
        }
      }
      if (success.mode === 'native-click') {
        setStatus(modeLine + 'Browser is saving the .vtt to your Downloads folder.');
      } else {
        setStatus(
          modeLine +
          `Extracted ${success.cueCount} cues (${(success.byteCount / 1024).toFixed(1)} KB).\n` +
          `Covered up to ${success.coverage}.\n` +
          `Saved to Downloads as:\n${success.filename}`
        );
      }
    } else {
      // No frame succeeded. Surface the most informative error.
      const withRows = results?.find(x => x?.result?.rowCount > 0)?.result;
      const anyErr = results?.find(x => x?.result?.error)?.result;
      const r = withRows || anyErr;
      if (!withRows && results?.some(x => x.result?.canTranscribe)) {
        setStatus('No published transcript. Checking for a permitted recording download...');
        await localTranscription.start('stream', tab, format, userName || contextName);
      } else if (!r) {
        setStatus('No result returned from any frame.', true);
      } else {
        let msg = 'Error: ' + (r.error || 'Unknown failure');
        if (r.rowCount != null) msg += `\nRows found: ${r.rowCount}`;
        if (r.sampleTextContent) msg += `\nFirst row textContent (truncated):\n${r.sampleTextContent}`;
        if (r.sampleClasses) msg += `\nClasses inside first row:\n${r.sampleClasses}`;
        setStatus(msg, true);
        console.warn('[Stream Transcript Extractor] diagnostics:', results);
      }
    }
  } catch (err) {
    setStatus('Inject failed: ' + (err?.message || String(err)), true);
  }
  extractBtn.disabled = localTranscription.busy;
});

// ---------------------------------------------------------------------------
// Injected into the active tab's content world. Must be a single self-contained
// function (no outer-scope references) because chrome.scripting serializes it.
// ---------------------------------------------------------------------------
async function extractAndDownload(suggestedName, format, contextName) {
  format = (format === 'vtt') ? 'vtt' : 'md';
  contextName = contextName || null;
  function findRows() {
    return Array.from(document.querySelectorAll(
      '[class*="listItemWithSpeaker-"], [class*="listItemNoSpeaker-"]'
    ));
  }
  function findScroller(node) {
    let n = node;
    while (n) {
      const s = getComputedStyle(n);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && n.scrollHeight > n.clientHeight) return n;
      n = n.parentElement;
    }
    return document.scrollingElement;
  }
  function parseTime(t) {
    const p = t.split(':').map(Number);
    if (p.length === 2) return p[0] * 60 + p[1];
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    return null;
  }
  function vttTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = (s % 60).toFixed(3).padStart(6, '0');
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
  }
  // Strip Stream's screen-reader-only "<v Speaker> N minutes M seconds" repeat
  // and return the cue body text.
  function cleanCueText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[class*="screenReaderFriendlyHiddenTag"]').forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function timeFromAria(aria) {
    if (!aria) return null;
    const hh = aria.match(/(\d+)\s*hours?\s*(\d+)\s*minutes?\s*(\d+)\s*seconds?/i);
    if (hh) return `${String(+hh[1]).padStart(2, '0')}:${String(+hh[2]).padStart(2, '0')}:${String(+hh[3]).padStart(2, '0')}`;
    const mm = aria.match(/(\d+)\s*minutes?\s*(\d+)\s*seconds?/i);
    if (mm) return `${String(+mm[1]).padStart(2, '0')}:${String(+mm[2]).padStart(2, '0')}`;
    return null;
  }

  function extractRow(row) {
    // Canonical cue position: entryText carries aria-posinset 1..aria-setsize
    // (e.g. "3 / 1960"). This is stable across virtualised re-renders and is
    // the only reliable dedupe key — multiple rows can share a displayed
    // timestamp, and continuation rows (same speaker) have no timestamp of
    // their own.
    const entryTextEl = row.querySelector('[class*="entryText-"]');
    let pos = null;
    if (entryTextEl?.hasAttribute('aria-posinset')) {
      pos = Number(entryTextEl.getAttribute('aria-posinset'));
    } else {
      const idMatch = (row.id || '').match(/listItem-(\d+)/);
      if (idMatch) pos = Number(idMatch[1]) + 1;
    }

    // Timestamp — baseTimestamp wraps BOTH the sr-only spoken form
    // ("0 minutes 6 seconds") and the compact form ("0:06") for the first
    // row of a speaker block. Continuation rows have no baseTimestamp, but
    // their baseEntry's aria-label preserves the spoken timestamp.
    let time = null;
    const tsEl = row.querySelector('[class*="baseTimestamp-"], [data-testid="timestamp-button"], [class*="leftColumnTimestamp-"]');
    if (tsEl) {
      const tsMatch = (tsEl.textContent || '').match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
      if (tsMatch) time = tsMatch[1];
    }
    if (!time) {
      const baseEntry = row.querySelector('[class*="baseEntry-"]');
      if (baseEntry) time = timeFromAria(baseEntry.getAttribute('aria-label'));
    }

    // Speaker — itemDisplayName is the speaker label; fall back to scrubbed
    // header. Continuation rows have no speaker block; that's filled in
    // afterwards by inheriting from the nearest preceding row that had one.
    let speaker = '';
    const displayEl = row.querySelector('[class*="itemDisplayName-"]');
    if (displayEl) {
      speaker = (displayEl.textContent || '').replace(/\s+/g, ' ').trim();
    } else {
      const header = row.querySelector('[class*="itemHeader-"]');
      if (header) {
        let h = (header.textContent || '').replace(/\s+/g, ' ').trim();
        h = h.replace(/\b\d+\s+(?:minute|minutes|second|seconds)(?:\s+\d+\s+(?:second|seconds))?\b/g, '');
        h = h.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '');
        speaker = h.replace(/\s+/g, ' ').trim();
      }
    }

    // Cue text — entryText is the spoken transcript line. baseEntry is the
    // container (sr-only label + entryText); rightColumn minus header is the
    // last-resort fallback if Stream renames entryText/baseEntry.
    let text = '';
    if (entryTextEl) {
      text = cleanCueText(entryTextEl);
    }
    if (!text) {
      const baseEntryEl = row.querySelector('[class*="baseEntry-"]');
      if (baseEntryEl) text = cleanCueText(baseEntryEl);
    }
    if (!text) {
      const rightCol = row.querySelector('[class*="rightColumn-"]');
      if (rightCol) {
        const clone = rightCol.cloneNode(true);
        clone.querySelectorAll('[class*="itemHeader-"]').forEach(n => n.remove());
        clone.querySelectorAll('[class*="screenReaderFriendlyHiddenTag"]').forEach(n => n.remove());
        text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      }
    }

    text = text.replace(/\s+Speaker \d+ stopped transcription\s*/g, ' ').trim();

    if (!text || pos == null) return null;
    return { pos, time, speaker, text };
  }

  // Whether the transcript pane is genuinely open — i.e. at least one
  // speaker row is actually rendered and on-screen. We deliberately do NOT
  // gate this on the in-pane Download trigger: transcript-only meetings
  // (transcribed but never recorded) and items under a sensitivity/DLP label
  // render the cue list while withholding the Download button. Closing the
  // pane removes the rows from layout (0-size bounding box), so a visibility
  // check still distinguishes "open" from "stale rows left in the DOM".
  function isTranscriptPaneOpen() {
    return findRows().some(r => {
      const rect = r.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  // Narrower check used only by the native-download tier: is the in-pane
  // Download trigger present, enabled, and visible? A disabled trigger is the
  // clearest signal that a sensitivity/DLP policy is withholding export.
  function hasUsableDownloadTrigger() {
    const btn = document.getElementById('downloadTranscript');
    if (!btn) return false;
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
    const r = btn.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Best-effort: surface the active sensitivity label name (if the page shows
  // one) so a "re-label to enable export" hint can name it. Returns null when
  // no recognizable label pill is present.
  function findSensitivityLabel() {
    const sel = [
      '[aria-label*="Sensitivity" i]',
      '[data-automationid*="Sensitivity" i]',
      '[class*="sensitivityLabel" i]',
      '[class*="SensitivityLabel" i]'
    ].join(',');
    let el = null;
    try { el = document.querySelector(sel); } catch { el = null; }
    if (!el) return null;
    const raw = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!raw) return null;
    return raw.replace(/^sensitivity[:\s-]*/i, '').trim() || raw;
  }

  if (!isTranscriptPaneOpen()) {
    // The user clicked while on Stream but with the transcript pane closed.
    // Try to open it for them; the helper waits for rows to render. Only
    // surface a "please open it manually" error if that fails (e.g. on a
    // page that genuinely has no transcript).
    await ensureTranscriptOpen();
  }
  if (!isTranscriptPaneOpen()) {
    // Rows may still be rendering — e.g. a Teams recap transcript that was just
    // revealed by auto-navigation and is loading in a nested frame. Give the
    // viewer up to ~12s to paint before giving up.
    for (let i = 0; i < 60 && !isTranscriptPaneOpen(); i++) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  if (!isTranscriptPaneOpen()) {
    const published = await tryFetchTranscriptViaApi();
    if (published) return finishFetched(published);
    return { canTranscribe: true, error: 'No published transcript rows or accessible transcript resource found. Local transcription requires a recording with downloading permitted.' };
  }

  // Capture the state of the authoritative download path up front, before we
  // interact with it, so a DOM-scrape fallback can explain WHY it fell back
  // (transcript-only vs sensitivity/DLP block) and suggest re-labeling.
  const downloadTrigger = document.getElementById('downloadTranscript');
  const downloadTriggerPresent = !!downloadTrigger;
  const downloadTriggerDisabled = !!downloadTrigger &&
    (downloadTrigger.disabled || downloadTrigger.getAttribute('aria-disabled') === 'true');
  const sensitivityLabel = findSensitivityLabel();

  // -----------------------------------------------------------------------
  // Best path: drive the transcript pane's Download button and pick the
  // "Download as .vtt" sub-menu item. Native download is byte-for-byte
  // authoritative; we can't capture the bytes ourselves once the browser
  // starts streaming the file, but for our purposes that's the right
  // outcome — the user gets the real .vtt in their Downloads folder.
  //
  // IMPORTANT: Stream has TWO buttons labelled "Download":
  //   - Top command bar (data-automationid="downloadCommand") — downloads
  //     the MP4 (with a "video only" confirmation dialog). NOT what we want.
  //   - Transcript pane (no automationId, has ms-Button--hasMenu, opens a
  //     contextual menu with "Download as .docx" / "Download as .vtt").
  //     This is the one we want.
  // -----------------------------------------------------------------------
  function findTranscriptNavButton() {
    // Right-side nav button that opens the transcript pane.
    return Array.from(document.querySelectorAll('button[aria-label="Transcript"]'))
      .find(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }) || null;
  }

  async function ensureTranscriptOpen() {
    // "Open" = at least one transcript row is visible on-screen. We rely on
    // row visibility rather than the #downloadTranscript trigger because the
    // trigger is absent on transcript-only meetings and can be withheld by a
    // sensitivity/DLP label even when the cue list renders fine.
    if (isTranscriptPaneOpen()) return true;
    const nav = findTranscriptNavButton();
    if (!nav) return false;
    nav.click();
    // Wait for the pane to actually render at least one visible row.
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (isTranscriptPaneOpen()) {
        // One last settle so virtualization can paint the first viewport.
        await new Promise(r => setTimeout(r, 500));
        return true;
      }
    }
    return isTranscriptPaneOpen();
  }

  function findMenuTrigger() {
    // Transcript-pane Download. The stable hook is id="downloadTranscript"
    // (verified in production DOM). Fall back to attribute filters in case
    // Stream renames the id: aria-label="Download", visible, NOT the top
    // command-bar one (which has data-automationid="downloadCommand").
    const byId = document.getElementById('downloadTranscript');
    if (byId) {
      const r = byId.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && !byId.disabled) return byId;
    }
    const candidates = Array.from(document.querySelectorAll('button[aria-label="Download"], [role="button"][aria-label="Download"]'))
      .filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true')
      .filter(el => el.getAttribute('data-automationid') !== 'downloadCommand')
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    const withMenu = candidates.find(el =>
      el.classList.contains('ms-Button--hasMenu')
      || el.getAttribute('aria-haspopup') === 'menu'
      || el.getAttribute('aria-haspopup') === 'true');
    return withMenu || candidates[0] || null;
  }

  function findVttMenuItem() {
    // Once the Download menu opens, two items appear with role="menuitem":
    // "Download as .vtt" and "Download as .docx". Aria-label is the
    // authoritative selector — text-content match is a fallback.
    const directAria = document.querySelector('[role="menuitem"][aria-label="Download as .vtt"]')
      || document.querySelector('[role="menuitem"][aria-label="Download as VTT"]');
    if (directAria) return directAria;
    const items = Array.from(document.querySelectorAll('[role="menuitem"], button.ms-ContextualMenu-link'));
    return items.find(el => {
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const txt = (el.textContent || '').toLowerCase();
      return /download.*\.?vtt/.test(aria) || /download.*\.?vtt/.test(txt);
    }) || null;
  }

  async function tryNativeDownload() {
    const paneOpen = await ensureTranscriptOpen();
    if (!paneOpen) return null;
    // The menu may already be open (we double-checked beforehand) — try
    // the item first before clicking the trigger again.
    let item = findVttMenuItem();
    if (!item) {
      const trigger = findMenuTrigger();
      if (!trigger) return null;
      trigger.click();
      for (let i = 0; i < 40 && !item; i++) {
        await new Promise(r => setTimeout(r, 80));
        item = findVttMenuItem();
      }
    }
    if (!item) {
      return { triggered: false, error: 'Found Download trigger but no .vtt menu item appeared.' };
    }
    const label = (item.getAttribute('aria-label') || item.textContent || '').trim();
    item.click();
    return { triggered: true, label };
  }

  // Teams recap: prefer the self-named fetch path over the site-named native
  // download so the saved file carries our descriptive meeting name.
  // (finishFetched / tryFetchTranscriptViaApi / saveFile are hoisted below.)
  if (contextName) {
    const fetchedEarly = await tryFetchTranscriptViaApi();
    if (fetchedEarly) return finishFetched(fetchedEarly);
  }

  // Native download produces a .vtt straight to the Downloads folder. We
  // can't intercept it for in-page format conversion, so skip it when the
  // user has asked for Markdown — let the fetch / scrape path own that case.
  // We also skip it for Teams recaps (contextName set): the native download is
  // named by the site (often just "transcript.vtt") and we want our own name.
  let nativeResult = null;
  if (format !== 'md' && !contextName) {
    nativeResult = await tryNativeDownload();
    if (nativeResult?.triggered) {
      return {
        mode: 'native-click',
        format,
        buttonLabel: nativeResult.label,
        cueCount: 0,
        byteCount: 0,
        coverage: 'native Stream download triggered',
        filename: '(saved by Stream\u2019s native download \u2014 check your Downloads folder)'
      };
    }
  }

  // -----------------------------------------------------------------------
  // Next best: pull the canonical transcript through Stream's own
  // SharePoint Drive API endpoint. This is the same network resource the
  // page already loads when the transcript pane opens — we just refetch it
  // from the page context using the user's existing cookies.
  // -----------------------------------------------------------------------
  async function tryFetchTranscriptViaApi() {
    let entries = [];
    try { entries = performance.getEntriesByType('resource') || []; } catch {}

    // Teams meeting recaps (and transcribed-only meetings) load the canonical
    // transcript JSON directly from a streamContent endpoint rather than via the
    // video media-metadata call. Detect that URL and refetch it credentialed —
    // it returns the same speakered JSON schema (entries[] with startOffset /
    // endOffset / speakerDisplayName / text) that transcriptJsonToVtt renders.
    const recapJsonUrl = entries
      .map(e => e.name || '')
      .find(u => /\/media\/transcripts\/[^/]+\/streamContent\?[^"]*format=json/i.test(u))
      || entries
        .map(e => e.name || '')
        .find(u => /\/cdnmedia\/transcripts\?[^"]*isformatjson=true/i.test(u));
    if (recapJsonUrl) {
      try {
        const rr = await fetch(recapJsonUrl, { credentials: 'include' });
        if (rr.ok) {
          const data = await rr.json();
          if (data && Array.isArray(data.entries) && data.entries.length > 0) {
            return { kind: 'json', data, url: recapJsonUrl, via: 'recap-streamcontent' };
          }
        }
      } catch { /* fall through to metadata / legacy probe paths */ }
    }

    // On page load, Stream fetches the video's media metadata via a
    //   /_api/v2.1/drives/{driveId}/items/{itemId}?select=media%2Ftranscripts...
    // call. The response includes media.transcripts[] where each entry
    // exposes a short-lived temporaryDownloadUrl. Refetching that metadata
    // gives us fresh tempauth tokens. The same endpoint serves *two*
    // content variants from the same temporary URL:
    //   - default (no ?format)     -> WebVTT body, speaker tags stripped
    //   - ?format=json             -> canonical Stream transcript JSON
    //                                 (schema http://stream.office.com/schemas/transcript.json,
    //                                 includes speakerDisplayName + offsets)
    // The JSON variant is the preferred source because it carries the
    // speaker labels that the VTT projection drops. We fall back to the
    // plain VTT if JSON is somehow blocked.
    const metaUrl = entries
      .map(e => e.name || '')
      .find(u => /\/_api\/v2\.1\/drives\/[^/]+\/items\/[^?]+\?[^"]*select=media(%2[Ff]|\/)transcripts/i.test(u));
    if (metaUrl) {
      try {
        const metaResp = await fetch(metaUrl, { credentials: 'include' });
        if (metaResp.ok) {
          const meta = await metaResp.json();
          const list = (meta && meta.media && meta.media.transcripts) || [];
          const t =
            list.find(x => x && x.isDefault && x.isVisible && x.temporaryDownloadUrl) ||
            list.find(x => x && x.isVisible && x.temporaryDownloadUrl) ||
            list.find(x => x && x.temporaryDownloadUrl);
          if (t && t.temporaryDownloadUrl) {
            // Preferred: JSON variant (speakered).
            try {
              const ju = new URL(t.temporaryDownloadUrl);
              ju.searchParams.set('format', 'json');
              const jr = await fetch(ju.toString(), { credentials: 'include' });
              if (jr.ok) {
                const data = await jr.json();
                if (data && Array.isArray(data.entries) && data.entries.length > 0) {
                  return { kind: 'json', data, url: ju.toString(), languageTag: t.languageTag, via: 'metadata-json' };
                }
              }
            } catch { /* fall through to raw VTT */ }

            // Fallback: raw VTT (speaker-less for Stream-hosted transcripts).
            try {
              const vr = await fetch(t.temporaryDownloadUrl, { credentials: 'include' });
              if (vr.ok) {
                const body = await vr.text();
                if (typeof body === 'string' && /^\uFEFF?WEBVTT/.test(body)) {
                  return { kind: 'vtt', body, url: t.temporaryDownloadUrl, languageTag: t.languageTag, via: 'metadata-vtt' };
                }
              }
            } catch { /* nothing more to try at this URL */ }
          }
        }
      } catch { /* fall through to legacy resource probing */ }
    }

    // -----------------------------------------------------------------
    // Legacy path: probe any resource the page has already loaded that
    // looks like a VTT (older Stream surfaces / non-SharePoint hosts).
    // -----------------------------------------------------------------
    const candidates = [];
    const seenUrls = new Set();
    for (const e of entries) {
      const u = e.name || '';
      if (!u || seenUrls.has(u)) continue;
      const lower = u.toLowerCase();
      const looksLikeVtt =
        lower.endsWith('.vtt') ||
        lower.includes('.vtt?') ||
        lower.includes('/transcripts/') ||
        lower.includes('transcript=') ||
        lower.includes('/captions/') ||
        lower.includes('format=vtt') ||
        lower.includes('format%3dvtt');
      if (looksLikeVtt) { candidates.push(u); seenUrls.add(u); }
    }
    for (const url of candidates) {
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) continue;
        const body = await resp.text();
        if (typeof body === 'string' && /^\uFEFF?WEBVTT/.test(body)) {
          return { kind: 'vtt', body, url, via: 'resource-probe' };
        }
      } catch { /* try the next candidate */ }
    }
    return null;
  }

  function transcriptOffsetToVttTime(off) {
    // Stream JSON offsets look like "00:00:04.7084659" (hundred-nanosecond
    // precision). VTT requires HH:MM:SS.mmm. Truncate fractional seconds
    // to milliseconds without rounding so we don't accidentally collide
    // with a neighbouring cue's start.
    const m = String(off || '').match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
    if (!m) return null;
    const ms = String(m[4] || '').slice(0, 3).padEnd(3, '0');
    return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}.${ms}`;
  }

  function transcriptOffsetToShortTime(off) {
    const m = String(off || '').match(/^(\d{1,2}):(\d{2}):(\d{2})/);
    return m ? `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}` : null;
  }

  function transcriptJsonToVtt(json) {
    // Render Stream's canonical transcript JSON as WebVTT with <v Speaker>
    // tags preserved. One cue per JSON entry (Stream's UI further splits
    // long entries into multiple display sub-cues; we don't reproduce that
    // because it isn't exposed in the JSON, but the word content is identical).
    let out = 'WEBVTT\n\n';
    const entries = Array.isArray(json && json.entries) ? json.entries : [];
    for (const e of entries) {
      const start = transcriptOffsetToVttTime(e.startOffset);
      const end = transcriptOffsetToVttTime(e.endOffset);
      if (!start || !end) continue;
      const speaker = (e.speakerDisplayName || '').trim();
      const text = (e.text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      if (!text) continue;
      const id = e.id || '';
      const speakerOpen = speaker ? `<v ${speaker}>` : '';
      const speakerClose = speaker ? `</v>` : '';
      if (id) out += `${id}\n`;
      out += `${start} --> ${end}\n${speakerOpen}${text}${speakerClose}\n\n`;
    }
    return out;
  }

  function transcriptJsonToMarkdown(json) {
    // Group consecutive entries from the same speaker into one paragraph,
    // matching how Stream's pane renders speaker "turns". This produces a
    // much more readable .md than one line per cue.
    const out = ['# Transcript', ''];
    const entries = Array.isArray(json && json.entries) ? json.entries : [];
    let buf = null;
    function flush() {
      if (!buf) return;
      const speakerPrefix = buf.speaker ? ` **${buf.speaker}:**` : '';
      const text = buf.text.join(' ').replace(/\s+/g, ' ').trim();
      if (text) out.push(`**[${buf.start}]**${speakerPrefix} ${text}`, '');
      buf = null;
    }
    for (const e of entries) {
      const start = transcriptOffsetToShortTime(e.startOffset);
      if (!start) continue;
      const speaker = (e.speakerDisplayName || '').trim();
      const text = (e.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (!buf || buf.speaker !== speaker) { flush(); buf = { speaker, start, text: [text] }; }
      else { buf.text.push(text); }
    }
    flush();
    return out.join('\n');
  }

  function vttToMarkdown(vttBody) {
    // Convert WebVTT into a readable Markdown transcript. Each cue
    // becomes a paragraph prefixed with **[HH:MM:SS]** plus the speaker
    // (if a <v Speaker> tag is present). Cue IDs and NOTE blocks are
    // dropped. We tolerate both CRLF (Stream's served VTT) and LF input.
    const out = ['# Transcript', ''];
    const normalised = String(vttBody).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
    const blocks = normalised.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length === 0) continue;
      if (/^WEBVTT/.test(lines[0])) continue;
      if (/^NOTE\b/.test(lines[0])) continue;
      let timing = null;
      let speaker = null;
      const textParts = [];
      for (const l of lines) {
        const tm = l.match(/^(\d{1,2}:\d{2}:\d{2})(?:\.\d+)?\s+-->/);
        if (tm) { timing = tm[1]; continue; }
        if (/-->/.test(l)) continue;
        // Cue-ID line: only word chars, slashes, hyphens. Skip.
        if (/^[\w\/-]+$/.test(l)) continue;
        const vMatch = l.match(/^<v\s+([^>]+)>(.*)$/);
        if (vMatch) {
          speaker = vMatch[1].trim();
          textParts.push(vMatch[2].replace(/<\/v>\s*$/, '').trim());
        } else {
          textParts.push(l.replace(/<\/?v[^>]*>/g, '').trim());
        }
      }
      const text = textParts.filter(Boolean).join(' ').trim();
      if (!timing || !text) continue;
      const speakerPrefix = speaker ? ` **${speaker}:**` : '';
      out.push(`**[${timing}]**${speakerPrefix} ${text}`, '');
    }
    return out.join('\n');
  }

  function saveFile(body, baseName, ext, mime, contextName) {
    const extension = (ext || '.vtt').toLowerCase();
    const mimeType = mime || (extension === '.md' ? 'text/markdown' : 'text/vtt');
    let filename = baseName;
    if (!filename) {
      let title = (document.title || '')
        .replace(/\s*-\s*Microsoft Stream$/i, '')
        .replace(/\s*\.mp4$/i, '')
        .trim();
      // Ignore generic viewer titles (e.g. a Teams recap iframe titled just
      // "Transcript"/"OneTranscript") so we can fall back to the meeting name.
      if (!title || /^(one)?transcript(\.(vtt|md|txt))?$/i.test(title)) title = '';
      if (!title && contextName) title = String(contextName);
      title = (title || 'transcript').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
      filename = title || 'transcript';
    }
    // Strip any existing recognized extension so we control it.
    filename = filename.replace(/\.(vtt|md|txt)$/i, '');
    filename += extension;
    const blob = new Blob([body], { type: mimeType });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 1500);
    return filename;
  }

  function finishFetched(fetched) {
    let payload, ext, cueCount;
    if (fetched.kind === 'json') {
      cueCount = (fetched.data && Array.isArray(fetched.data.entries)) ? fetched.data.entries.length : 0;
      payload = (format === 'md') ? transcriptJsonToMarkdown(fetched.data) : transcriptJsonToVtt(fetched.data);
      ext = (format === 'md') ? '.md' : '.vtt';
    } else { // kind === 'vtt' (raw, speaker-less)
      cueCount = (fetched.body.match(/-->/g) || []).length;
      payload = (format === 'md') ? vttToMarkdown(fetched.body) : fetched.body;
      ext = (format === 'md') ? '.md' : '.vtt';
    }
    const filename = saveFile(payload, suggestedName, ext, undefined, contextName);
    return {
      mode: 'fetched',
      format,
      via: fetched.via,
      sourceUrl: fetched.url,
      cueCount,
      byteCount: payload.length,
      coverage: 'full file from Stream',
      filename
    };
  }

  const fetched = await tryFetchTranscriptViaApi();
  if (fetched) return finishFetched(fetched);

  // -----------------------------------------------------------------------
  // Fallback: DOM scrape with aggressive scroll-and-rescan. Stream
  // virtualizes the transcript pane, so rows render only when scrolled into
  // view; we have to walk the whole list and collect cues by canonical
  // aria-posinset position. Stagnation budget is generous because
  // virtualization can be slow on long recordings.
  // -----------------------------------------------------------------------
  const anchorRows = findRows();
  const scroller = findScroller(anchorRows[0]?.parentElement) || document.scrollingElement;
  scroller.scrollTop = 0;
  await new Promise(r => setTimeout(r, 800));

  // Total cue count (aria-setsize on any entryText element).
  const setSize = (() => {
    const sample = document.querySelector('[class*="entryText-"][aria-setsize]');
    return sample ? Number(sample.getAttribute('aria-setsize')) : null;
  })();

  // Dedupe by aria-posinset (stable 1..N cue position).
  const seen = new Map();
  function scanOnce() {
    for (const row of findRows()) {
      const c = extractRow(row);
      if (!c || !c.text || c.pos == null) continue;
      const ex = seen.get(c.pos);
      if (!ex || c.text.length > ex.text.length) seen.set(c.pos, c);
    }
  }

  const STAGNANT_LIMIT = 25;
  const MAX_ITER = 4000;
  const STEP_WAIT_MS = 400;

  let stagnant = 0;
  let atBottom = 0;
  for (let i = 0; i < MAX_ITER; i++) {
    const before = seen.size;
    scanOnce();
    stagnant = (seen.size === before) ? stagnant + 1 : 0;
    if (setSize && seen.size >= setSize) break;
    if (stagnant >= STAGNANT_LIMIT) break;

    const beforeScroll = scroller.scrollTop;
    scroller.scrollBy(0, Math.max(80, scroller.clientHeight * 0.5));
    await new Promise(r => setTimeout(r, STEP_WAIT_MS));
    if (scroller.scrollTop === beforeScroll) {
      atBottom++;
      // Give virtualization a few more chances at the bottom; then loop
      // back to the top and ride down once more to catch any rows we
      // raced past.
      if (atBottom > 6) {
        scroller.scrollTop = 0;
        await new Promise(r => setTimeout(r, 800));
        atBottom = 0;
      }
    } else {
      atBottom = 0;
    }
  }

  // Final settle pass: jam to the bottom, wait, re-scan; then jam to the
  // top, wait, re-scan, so any rows the virtualizer reclaimed at the head
  // get a chance to be re-rendered and picked up.
  scroller.scrollTop = scroller.scrollHeight;
  await new Promise(r => setTimeout(r, 1500));
  scanOnce();
  scroller.scrollTop = 0;
  await new Promise(r => setTimeout(r, 1500));
  scanOnce();
  scroller.scrollTop = scroller.scrollHeight;
  await new Promise(r => setTimeout(r, 1500));
  scanOnce();

  if (seen.size === 0) {
    // Return diagnostic info so the user can paste it back for selector debugging.
    const sample = findRows()[0];
    const sampleClasses = sample
      ? Array.from(sample.querySelectorAll('*'))
          .map(el => (typeof el.className === 'string' ? el.className : ''))
          .filter(Boolean)
          .slice(0, 30)
          .join(' | ')
          .slice(0, 600)
      : '';
    const sampleTextContent = sample ? (sample.textContent || '').slice(0, 400) : '';
    return {
      error: 'Found rows but extracted 0 cues. Selectors may have changed (Stream UI update?).',
      rowCount: findRows().length,
      sampleClasses,
      sampleTextContent
    };
  }

  // Sort by canonical position. Inherit speaker from the most-recent
  // preceding cue when this one is a continuation row (no speaker block).
  // Also forward-fill any missing timestamps from the preceding cue (rare,
  // but baseEntry aria-label is the usual fallback so this is belt-and-
  // braces). Drop any cues that still lack a parseable timestamp at the
  // end (would corrupt VTT output).
  const cues = Array.from(seen.values()).sort((a, b) => a.pos - b.pos);
  let lastSpeaker = '';
  let lastTime = null;
  for (const c of cues) {
    if (c.speaker) lastSpeaker = c.speaker;
    else c.speaker = lastSpeaker;
    if (c.time && parseTime(c.time) !== null) lastTime = c.time;
    else if (lastTime) c.time = lastTime;
  }
  const cuesForVtt = cues.filter(c => c.time && parseTime(c.time) !== null);
  if (!cuesForVtt.length) {
    return { error: 'Transcript rows were found, but no readable timestamps could be extracted.',
      rowCount: seen.size };
  }

  let vtt = 'WEBVTT\n\n';
  for (let i = 0; i < cuesForVtt.length; i++) {
    const start = parseTime(cuesForVtt[i].time);
    const next = i + 1 < cuesForVtt.length ? parseTime(cuesForVtt[i + 1].time) : null;
    const end = next !== null ? Math.max(start + 0.5, next - 0.01) : start + 5;
    const txt = (cuesForVtt[i].text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const speakerOpen = cuesForVtt[i].speaker ? `<v ${cuesForVtt[i].speaker}>` : '';
    const speakerClose = cuesForVtt[i].speaker ? `</v>` : '';
    // Stream's real VTT uses GUID/<idx> cue IDs we can't reproduce from the
    // DOM — emit a numeric ID so the line is present (structural diff lines
    // up) without claiming to match Stream's identifiers.
    vtt += `scrape-${i + 1}\n${vttTime(start)} --> ${vttTime(end)}\n${speakerOpen}${txt}${speakerClose}\n\n`;
  }

  let payload, ext;
  if (format === 'md') {
    payload = vttToMarkdown(vtt);
    ext = '.md';
  } else {
    payload = vtt;
    ext = '.vtt';
  }
  const filename = saveFile(payload, suggestedName, ext, undefined, contextName);

  // Explain why the DOM scrape was used instead of Stream's authoritative
  // download, so the popup can prompt a re-label (DLP) or note the
  // transcript-only case.
  let downloadBlockReason;
  if (!downloadTriggerPresent) {
    downloadBlockReason = 'transcript-only';
  } else if (downloadTriggerDisabled) {
    downloadBlockReason = 'dlp';
  } else if (sensitivityLabel && nativeResult && nativeResult.triggered === false) {
    downloadBlockReason = 'dlp';
  } else {
    downloadBlockReason = 'download-failed';
  }

  return {
    mode: 'scraped',
    format,
    cueCount: cuesForVtt.length,
    byteCount: payload.length,
    coverage: cuesForVtt.length > 0 ? vttTime(parseTime(cuesForVtt[cuesForVtt.length - 1].time)) : '00:00:00.000',
    filename,
    downloadBlockReason,
    sensitivityLabel
  };
}

// ---------------------------------------------------------------------------
// Injected into every frame; only acts in the calendar event peek (hosted on
// outlook.office.com) where a "View recap" button opens the meeting recap in
// the Teams frame. Returns true if it clicked. Self-contained (serialized).
// ---------------------------------------------------------------------------
function clickViewRecap() {
  const btn = Array.from(document.querySelectorAll('button, [role="button"]'))
    .find(el => /^view\s*recap$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim()));
  if (!btn) return false;
  const r = btn.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  btn.click();
  return true;
}

// ---------------------------------------------------------------------------
// Injected into every frame; only does work in the Teams top frame. Opens the
// meeting's Recap tab and Transcript pill (so the SharePoint transcript iframe
// loads) and returns the meeting title + date/time so the popup can build a
// descriptive filename. Returns null on non-Teams pages and inside the iframe.
// Must be self-contained (serialized by chrome.scripting).
// ---------------------------------------------------------------------------
async function prepareTeamsContext(openedFromEvent) {
  const host = location.hostname || '';
  if (!/teams\.(cloud\.microsoft|microsoft\.com)/i.test(host)) return null;

  const q = sel => document.querySelector(sel);
  const isSelected = el => !!el &&
    (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true');

  // When we arrived here by clicking "View recap" from a calendar event, the
  // recap surface loads asynchronously in this frame — wait for a recap signal
  // (header, Transcript pill, or recap tab) before deciding what to do.
  const recapSignal = () => q('[data-tid="intelligent-recap-header"]')
    || q('button[data-tid="Transcript"]')
    || q('[data-tid="tab-item-com.microsoft.chattabs.recap"]');
  if (openedFromEvent) {
    for (let i = 0; i < 60 && !recapSignal(); i++) {
      await new Promise(r => setTimeout(r, 150));
    }
  }

  const recapTab = q('[data-tid="tab-item-com.microsoft.chattabs.recap"]');
  const isRecapContext = !!recapSignal() || !!q('[data-tid="chat-title"]');
  if (!isRecapContext) return null;

  let navigated = false;
  let openedRecapTab = false;

  // 1) Open the Recap tab if it isn't already active.
  if (recapTab && !isSelected(recapTab)) {
    recapTab.click();
    navigated = true;
    openedRecapTab = true;
    for (let i = 0; i < 50 && !q('[data-tid="intelligent-recap-header"]'); i++) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // 1b) Recurring meetings expose a "Select the meeting by time" dropdown whose
  //     options are most-recent-first. When WE opened the recap from the chat
  //     tab, Teams may default to an older occurrence, so pick the most recent.
  //     If the recap was already open (the user chose an instance, or arrived
  //     via a specific event's "View recap"), leave the selection untouched.
  if (openedRecapTab) {
    const combo = document.querySelector('button[role="combobox"][aria-label="Select the meeting by time"]');
    if (combo) {
      combo.click();
      let options = [];
      for (let i = 0; i < 20 && options.length === 0; i++) {
        await new Promise(r => setTimeout(r, 100));
        options = Array.from(document.querySelectorAll('[role="option"]'))
          .filter(o => /\b20\d{2}\b/.test(o.textContent || ''));
      }
      const current = options.find(o => o.getAttribute('aria-selected') === 'true');
      const mostRecent = options[0];
      if (mostRecent && mostRecent !== current) {
        mostRecent.click();
        navigated = true;
        // Wait for the recap to reload for the newly selected occurrence.
        await new Promise(r => setTimeout(r, 1200));
      } else {
        combo.click(); // close the dropdown without changing anything
      }
    }
  }

  // 2) Select the Transcript pill. This loads the SharePoint transcript in a
  //    nested (out-of-process) frame that is NOT queryable from this top-frame
  //    DOM, so we can't detect it here — we just click if it isn't already
  //    selected and let phase 2 wait for the rows to render.
  const pill = q('button[data-tid="Transcript"]') ||
    Array.from(document.querySelectorAll('[role="tab"], button'))
      .find(el => /^transcript$/i.test((el.textContent || '').trim()));
  if (pill && !isSelected(pill)) {
    pill.click();
    navigated = true;
  }

  // 3) Give the transcript a moment to begin loading before phase 2 injects.
  await new Promise(r => setTimeout(r, navigated ? 1500 : 400));

  // 4) Meeting context for the filename. Prefer the chat title element (chat
  //    view); fall back to the document title (calendar / event-opened recap,
  //    which reads "(N) Calendar | <Meeting Name> | Microsoft Teams").
  const titleEl = q('[data-tid="chat-title"]');
  let meetingTitle = titleEl ? (titleEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
  if (!meetingTitle) {
    // The document title is "(N) <Surface> | <Meeting Name> | Microsoft Teams".
    // The meeting name itself can contain '|' (e.g. "Sean | Blake 1:1"), so we
    // strip the known prefix/suffix rather than splitting on '|'.
    let t = (document.title || '').replace(/^\(\d+\)\s*/, '').trim();
    t = t.replace(/\s*\|\s*Microsoft Teams\s*$/i, '');
    t = t.replace(/^(Calendar|Chat|Activity|Files|Calls|Communities|Teams)\s*\|\s*/i, '').trim();
    if (t && !/^(Calendar|Chat|Activity|Files|Calls|Communities|Teams|Microsoft Teams)$/i.test(t)) {
      meetingTitle = t;
    }
  }
  const headerEl = q('[data-tid="intelligent-recap-header"]');
  return {
    isTeams: true,
    navigated,
    meetingTitle,
    dateTime: headerEl ? (headerEl.textContent || '').replace(/\s+/g, ' ').trim() : ''
  };
}

// Parse a Teams recap header like "Thursday, July 2, 2026 1:05 PM - 1:50 PM"
// into a compact local-time stamp "20260702_1305". Returns null if unparseable.
function parseRecapDateTime(s) {
  if (!s) return null;
  const m = s.match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4}).*?(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return null;
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const mon = months[m[1].slice(0, 3).toLowerCase()];
  if (!mon) return null;
  let hr = +m[4];
  const min = +m[5];
  const ap = m[6].toUpperCase();
  if (ap === 'PM' && hr !== 12) hr += 12;
  if (ap === 'AM' && hr === 12) hr = 0;
  const pad = n => String(n).padStart(2, '0');
  return `${m[3]}${pad(mon)}${pad(+m[2])}_${pad(hr)}${pad(min)}`;
}

// Build a descriptive default filename for a Teams recap from the gathered
// meeting context, e.g. "Sean | Blake 1:1 - 20260702_1305 Recap" (saveFile
// sanitizes illegal characters). Returns null when there is no Teams context.
function buildRecapName(ctx) {
  if (!ctx || !ctx.meetingTitle) return null;
  const dt = parseRecapDateTime(ctx.dateTime);
  return dt ? `${ctx.meetingTitle} - ${dt} Recap` : `${ctx.meetingTitle} - Recap`;
}
