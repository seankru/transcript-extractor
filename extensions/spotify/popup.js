const statusEl = document.getElementById('status');
const filenameEl = document.getElementById('filename');
const extractBtn = document.getElementById('extract');

function setStatus(text, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

extractBtn.addEventListener('click', async () => {
  extractBtn.disabled = true;
  setStatus('Reading the published Spotify transcript. Keep this popup open.');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab.');
    const format = document.querySelector('input[name="format"]:checked')?.value === 'vtt' ? 'vtt' : 'md';
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN', func: extractAndDownload,
      args: [filenameEl.value.trim(), format],
    });
    const result = results?.[0]?.result;
    if (result?.canTranscribe) {
      await localTranscription.start('spotify', tab, format, filenameEl.value.trim());
    } else if (!result || result.error) {
      throw new Error(result?.error || 'Spotify returned no extraction result.');
    } else {
      setStatus(`Source: Spotify published transcript (speaker labels preserved).\n` +
        `Extracted ${result.cueCount} cues (${(result.byteCount / 1024).toFixed(1)} KB).\n` +
        `Covered up to ${result.coverage}.\nSaved to Downloads as:\n${result.filename}`);
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    extractBtn.disabled = localTranscription.busy;
  }
});

// Serialized into Spotify's MAIN world. Read transcript data, never session credentials.
async function extractAndDownload(suggestedName, format) {
  try {
    const match = location.hostname === 'open.spotify.com' &&
      location.pathname.match(/^\/(?:intl-[a-z-]+\/)?episode\/([A-Za-z0-9]{22})\/?$/);
    if (!match) return { error: 'Open a Spotify podcast episode, not a show, playlist, or music track.' };
    const id = match[1];
    const episodeUri = `spotify:episode:${id}`;
    const source = `https://open.spotify.com/episode/${id}`;
    const response = await fetch(source, { credentials: 'omit', signal: AbortSignal.timeout(20000) });
    if (!response.ok) return { error: `Spotify episode metadata returned HTTP ${response.status}.` };
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    const encoded = page.getElementById('initialState')?.textContent;
    if (!encoded) return { error: 'Spotify episode metadata changed. Reload the page and try again.' };
    const state = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))));
    const episode = state.entities?.items?.[episodeUri];
    const duration = Number(episode?.duration?.totalMilliseconds);
    if (episode?.id !== id || !episode.name || !Number.isFinite(duration) || duration <= 0) {
      return { error: 'Could not identify the full current Spotify episode.' };
    }
    const transcriptTab = document.querySelector('[data-testid="transcript-tab"]');
    if (!transcriptTab || transcriptTab.getAttribute('aria-disabled') === 'true') {
      return { error: 'No accessible Spotify transcript. Sign in to Spotify if this episode has a Transcript tab.',
        canTranscribe: true };
    }
    transcriptTab.click();
    let transcript;
    for (let attempt = 0; attempt < 40 && !transcript; attempt++) {
      const panel = document.getElementById('transcript-panel');
      for (const element of [...(panel?.children || [])].slice(0, 6)) {
        let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
        for (let depth = 0; fiber && depth < 20 && !transcript; depth++, fiber = fiber.return) {
          const props = fiber.memoizedProps;
          if (props?.episodeUri !== episodeUri ||
              props.readAlongUrl !== `https://spclient.wg.spotify.com/transcript-read-along/v2/episode/${id}`) continue;
          let hook = fiber.memoizedState;
          for (let index = 0; hook && index < 30; index++, hook = hook.next) {
            const data = hook.memoizedState?.data;
            if (Array.isArray(data?.section) && data.episodeName === episode.name) {
              transcript = data;
              break;
            }
          }
        }
      }
      if (!transcript) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!transcript) {
      return { error: 'Spotify could not load a readable full transcript. Reload the page and retry.',
        canTranscribe: true };
    }
    if (location.pathname.match(/episode\/([A-Za-z0-9]{22})/)?.[1] !== id) {
      return { error: 'The episode changed during extraction. Reopen the extension and try again.' };
    }
    const cues = [];
    let speaker = '';
    let coverage = 0;
    let previousStart = -1;
    for (const section of transcript.section) {
      const start = Number(section.startMs);
      if (!Number.isFinite(start) || start < 0 || start < previousStart || start > duration + 2000) {
        return { error: 'Spotify returned invalid transcript timing. Refusing to save incomplete captions.',
          canTranscribe: true };
      }
      previousStart = start;
      if (typeof section.title?.title === 'string') speaker = section.title.title.trim();
      const sentence = section.text?.sentence;
      const music = section.musicClosedCaption;
      const text = typeof sentence?.text === 'string' ? sentence.text.trim() :
        typeof music?.text === 'string' ? `[${music.text.trim()}]` : '';
      if (!text) continue;
      let end = start;
      for (const highlight of sentence?.highlight || []) {
        if (Number.isFinite(highlight.startMs)) end = Math.max(end, highlight.startMs);
      }
      if (Number.isFinite(music?.endMs)) end = Math.max(end, music.endMs);
      coverage = Math.max(coverage, end);
      cues.push({ start, end, text, speaker: music ? '' : speaker });
    }
    if (!cues.length || coverage < duration * 0.9 - 2000) {
      return { error: 'Spotify supplied an empty or partial transcript. A full transcript is required.',
        canTranscribe: true };
    }
    const stamp = ms => {
      const value = Math.round(ms);
      return `${String(Math.floor(value / 3600000)).padStart(2, '0')}:` +
        `${String(Math.floor(value / 60000) % 60).padStart(2, '0')}:` +
        `${String(Math.floor(value / 1000) % 60).padStart(2, '0')}.${String(value % 1000).padStart(3, '0')}`;
    };
    const escapeHtml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escapeMd = text => text.replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&');
    format = format === 'vtt' ? 'vtt' : 'md';
    const content = format === 'vtt' ? 'WEBVTT\n\n' + cues.map((cue, index) => {
      const next = cues.slice(index + 1).find(item => item.start > cue.start)?.start;
      const end = Math.min(duration, next || Math.max(cue.end + 1000, cue.start + 1));
      const text = escapeHtml(cue.text).replace(/\r?\n/g, ' ');
      return `${index + 1}\n${stamp(cue.start)} --> ${stamp(end)}\n` +
        `${cue.speaker ? `<v ${escapeHtml(cue.speaker)}>${text}</v>` : text}\n`;
    }).join('\n') : `# ${escapeMd(episode.name)}\n\nSource: ${source}\n\n` +
      'Published Spotify transcript. Speaker labels are supplied by Spotify.\n\n' +
      cues.map(cue => `**[${stamp(cue.start)}]${cue.speaker ? ` ${escapeMd(cue.speaker)}` : ''}**\n\n` +
        escapeMd(cue.text)).join('\n\n') + '\n';
    let name = (suggestedName || episode.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\.(md|vtt)$/i, '').trim().replace(/[. ]+$/, '').slice(0, 140);
    if (!name || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = 'Spotify transcript';
    const filename = `${name}.${format}`;
    const blob = new Blob([content], { type: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/vtt;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { filename, cueCount: cues.length, byteCount: blob.size, coverage: stamp(coverage) };
  } catch (error) {
    return { error: 'Spotify extraction failed: ' + error.message };
  }
}
