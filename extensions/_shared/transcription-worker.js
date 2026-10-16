const NATIVE_HOST = 'com.transcript_extractor.local';
const JOB_KEY = 'localTranscription';
const POLL_ALARM = 'local-transcription';

async function native(message) {
  let response;
  try {
    response = await chrome.runtime.sendNativeMessage(NATIVE_HOST, message);
  } catch (error) {
    throw new Error('Local Whisper helper is unavailable. Run tools\\local-transcription\\install.ps1 ' +
      'with this extension ID (' + chrome.runtime.id + '). ' + error.message);
  }
  if (!response?.ok) throw new Error(response?.error || 'The local helper returned no result.');
  return response;
}

async function storeJob(job) {
  await chrome.storage.local.set({ [JOB_KEY]: job });
  const terminal = job.state === 'complete' || job.state === 'failed';
  await chrome.action.setBadgeText({ text: terminal && job.acknowledged ? '' :
    job.state === 'complete' ? 'Done' : job.state === 'failed' ? '!' : '...' });
  await chrome.action.setBadgeBackgroundColor({ color: job.state === 'failed' ? '#c50f1f' : '#0078d4' });
  if (terminal) await chrome.alarms.clear(POLL_ALARM);
}

async function acknowledgeJob() {
  const job = await pollJob();
  if (!job) {
    await chrome.action.setBadgeText({ text: '' });
  } else if (['complete', 'failed'].includes(job.state)) {
    job.acknowledged = true;
    await storeJob(job);
  }
  return job;
}

async function dismissJob() {
  const { [JOB_KEY]: job } = await chrome.storage.local.get(JOB_KEY);
  if (job && !['complete', 'failed'].includes(job.state)) return job;
  await chrome.storage.local.remove(JOB_KEY);
  await chrome.action.setBadgeText({ text: '' });
  return null;
}

async function pollJob() {
  const { [JOB_KEY]: job } = await chrome.storage.local.get(JOB_KEY);
  if (!job?.id || ['complete', 'failed'].includes(job.state)) return job || null;
  if (job.state === 'resolving') {
    if (Date.now() - job.createdAt > 60000) {
      const failed = { ...job, state: 'failed', message: 'Recording resolution was interrupted. Click Extract to retry.' };
      await storeJob(failed);
      return failed;
    }
    return job;
  }
  try {
    const status = await native({ command: 'status', id: job.id });
    const next = { ...job, ...status };
    await storeJob(next);
    return next;
  } catch (error) {
    // Keep the job ID: reconnecting after a browser/helper restart is safe.
    const next = { ...job, message: error.message };
    await chrome.storage.local.set({ [JOB_KEY]: next });
    return next;
  }
}

