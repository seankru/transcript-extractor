// Substack Transcript Extractor — popup logic
//
// Click "Extract & Download" → inject extractAndDownload into the active
// Substack tab → read window._preloads → fetch signed CDN VTT URL →
// resolve SPEAKER_NN tags to real names via the embedded speaker_map →
// save as .vtt or .md.
//
// Background:
//   Substack video posts inline a `_preloads` blob (either as window._preloads
//   or in an inline <script>) that contains both a signed substackcdn.com
//   transcript URL (with an Expires= query string, no auth needed) and a
//   speaker_map ({"SPEAKER_00": "Real Name", ...}). The same technique is
//   used by other community extractors. This implementation is independent.

const statusEl = document.getElementById('status');
const filenameEl = document.getElementById('filename');
const extractBtn = document.getElementById('extract');

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', !!isError);
}

extractBtn.addEventListener('click', async () => {
  setStatus('Extracting\u2026 keep this popup open.');
  extractBtn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus('No active tab.', true);
      extractBtn.disabled = false;
      return;
    }

    const format = (document.querySelector('input[name="format"]:checked')?.value) === 'vtt' ? 'vtt' : 'md';

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // Inject into the page's MAIN world so we can read window._preloads,
      // which Substack sets as a page-level global. The default isolated
      // content-script world hides page globals; we previously relied on
      // scraping inline <script> textContent as a workaround, but that path
      // can't always recover the current post id from heavily-escaped
      // serializations.
      world: 'MAIN',
      func: extractAndDownload,
      args: [filenameEl.value.trim() || null, format]
    });

    const success = results?.find(x => x?.result && !x.result.error && (x.result.cueCount > 0 || x.result.paragraphCount > 0))?.result;
    if (success) {
      const speakerLine = success.resolvedNames > 0
        ? `Resolved ${success.resolvedNames} speaker tag${success.resolvedNames === 1 ? '' : 's'} to real names.\n`
        : (success.speakerCount > 0
            ? `Speaker map present (${success.speakerCount} entries) but no speaker tags to map.\n`
            : 'No speaker_map on this post (SPEAKER_NN tags kept as-is).\n');
      // Format-aware source line. The .md output prefers Substack's
      // transcription.json (word-level JSON), which lets us replay their
      // exact paragraph-chunking algorithm. The .vtt output and any .md
      // fallback use the signed VTT URL.
      const sourceLabel = success.source === 'transcription-json'
        ? "Substack's transcription.json (word-level data, exact paragraph algorithm)."
        : "Substack's signed VTT URL.";
      const countLine = success.source === 'transcription-json'
        ? `Rendered ${success.paragraphCount} paragraph${success.paragraphCount === 1 ? '' : 's'} from ${success.sentenceCount} sentences (${(success.byteCount / 1024).toFixed(1)} KB).`
        : `Extracted ${success.cueCount} cues (${(success.byteCount / 1024).toFixed(1)} KB).`;
      setStatus(
        `Source: ${sourceLabel}\n${speakerLine}` +
        `${countLine}\n` +
        `Saved to Downloads as:\n${success.filename}`
      );
    } else {
      const err = results?.find(x => x?.result?.error)?.result;
      if (err?.canTranscribe) {
        setStatus('No full published transcript. Checking local transcription preference...');
        await localTranscription.start('substack', tab, format, filenameEl.value.trim());
      } else {
        setStatus('Error: ' + (err?.error || 'Unknown failure'), true);
      }
    }
  } catch (err) {
    setStatus('Inject failed: ' + (err?.message || String(err)), true);
  }
  extractBtn.disabled = localTranscription.busy;
});

