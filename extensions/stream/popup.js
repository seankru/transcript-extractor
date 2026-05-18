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

    const format = (document.querySelector('input[name="format"]:checked')?.value) === 'md' ? 'md' : 'vtt';

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: extractAndDownload,
      args: [filenameEl.value.trim() || null, format]
    });

    // Multiple frames may run; pick the first successful extraction.
    // Native-click counts as success even though we never see cue bytes.
    const success = results?.find(x => x?.result && !x.result.error && (x.result.cueCount > 0 || x.result.mode === 'native-click'))?.result;
    if (success) {
      let modeLine;
      if (success.mode === 'fetched') {
        modeLine = `Source: Stream's own .vtt URL (byte-for-byte match with the Download button).\n${success.sourceUrl ? success.sourceUrl + '\n' : ''}`;
      } else if (success.mode === 'native-click') {
        modeLine = `Source: Stream's native Download \u2192 ${success.buttonLabel || 'Download as .vtt'}.\n`;
      } else {
        modeLine = 'Source: DOM scrape (approximate timing, no Stream cue GUIDs).\n';
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
      if (!r) {
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
  extractBtn.disabled = false;
});

// ---------------------------------------------------------------------------
// Injected into the active tab's content world. Must be a single self-contained
// function (no outer-scope references) because chrome.scripting serializes it.
// ---------------------------------------------------------------------------
async function extractAndDownload(suggestedName, format) {
  // Normalise format: 'vtt' (default) or 'md'.
  format = (format === 'md') ? 'md' : 'vtt';
  function findRows() {
    return Array.from(document.querySelectorAll('[class*="listItemWithSpeaker-"]'));
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
    const tsEl = row.querySelector('[class*="baseTimestamp-"]');
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

  // Check whether the transcript pane is genuinely open (not just whether
  // row elements happen to be in the DOM — closing the pane can leave them
  // around). The in-pane Download trigger is the load-bearing signal.
  function isTranscriptPaneOpen() {
    const btn = document.getElementById('downloadTranscript');
    if (!btn) return false;
    const r = btn.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && findRows().length > 0;
  }

  if (!isTranscriptPaneOpen()) {
    // The user clicked while on Stream but with the transcript pane closed.
    // Try to open it for them; the helper waits for rows to render. Only
    // surface a "please open it manually" error if that fails (e.g. on a
    // page that genuinely has no transcript).
    await ensureTranscriptOpen();
  }
  if (!isTranscriptPaneOpen()) {
    return { error: 'No transcript rows found. Open the transcript pane first (\u2026 \u2192 Transcript).' };
  }

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
    // Canonical "pane is open" signal is the visibility of the in-pane
    // download trigger (#downloadTranscript). Row elements can persist in
    // the DOM after the user closes the pane, so a row-count check alone is
    // unreliable — we must verify the pane container itself is on-screen.
    const isOpen = () => {
      const btn = document.getElementById('downloadTranscript');
      if (!btn) return false;
      const r = btn.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    if (isOpen() && findRows().length > 0) return true;
    const nav = findTranscriptNavButton();
    if (!nav) return false;
    nav.click();
    // Wait for the pane to actually render: both the download trigger AND
    // at least one row must be present and the trigger must be visible.
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (isOpen() && findRows().length > 0) {
        // One last settle so virtualization can paint the first viewport.
        await new Promise(r => setTimeout(r, 500));
        return true;
      }
    }
    return isOpen() && findRows().length > 0;
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

  // Native download produces a .vtt straight to the Downloads folder. We
  // can't intercept it for in-page format conversion, so skip it when the
  // user has asked for Markdown — let the fetch / scrape path own that case.
  if (format !== 'md') {
    const native = await tryNativeDownload();
    if (native?.triggered) {
      return {
        mode: 'native-click',
        format,
        buttonLabel: native.label,
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

  function saveFile(body, baseName, ext, mime) {
    const extension = (ext || '.vtt').toLowerCase();
    const mimeType = mime || (extension === '.md' ? 'text/markdown' : 'text/vtt');
    let filename = baseName;
    if (!filename) {
      let title = (document.title || 'transcript')
        .replace(/\s*-\s*Microsoft Stream$/i, '')
        .replace(/\s*\.mp4$/i, '')
        .trim();
      title = title.replace(/[\\/:*?"<>|]/g, '_');
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

  const fetched = await tryFetchTranscriptViaApi();
  if (fetched) {
    let payload, ext, cueCount;
    if (fetched.kind === 'json') {
      cueCount = (fetched.data && Array.isArray(fetched.data.entries)) ? fetched.data.entries.length : 0;
      if (format === 'md') {
        payload = transcriptJsonToMarkdown(fetched.data);
        ext = '.md';
      } else {
        payload = transcriptJsonToVtt(fetched.data);
        ext = '.vtt';
      }
    } else { // kind === 'vtt' (raw, speaker-less)
      cueCount = (fetched.body.match(/-->/g) || []).length;
      if (format === 'md') {
        payload = vttToMarkdown(fetched.body);
        ext = '.md';
      } else {
        payload = fetched.body;
        ext = '.vtt';
      }
    }
    const filename = saveFile(payload, suggestedName, ext);
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
  const filename = saveFile(payload, suggestedName, ext);

  return {
    mode: 'scraped',
    format,
    cueCount: cuesForVtt.length,
    byteCount: payload.length,
    coverage: cuesForVtt.length > 0 ? vttTime(parseTime(cuesForVtt[cuesForVtt.length - 1].time)) : '00:00:00.000',
    filename
  };
}