// Serialized into the page's MAIN world; do not reference worker globals.
async function resolveRecording(provider) {
  const host = location.hostname.toLowerCase();
  const onDomain = domain => host === domain || host.endsWith('.' + domain);
  const media = [...document.querySelectorAll('video, audio')]
    .find(element => Number.isFinite(element.duration) && element.duration > 0);
  let duration = media?.duration;
  let url;
  let resolved = false;
  const title = document.title.replace(/^\(\d+\)\s*/, '').trim();
  if (provider === 'youtube') {
    if (!onDomain('youtube.com') && !onDomain('youtube-nocookie.com')) {
      return { error: 'Open a YouTube recording first.' };
    }
    const player = document.getElementById('movie_player');
    const response = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
    if (response?.playabilityStatus?.status && response.playabilityStatus.status !== 'OK') {
      return { error: 'YouTube does not permit playback of this recording.' };
    }
    if (response?.videoDetails?.isLiveContent && !Number.isFinite(duration)) {
      return { error: 'Wait until the live stream becomes a finite recording.' };
    }
    const id = response?.videoDetails?.videoId;
    if (!/^[\w-]{11}$/.test(id || '')) return { error: 'Could not identify the current YouTube video.' };
    duration = Number(response.videoDetails.lengthSeconds) || duration;
    url = `https://www.youtube.com/watch?v=${id}`;
  } else if (provider === 'substack') {
    if (!onDomain('substack.com')) return { error: 'Open a Substack recording first.' };
    let preloads = window._preloads;
    if (typeof preloads === 'string') {
      try { preloads = JSON.parse(preloads); }
      catch { return { error: 'Could not read Substack recording metadata. Reload the page.' }; }
    }
    const post = preloads?.post || preloads?.body?.post;
    const upload = post?.videoUpload || post?.video_upload || post?.podcastUpload;
    duration = Number(upload?.duration) || duration;
    const playbackId = upload?.mux_playback_id;
    if (playbackId) {
      const stream = performance.getEntriesByType('resource').slice().reverse().find(entry => {
        try {
          const resource = new URL(entry.name);
          return resource.hostname === 'stream.mux.com' && resource.pathname === `/${playbackId}.m3u8`;
        } catch { return false; }
      });
      if (stream) {
        url = stream.name;
        resolved = true;
      }
    }
    // Prefer the playing recording's URL, never podcastPreviewUpload.
    const current = media?.currentSrc || media?.src;
    if (!url && current?.startsWith('https:') && (!upload?.id || current.includes(upload.id))) {
      url = current;
    } else if (!url && upload?.id) {
      const type = post.videoUpload || post.video_upload ? 'video' : 'audio';
      url = `${location.origin}/api/v1/${type}/upload/${encodeURIComponent(upload.id)}/src?preview=false&type=hls`;
    }
    if (!url) return { error: 'No accessible full recording was found on this post.' };
  } else if (provider === 'spotify') {
    const match = host === 'open.spotify.com' &&
      location.pathname.match(/^\/(?:intl-[a-z-]+\/)?episode\/([A-Za-z0-9]{22})\/?$/);
    if (!match) return { error: 'Open a Spotify podcast episode first.' };
    // The helper independently resolves the public publisher feed. Never forward
    // Spotify playback URLs, preview clips, or browser authentication.
    return { url: `https://open.spotify.com/episode/${match[1]}`,
      source: `https://open.spotify.com/episode/${match[1]}`, name: title };
  } else if (provider === 'stream') {
    if (!onDomain('sharepoint.com') && !onDomain('sharepoint-df.com') && !onDomain('microsoftstream.com')) {
      return { error: 'Open the recording in Stream or SharePoint to transcribe it locally.' };
    }
    // Require an actual enabled download link. A playable blob is not evidence
    // that an organization permits downloading or exporting this recording.
    const link = [...document.querySelectorAll('a[href]')].find(element => {
      const label = `${element.textContent} ${element.getAttribute('aria-label') || ''}`;
      return /download/i.test(label) && element.getAttribute('aria-disabled') !== 'true' &&
        element.getClientRects().length && /^https:/i.test(element.href);
    });
    if (!link) {
      return { error: 'No enabled recording-download link is available. Open the recording in Stream/SharePoint ' +
        'and ensure downloading is permitted; protected recordings are not bypassed.' };
    }
    url = link.href;
  } else {
    return { error: 'Unsupported recording provider.' };
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    return { error: 'The full recording duration is not available. Let the player load and try again.' };
  }
  if (provider !== 'youtube' && !resolved) {
    // Resolve same-origin authenticated redirects inside the signed-in browser.
    // No browser cookies are exported to the helper.
    try {
      const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(20000) });
      if (!response.ok) return { error: `Recording access returned HTTP ${response.status}.` };
      if (response.body) await response.body.cancel();
      url = response.url;
    } catch (error) {
      return { error: 'Could not resolve the recording download: ' + error.message };
    }
  }
  return { url, duration, name: title,
    source: provider === 'youtube' ? url : `${location.origin}${location.pathname}` };
}

async function startJob(message) {
  const { [JOB_KEY]: previous } = await chrome.storage.local.get(JOB_KEY);
  if (previous && !['complete', 'failed'].includes(previous.state)) return previous;
  const job = {
    id: crypto.randomUUID(), state: 'resolving', tabId: message.tabId,
    createdAt: Date.now(),
    message: 'Finding the full recording for local Whisper...',
  };
  await storeJob(job);
  try {
    await native({ command: 'ping' });
    const tab = await chrome.tabs.get(message.tabId);
    if (tab.url !== message.tabUrl) throw new Error('The tab navigated. Reopen the extension and try again.');
    const results = await chrome.scripting.executeScript({
      target: { tabId: message.tabId, allFrames: message.provider === 'stream' },
      world: 'MAIN', func: resolveRecording, args: [message.provider],
    });
    const recording = results?.find(result => result.result?.url)?.result;
    if (!recording) throw new Error(results?.find(result => result.result?.error)?.result.error ||
      'No accessible recording was found.');
    const status = await native({
      command: 'start', id: job.id, url: recording.url, source: recording.source,
      name: message.name || (message.provider === 'spotify' ? '' : recording.name),
      format: message.format === 'vtt' ? 'vtt' : 'md',
      duration: recording.duration,
    });
    const next = { ...job, ...status };
    await storeJob(next);
    await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
    return next;
  } catch (error) {
    const failed = { ...job, state: 'failed', message: error.message };
    await storeJob(failed);
    return failed;
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === POLL_ALARM) pollJob().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  pollJob().then(job => {
    if (job && !['complete', 'failed'].includes(job.state)) {
      return chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
    }
  }).catch(console.error);
});
let starting = null;
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('popup.html'))) return false;
  if (message.type === 'transcribe' && !starting) {
    starting = startJob(message).finally(() => { starting = null; });
  }
  const operation = message.type === 'transcribe' ? starting :
    message.type === 'transcription-dismiss' ? dismissJob() :
    message.type === 'transcription-status' ? acknowledgeJob() : null;
  if (!operation) return false;
  operation.then(job => respond({ job }), error => respond({ error: error.message }));
  return true;
});