// ---------------------------------------------------------------------------
// Injected into the active tab's content world. Must be self-contained
// because chrome.scripting serializes it across the boundary.
// ---------------------------------------------------------------------------
async function extractAndDownload(suggestedName, format) {
  format = (format === 'vtt') ? 'vtt' : 'md';

  // ── Step 1: locate the Substack preloads blob ──────────────────────────
  // Substack serialises page metadata into either window._preloads (a JSON
  // string) or, on some surfaces, inline <script> tags. We accept either.
  let raw = null;
  if (typeof window._preloads === 'string') {
    raw = window._preloads;
  } else if (window._preloads && typeof window._preloads === 'object') {
    try { raw = JSON.stringify(window._preloads); } catch { /* fall through */ }
  }
  if (!raw) {
    for (const script of document.querySelectorAll('script:not([src])')) {
      const t = script.textContent || '';
      if (t.includes('speaker_map') && t.includes('.vtt')) { raw = t; break; }
    }
  }
  if (!raw) {
    return { error: 'No transcript metadata found on this page. Open a Substack video post that has a published transcript.' };
  }

  // ── Step 2: identify the current post and scope all metadata to it ─────
  // Substack inlines metadata for the current post AND for sidebar/recent
  // posts in the same _preloads blob. If we read VTT URLs, speaker_map,
  // or audio markers from the FULL blob, we can silently pick up a
  // sidebar post's data — same bug shape three times. So we resolve the
  // current post object first, then run every subsequent match against a
  // scoped blob that contains only this post's JSON.
  let currentPostObj = null;
  if (window._preloads && typeof window._preloads === 'object') {
    currentPostObj = window._preloads.post || window._preloads.body?.post || null;
  }
  if (!currentPostObj) {
    // raw came from an inline <script> or stringified window._preloads —
    // try parsing it back into an object.
    try {
      const parsed = JSON.parse(raw);
      currentPostObj = parsed.post || parsed.body?.post || null;
    } catch { /* fall through to raw-regex post-id detection */ }
  }

  let currentPostId = currentPostObj?.id ?? null;
  if (currentPostId == null) {
    // Fallbacks for cases where _preloads wasn't accessible as an object
    // (very old serializations, or non-standard host pages). Each candidate
    // is sourced independently; first numeric hit wins.
    const candidates = [
      // Plain JSON: "post":{"id":12345
      /"post"\s*:\s*\{\s*"id"\s*:\s*(\d+)/,
      // Backslash-escaped JSON inside a JS string literal: \"post\":{\"id\":12345
      /\\"post\\"\s*:\s*\{\s*\\"id\\"\s*:\s*(\d+)/,
      // URL-encoded JSON: %22post%22%3A%7B%22id%22%3A12345
      /%22post%22%3A%7B%22id%22%3A(\d+)/i,
      // Twitter/OG meta image URL pattern: /api/v1/post_preview/<postId>/...
      /api\/v1\/post_preview\/(\d+)\//,
      // Signed captions/transcoded media URL pattern: /video_upload/post/<postId>/
      /video_upload\/post\/(\d+)\//,
    ];
    for (const re of candidates) {
      const m = raw.match(re);
      if (m && m[1]) { currentPostId = Number(m[1]); break; }
    }
    if (currentPostId == null) {
      // Final fallback: meta og:url + canonical-link slug doesn't carry a
      // numeric id, but the page's own twitter:image meta usually does.
      const og = document.querySelector('meta[property="twitter:image"], meta[name="twitter:image"]');
      const ogUrl = og?.getAttribute('content') || '';
      const ogMatch = ogUrl.match(/\/post_preview\/(\d+)\//);
      if (ogMatch) currentPostId = Number(ogMatch[1]);
    }
  }
  if (currentPostId == null) {
    return { error: 'Could not determine the current post id from page data.' };
  }

  // A post can contain captions for a short podcast preview even when its
  // full video has no transcript. Post-id matching alone cannot distinguish
  // those uploads. Select the primary media before looking for captions.
  const primaryUpload =
    currentPostObj?.videoUpload ??
    currentPostObj?.video_upload ??
    currentPostObj?.podcastUpload ??
    currentPostObj?.podcast_upload ??
    currentPostObj?.voiceoverUpload ??
    null;
  const transcriptions = [
    primaryUpload?.extractedAudio?.transcription,
    primaryUpload?.extracted_audio?.transcription,
    primaryUpload?.transcription,
  ].filter(t => t && typeof t === 'object');
  const tx = transcriptions.find(t =>
    Array.isArray(t.signed_captions) && t.signed_captions.some(c => typeof c?.url === 'string')
  ) ?? transcriptions.find(t => typeof t.cdn_url === 'string') ?? null;

  let scoped = raw;
  if (currentPostObj) {
    scoped = JSON.stringify(primaryUpload || currentPostObj, (key, value) =>
      key === 'podcastPreviewUpload' || key === 'podcast_preview_upload' ? undefined : value
    );
  } else if (/podcastPreviewUpload|podcast_preview_upload/.test(raw)) {
    return { error: 'Could not distinguish the full recording from podcast-preview metadata. Reload the post and try again.' };
  }

  // Match only VTT URLs whose path contains /post/<currentPostId>/.
  const scopedRe = new RegExp(
    'https:\\/\\/substackcdn\\.com\\/video_upload\\/post\\/' +
    currentPostId +
    '\\/[^"\\\\]+\\.vtt(?:\\?[^"\\\\]*)?'
  );
  const captions = Array.isArray(tx?.signed_captions) ? tx.signed_captions : [];
  const caption = captions.find(c => c?.language === 'en' && typeof c.url === 'string') ??
    captions.find(c => typeof c?.url === 'string');
  const vttMatch = caption?.url.match(scopedRe) || scoped.match(scopedRe);
  const txRe = new RegExp(
    'https:\\/\\/substackcdn\\.com\\/video_upload\\/post\\/' +
    currentPostId +
    '\\/[^"\\\\]+\\/transcription\\.json(?:\\?[^"\\\\]*)?'
  );
  const transcriptionUrl = (typeof tx?.cdn_url === 'string' ? tx.cdn_url.match(txRe)?.[0] : null) ||
    scoped.match(txRe)?.[0] || null;
  if (!vttMatch && !(format === 'md' && transcriptionUrl)) {
    const preview = currentPostObj?.podcastPreviewUpload ?? currentPostObj?.podcast_preview_upload;
    if (primaryUpload && preview?.transcription) {
      return {
        canTranscribe: true,
        error:
          'Substack has published captions only for this post\'s short podcast preview, ' +
          'not the full recording. Preview captions were not downloaded. ' +
          'To transcribe the full recording locally with Whisper, use the companion CLI ' +
          'in tools/transcribe-substack/.'
      };
    }
    // Inline-body video without published captions. Substack lets authors
    // drop a video embed inside a normal text post; it renders as a
    // <video> element whose source points at /api/v1/video/upload/<id>/src
    // on the publication's own origin. This is a different shape from a
    // "video post," which carries post.videoUpload — body-embedded videos
    // leave post.videoUpload null and only show up in body_html / DOM.
    //
    // This branch MUST run before the TTS check below: a text post with a
    // body-embedded video frequently also carries an auto-generated TTS
    // narration of the post text (post.audio_items[0].type === 'tts'),
    // which would otherwise misclassify the page as a pure TTS-only post.
    const inlineVideoEl = document.querySelector(
      'video[src*="/api/v1/video/upload/"], video source[src*="/api/v1/video/upload/"]'
    );
    if (inlineVideoEl) {
      const slug = currentPostObj?.slug || '(unknown)';
      return {
        canTranscribe: true,
        error:
          'This post has an inline-body video, but Substack has not published ' +
          'captions for it. To transcribe it locally with Whisper, use the ' +
          'companion CLI in tools/transcribe-substack/ (see the project README ' +
          'for setup). Slug: ' + slug
      };
    }

    // TTS-narrated text posts: Substack synthesizes audio FROM the post
    // text using a stored voice profile (post.audio_items[].voice_id).
    // There is no recording and no transcription — the post body itself
    // is the "transcript". Detect this case before the generic fallbacks
    // so the user sees a useful message instead of "no captions yet".
    const audioItems = Array.isArray(currentPostObj?.audio_items) ? currentPostObj.audio_items : [];
    const isTtsPost = audioItems.some(a => a && a.voice_id) &&
                      !currentPostObj?.videoUpload &&
                      !currentPostObj?.video_upload &&
                      !currentPostObj?.voiceoverUpload;
    if (isTtsPost) {
      return {
        error:
          'This post has TTS-narrated audio synthesised from the post text (no recording was transcribed). ' +
          'There is no separate transcript file — the post body itself is the source. ' +
          'A "Save post body as .md" feature is planned for v0.2.0.'
      };
    }
    // Audio-only detection. The DOM <audio> element belongs to the post
    // body and is the most reliable signal (sidebar/recent posts render
    // as links, never as players). We deliberately do NOT fall back to
    // raw-blob regex here — that would match sidebar audio metadata.
    const isAudioPost = !!document.querySelector('audio[src], audio source[src]');
    if (isAudioPost) {
      return {
        canTranscribe: true,
        error:
          'This is an audio-only post — Substack does not publish a transcript for it. ' +
          'The signed MP3 URL is reachable on the page; transcription would need to happen externally.'
      };
    }
    return {
      canTranscribe: true,
      error:
        'No transcript was found for this post (id ' + currentPostId + '). ' +
        'The post may be text-only, audio-only, or have no published captions yet. ' +
        'If this is a paid post, you must be signed in as a subscriber for Substack to expose signed caption URLs.'
    };
  }
  const vttUrl = vttMatch?.[0];

  // ── Step 3: extract the speaker map ────────────────────────────────────
  // Same bug-shape risk: a raw-blob search for `"speaker_map":{...}` finds
  // the FIRST occurrence, which may belong to a sidebar post and would
  // apply wrong names to the current post's VTT. Scope to the current
  // post's JSON, and prefer structured object access where available.
  let speakerMap = {};
  // Direct structured access (Substack stores speaker_map under the post's
  // video_upload block on video posts).
  const directMap =
    tx?.speaker_map ??
    primaryUpload?.speaker_map ??
    currentPostObj?.video_upload?.speaker_map ??
    (!primaryUpload ? currentPostObj?.podcastFields?.speaker_map : null) ??
    null;
  if (directMap && typeof directMap === 'object') {
    speakerMap = directMap;
  } else {
    const mapMatch = scoped.match(/(?:\\"|")speaker_map(?:\\"|")\s*:\s*(\{[^}]*\})/);
    if (mapMatch) {
      try {
        speakerMap = JSON.parse(mapMatch[1].replace(/\\"/g, '"'));
      } catch { /* leave empty — VTT will keep SPEAKER_XX tags */ }
    }
  }

  // Prefer the full published JSON for Markdown, even without a usable VTT.
  const recordingDuration = Number(primaryUpload?.duration);
  let transcriptionData = null;
  if (format === 'md' && transcriptionUrl) {
    try {
      const response = await fetch(transcriptionUrl, { credentials: 'omit' });
      if (response.ok) {
        const parsed = await response.json();
        if (Array.isArray(parsed) && parsed.length > 0 &&
            parsed.every(sentence => sentence && Array.isArray(sentence.words) &&
              typeof sentence.text === 'string' && sentence.text.trim() && Number.isFinite(sentence.start) &&
              Number.isFinite(sentence.end))) {
          const end = parsed.reduce((latest, sentence) => Math.max(latest, sentence.end), 0);
          if (!(recordingDuration > 0) || end >= recordingDuration * 0.9 - 2) {
            transcriptionData = parsed;
          }
        }
      }
    } catch { /* A usable VTT remains a published-transcript fallback. */ }
  }
  if (!transcriptionData && !vttUrl) {
    return { canTranscribe: true, error: 'The published transcript is unavailable or incomplete. Using local transcription instead.' };
  }

  // ── Step 4: fetch the signed VTT ───────────────────────────────────────
  let vttBody = '';
  if (!transcriptionData) {
    try {
      const resp = await fetch(vttUrl, { credentials: 'omit' });
      if (!resp.ok) {
        return {
          error: `Substack CDN returned HTTP ${resp.status} for the VTT URL. The signed URL may have expired — reload the page and try again.`
        };
      }
      vttBody = await resp.text();
    } catch (e) {
      return { error: 'Failed to fetch the VTT from Substack CDN: ' + (e?.message || String(e)) };
    }
    if (!/^\uFEFF?WEBVTT/.test(vttBody)) {
      return { error: 'Fetched the URL but the response does not look like a WebVTT file.' };
    }
    const publishedEnds = [...vttBody.matchAll(/-->\s*(?:(\d+):)?(\d{2}):(\d{2}(?:\.\d+)?)/g)]
      .map(match => Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    if (!publishedEnds.length) {
      return { canTranscribe: true, error: 'The published caption file contains no timed speech.' };
    }
    if (recordingDuration > 0 && publishedEnds.reduce((latest, end) => Math.max(latest, end), 0) < recordingDuration * 0.9 - 2) {
      return { canTranscribe: true, error: 'Published captions cover only part of the full recording. Using local transcription instead.' };
    }
  }

  // ── Step 5: apply speaker map (SPEAKER_NN → real name) ─────────────────
  // Substack tags speakers in <v SPEAKER_NN> form. Replace each occurrence
  // with the human name from speaker_map; leave codes alone when no mapping
  // is present so downstream consumers can still see which speaker spoke.
  let resolvedNames = 0;
  const remapped = vttBody.replace(/<v\s+([^>]+)>/g, (m, code) => {
    const trimmed = code.trim();
    const name = speakerMap[trimmed];
    if (name) { resolvedNames++; return `<v ${name}>`; }
    return m;
  });

  // ── Step 6: convert + save ─────────────────────────────────────────────
  // Markdown renderer: parses cues, then groups them into paragraphs.
  // Substack's *viewer* renders WebVTT cues grouped into paragraph blocks
  // at display time (you can see the timestamp markers in the transcript
  // drawer). The .vtt file itself is necessarily cue-by-cue (that's what
  // the WebVTT spec is for — timed-text for video players). The .md
  // output is what we use to approximate the viewer's paragraphed prose
  // layout.
  //
  // Heuristic (calibrated against the rendered drawer DOM of
  // natesnewsletter.substack.com/p/we-are-missing-the-real-ai-misalignment
  // captured via CDP-attach with `probe-drawer.mjs`):
  //   1. Always break on speaker change.
  //   2. Within a same-speaker run, also break when paragraph duration
  //      has reached PARA_SOFT_SECONDS *and* the previous cue ended at a
  //      sentence terminator (. ! ? optionally followed by quote/paren).
  //   3. Force a break (even mid-sentence) when paragraph duration
  //      reaches PARA_HARD_SECONDS. Substack's drawer does this — many
  //      of its paragraphs end on commas or mid-clause when the audio
  //      runs long without a clean stop.
  //
  // SOFT=15 / HARD=22 reproduces the drawer's first three paragraph
  // breaks exactly and stays within ±1-2s on the rest of the ~10-minute
  // monologue.
  function vttToMarkdown(body) {
    const norm = String(body).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
    const PARA_SOFT_SECONDS = 15;
    const PARA_HARD_SECONDS = 22;
    const SENTENCE_END_RE = /[.!?][)"'\u2019\u201D]?\s*$/;

    // HH:MM:SS(.mmm) → seconds (number).
    function toSec(t) {
      const m = /^(\d+):(\d+):(\d+)(?:\.(\d+))?$/.exec(t);
      if (!m) return 0;
      return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) +
             (m[4] ? Number('0.' + m[4]) : 0);
    }

    // 1. Parse every cue into { timing, startSec, endSec, speaker, text }.
    const cues = [];
    for (const block of norm.split(/\n\n+/)) {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      if (/^WEBVTT/.test(lines[0])) continue;
      if (/^NOTE\b/.test(lines[0])) continue;
      let timing = null, startSec = 0, endSec = 0, speaker = null;
      const parts = [];
      for (const l of lines) {
        const tm = l.match(/^(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\s+-->\s+(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)/);
        if (tm) {
          timing = tm[1].replace(/\.\d+$/, '');
          startSec = toSec(tm[1]);
          endSec = toSec(tm[2]);
          continue;
        }
        if (/-->/.test(l)) continue;
        // Cue-ID line: bare word chars / hyphens / slashes only.
        if (/^[\w/-]+$/.test(l) && !/^</.test(l)) continue;
        const vMatch = l.match(/^<v\s+([^>]+)>(.*)$/);
        if (vMatch) {
          speaker = vMatch[1].trim();
          parts.push(vMatch[2].replace(/<\/v>\s*$/, '').trim());
        } else {
          parts.push(l.replace(/<\/?v[^>]*>/g, '').trim());
        }
      }
      const text = parts.filter(Boolean).join(' ').trim();
      if (!timing || !text) continue;
      cues.push({ timing, startSec, endSec, speaker, text });
    }

    // 2. Forward-fill: an unlabeled cue continues the prior speaker.
    let last = null;
    for (const c of cues) {
      if (c.speaker) last = c.speaker;
      else c.speaker = last;
    }
    // 3. Backfill: if the transcript opens with unlabeled cues (Substack's
    //    diarizer often omits the <v> tag until the second speaker enters),
    //    attribute them to whoever speaks first.
    const firstSpeaker = cues.find(c => c.speaker)?.speaker || null;
    for (const c of cues) { if (!c.speaker) c.speaker = firstSpeaker; }

    // 4. Group cues into paragraphs (see heuristic in the header comment).
    const groups = [];
    for (const c of cues) {
      const tail = groups[groups.length - 1];
      const sameSpeaker = tail && tail.speaker === c.speaker;
      const paraDuration = tail ? (tail.endSec - tail.startSec) : 0;
      const lastSentenceEnded = tail && SENTENCE_END_RE.test(tail.text);
      const breakParagraph = !sameSpeaker ||
        paraDuration >= PARA_HARD_SECONDS ||
        (paraDuration >= PARA_SOFT_SECONDS && lastSentenceEnded);
      if (tail && !breakParagraph) {
        tail.text += ' ' + c.text;
        tail.endSec = c.endSec;
      } else {
        groups.push({
          timing: c.timing,
          startSec: c.startSec,
          endSec: c.endSec,
          speaker: c.speaker,
          text: c.text
        });
      }
    }

    // 5. Render.
    const out = ['# Transcript', ''];
    for (const g of groups) {
      const sp = g.speaker ? ` **${g.speaker}:**` : '';
      out.push(`**[${g.timing}]**${sp} ${g.text}`, '');
    }
    return out.join('\n');
  }

  // Markdown renderer: Substack's exact paragraph-chunking algorithm.
  //
  // Reverse-engineered from Substack's production bundles
  // (bundle 17978, webpack module 50874, export `qD`) — the same
  // function the transcript drawer uses to turn 173 sentence-level
  // WhisperX segments into the 29 paragraphs the reader sees on
  // natesnewsletter.substack.com/p/we-are-missing-the-real-ai-misalignment.
  // Verified byte-perfect (29/29 sentence-boundary indices match) against
  // the drawer's rendered output via `.driver/verify-algorithm.mjs`.
  //
  // The algorithm: walk the sentence array, greedily merging consecutive
  // sentences while (a) the speaker is unchanged and (b) the combined
  // word count would stay ≤ 60. Otherwise flush the accumulator and
  // start a new paragraph from the current sentence. Paragraph start
  // time is the first sentence's `start`; end time is the last
  // sentence's `end`.
  //
  // We also resolve SPEAKER_NN to a real name via `speakerMap` (which is
  // sourced from `transcription.speaker_map` when present, falling back
  // to the post-level `speaker_map` collected for the VTT path).
  function transcriptionToMarkdown(sentences) {
    const MAX_WORDS_PER_ROW = 60;
    if (!Array.isArray(sentences) || sentences.length === 0) {
      return { markdown: '# Transcript\n', paragraphCount: 0 };
    }
    // Defensive copies so we never mutate the parsed payload.
    const seed = sentences[0];
    let acc = {
      start: Number(seed.start) || 0,
      end: Number(seed.end) || 0,
      text: String(seed.text || '').trim(),
      words: Array.isArray(seed.words) ? seed.words.slice() : [],
      speaker: seed.speaker ?? null,
    };
    const paras = [];
    for (let i = 1; i < sentences.length; i++) {
      const s = sentences[i];
      if (!s) continue;
      const sWords = Array.isArray(s.words) ? s.words : [];
      const sameSpeaker = acc.speaker === (s.speaker ?? null);
      const fits = (acc.words.length + sWords.length) <= MAX_WORDS_PER_ROW;
      if (sameSpeaker && fits) {
        acc = {
          start: acc.start,
          end: Number(s.end) || acc.end,
          text: (acc.text + ' ' + String(s.text || '').trim()).trim(),
          words: acc.words.concat(sWords),
          speaker: acc.speaker,
        };
      } else {
        paras.push(acc);
        acc = {
          start: Number(s.start) || 0,
          end: Number(s.end) || 0,
          text: String(s.text || '').trim(),
          words: sWords.slice(),
          speaker: s.speaker ?? null,
        };
      }
    }
    paras.push(acc);

    // Helper: seconds → mm:ss or hh:mm:ss (drop hours when 0).
    const fmtTs = (secs) => {
      const n = Math.max(0, Math.floor(Number(secs) || 0));
      const h = Math.floor(n / 3600);
      const m = Math.floor((n % 3600) / 60);
      const s = n % 60;
      const mm = String(m).padStart(2, '0');
      const ss = String(s).padStart(2, '0');
      return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    };

    const out = ['# Transcript', ''];
    let resolved = 0;
    for (const p of paras) {
      // Resolve speaker label: SPEAKER_NN → real name if speakerMap has one.
      let speakerLabel = '';
      if (p.speaker) {
        const mapped = speakerMap[p.speaker];
        if (mapped) resolved++;
        const name = mapped || p.speaker;
        speakerLabel = ` **${name}:**`;
      }
      out.push(`**[${fmtTs(p.start)}]**${speakerLabel} ${p.text}`.trim(), '');
    }
    return { markdown: out.join('\n'), paragraphCount: paras.length, resolvedNames: resolved };
  }

  function saveFile(body, baseName, ext) {
    const extension = (ext || '.vtt').toLowerCase();
    const mime = extension === '.md' ? 'text/markdown' : 'text/vtt';
    let filename = baseName;
    if (!filename) {
      let title = (document.title || 'substack-transcript').trim();
      // Substack titles are typically "<Post Title> - <Publication Name>" or
      // "<Post Title> | <Publication Name>". Strip the trailing publication.
      title = title.replace(/\s+[-|]\s+[^-|]+$/, '').trim();
      title = title.replace(/[\\/:*?"<>|]/g, '_');
      filename = title || 'substack-transcript';
    }
    filename = filename.replace(/\.(vtt|md|txt)$/i, '') + extension;
    const blob = new Blob([body], { type: mime });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 1500);
    return filename;
  }

  const cueCount = (remapped.match(/-->/g) || []).length;
  // Branch on (a) format and (b) availability of word-level data.
  // .vtt always uses the speaker-remapped VTT body.
  // .md prefers transcription.json + Substack's exact chunker; falls back
  // to the VTT-based heuristic if transcription.json wasn't reachable.
  let payload;
  let source;
  let paragraphCount = 0;
  let sentenceCount = 0;
  if (format === 'md') {
    if (transcriptionData) {
      const { markdown, paragraphCount: pc, resolvedNames: txResolved } = transcriptionToMarkdown(transcriptionData);
      payload = markdown;
      paragraphCount = pc;
      sentenceCount = transcriptionData.length;
      // The transcription path resolves speakers by paragraph; replace the
      // VTT-side count (which is 0 here since we never ran the <v> regex
      // on the .md output) with the paragraph-resolution count so the
      // popup status shows real numbers.
      if (txResolved > 0) resolvedNames = txResolved;
      source = 'transcription-json';
    } else {
      payload = vttToMarkdown(remapped);
      source = 'vtt-heuristic';
    }
  } else {
    payload = remapped;
    source = 'vtt';
  }
  const ext = (format === 'md') ? '.md' : '.vtt';
  const filename = saveFile(payload, suggestedName, ext);

  return {
    mode: 'fetched',
    format,
    source,
    sourceUrl: source === 'transcription-json' ? transcriptionUrl : vttUrl,
    speakerCount: Object.keys(speakerMap).length,
    resolvedNames,
    cueCount,
    sentenceCount,
    paragraphCount,
    byteCount: payload.length,
    filename
  };
}
