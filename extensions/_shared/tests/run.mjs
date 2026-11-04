import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../transcription-worker.js', import.meta.url), 'utf8');
function environment({ host = 'pub.substack.com', preloads = {}, videos = [], links = [], player = null, resources = [] } = {}) {
  const jobs = {};
  const calls = [];
  const alarms = new Map();
  const badges = [];
  const chrome = {
    runtime: {
      id: 'test',
      getURL: path => `chrome-extension://test/${path}`,
      onMessage: { addListener(listener) { calls.listener = listener; } },
      onStartup: { addListener(listener) { calls.startup = listener; } },
      sendNativeMessage: async (_, message) => {
        calls.push(message);
        return { ok: true, id: message.id, state: message.command === 'status' ? 'complete' : 'queued',
          message: message.command === 'status' ? 'Saved transcript' : 'Queued' };
      },
    },
    tabs: { get: async () => ({ url: `https://${host}/p/post` }) },
    scripting: { executeScript: async ({ func, args }) => [{ result: await func(...args) }] },
    storage: { local: {
      get: async key => ({ [key]: jobs[key] }),
      set: async values => Object.assign(jobs, values),
      remove: async key => { delete jobs[key]; },
    } },
    alarms: {
      create: async (key, value) => alarms.set(key, value),
      clear: async key => alarms.delete(key),
      onAlarm: { addListener() {} },
    },
    action: { setBadgeText: async value => badges.push(value.text), setBadgeBackgroundColor: async () => {} },
  };
  const context = vm.createContext({
    chrome, console, crypto: { randomUUID: () => 'test-job' }, AbortSignal, URL,
    location: { hostname: host, origin: `https://${host}`, pathname: '/p/post', href: `https://${host}/p/post` },
    window: { _preloads: preloads },
    performance: { getEntriesByType: () => resources },
    document: {
      title: 'Recording',
      querySelectorAll: selector => selector === 'a[href]' ? links : videos,
      getElementById: () => player,
    },
    fetch: async url => {
      calls.push({ resolved: url });
      return { ok: true, url: 'https://stream.mux.com/full.m3u8', body: { cancel: async () => {} } };
    },
  });
  vm.runInContext(source, context);
  return { context, calls, jobs, alarms, chrome, badges };
}

test('all popup defaults are Markdown and all packages include background integration', () => {
  for (const name of ['stream', 'substack', 'youtube', 'spotify']) {
    const html = readFileSync(new URL(`../../${name}/popup.html`, import.meta.url), 'utf8');
    const manifest = JSON.parse(readFileSync(new URL(`../../${name}/manifest.json`, import.meta.url), 'utf8'));
    assert.match(html, /value="md" checked/);
    assert.doesNotMatch(html, /value="vtt" checked/);
    assert.match(html, /src="transcription-client.js"/);
    assert.match(html, /id="auto-transcribe" disabled/);
    assert.doesNotMatch(html, /id="auto-transcribe"[^>]*checked/);
    assert.match(html, /id="transcription-confirmation" hidden/);
    assert.match(html, /id="transcription-confirm"/);
    assert.match(html, /id="transcription-cancel"/);
    assert.equal(manifest.background.service_worker, 'transcription-worker.js');
    for (const permission of ['nativeMessaging', 'storage', 'alarms']) {
      assert.ok(manifest.permissions.includes(permission));
    }
  }
});

test('Substack resolves full recording, never preview upload', async () => {
  const { context, calls } = environment({
    preloads: { post: {
      videoUpload: { id: 'full', duration: 1356 },
      podcastPreviewUpload: { id: 'preview', duration: 54 },
    } },
    videos: [{ duration: 54, currentSrc: 'https://pub.substack.com/api/v1/video/upload/preview/src' }],
  });
  const result = await context.resolveRecording('substack');
  assert.equal(result.duration, 1356);
  assert.match(calls[0].resolved, /upload\/full\/src/);
  assert.match(calls[0].resolved, /preview=false/);
  assert.equal(result.url, 'https://stream.mux.com/full.m3u8');
});

test('Substack reuses only the primary playback ID signed manifest', async () => {
  const { context, calls } = environment({
    preloads: { post: { videoUpload: { id: 'full', duration: 1356, mux_playback_id: 'full-playback' } } },
    resources: [
      { name: 'https://stream.mux.com/full-playback.m3u8?token=full' },
      { name: 'https://stream.mux.com/preview-playback.m3u8?token=preview' },
    ],
  });
  const result = await context.resolveRecording('substack');
  assert.equal(result.url, 'https://stream.mux.com/full-playback.m3u8?token=full');
  assert.equal(calls.length, 0);
});

test('YouTube without captions resolves public recording for local transcription', async () => {
  const { context } = environment({
    host: 'www.youtube.com',
    player: { getPlayerResponse: () => ({
      playabilityStatus: { status: 'OK' },
      videoDetails: { videoId: '12345678901', lengthSeconds: '1356' },
    }) },
  });
  const result = await context.resolveRecording('youtube');
  assert.equal(result.url, 'https://www.youtube.com/watch?v=12345678901');
  assert.equal(result.duration, 1356);
});

test('YouTube playback restrictions never invoke download', async () => {
  const { context, calls } = environment({
    host: 'www.youtube.com',
    player: { getPlayerResponse: () => ({ playabilityStatus: { status: 'LOGIN_REQUIRED' } }) },
  });

  test('Spotify resolves only a canonical episode URL; no preview or credentials are forwarded', async () => {
    const { context, calls } = environment({ host: 'open.spotify.com',
      videos: [{ duration: 30, currentSrc: 'https://p.scdn.co/mp3-preview/preview' }] });
    context.location.pathname = '/episode/5w1J27rlNDSnyVXS6CFAxC';
    const result = await context.resolveRecording('spotify');
    assert.equal(result.url, 'https://open.spotify.com/episode/5w1J27rlNDSnyVXS6CFAxC');
    assert.equal(result.source, result.url);
    assert.equal(result.duration, undefined);
    assert.equal(calls.length, 0);
    context.location.pathname = '/track/5w1J27rlNDSnyVXS6CFAxC';
    assert.match((await context.resolveRecording('spotify')).error, /podcast episode/);
  });
  assert.match((await context.resolveRecording('youtube')).error, /does not permit/);
  assert.equal(calls.length, 0);
});

test('Stream does not infer export permission from playback', async () => {
  const { context, calls } = environment({
    host: 'tenant.sharepoint.com', videos: [{ duration: 1356, currentSrc: 'blob:private' }],
  });
  assert.match((await context.resolveRecording('stream')).error, /No enabled recording-download/);
  assert.equal(calls.length, 0);
});

test('wrong host and live recording are explicit errors', async () => {
  const wrong = environment({ host: 'example.com' });
  assert.match((await wrong.context.resolveRecording('substack')).error, /Open a Substack/);
  const live = environment({ preloads: { post: { videoUpload: { id: 'full' } } },
    videos: [{ duration: Infinity, currentSrc: 'blob:live' }] });
  assert.match((await live.context.resolveRecording('substack')).error, /duration/);
});

test('durable job is polled to completion and avoids duplicate downloads', async () => {
  const { context, calls, jobs, alarms } = environment({
    preloads: { post: { videoUpload: { id: 'full', duration: 1356 } } },
  });
  const message = { provider: 'substack', tabId: 1, tabUrl: 'https://pub.substack.com/p/post', format: 'md' };
  const first = await context.startJob(message);
  assert.equal(first.state, 'queued');
  await context.startJob(message);
  assert.equal(calls.filter(call => call.command === 'start').length, 1);
  assert.ok(alarms.has('local-transcription'));
  assert.equal((await context.pollJob()).state, 'complete');
  assert.equal(jobs.localTranscription.state, 'complete');
  assert.equal(alarms.size, 0);
  assert.equal(calls.find(call => call.command === 'start').format, 'md');
});

test('missing helper is visible and leaves retry enabled', async () => {
  const { context, chrome } = environment();
  chrome.runtime.sendNativeMessage = async () => { throw new Error('Host not found'); };
  const result = await context.startJob({ tabId: 1 });
  assert.equal(result.state, 'failed');
  assert.match(result.message, /install.ps1/);
});

test('interrupted recording resolution expires and permits retry', async () => {
  const { context, jobs } = environment();
  jobs.localTranscription = {
    id: 'interrupted', state: 'resolving', createdAt: Date.now() - 61000,
  };
  assert.equal((await context.pollJob()).state, 'failed');
  assert.match(jobs.localTranscription.message, /interrupted/);
});

test('native job starts only from this extension popup', () => {
  const { calls } = environment();
  const accepted = calls.listener({ type: 'transcribe' },
    { id: 'test', url: 'https://pub.substack.com/' }, () => {});
  assert.equal(accepted, false);
  assert.equal(calls.length, 0);
});

test('terminal badges clear on popup acknowledgment without discarding the result', async () => {
  for (const state of ['complete', 'failed']) {
    const { context, jobs, badges } = environment();
    await context.storeJob({ id: 'finished', state, message: 'Job result' });
    assert.equal(badges.at(-1), state === 'complete' ? 'Done' : '!');
    const job = await context.acknowledgeJob();
    assert.equal(badges.at(-1), '');
    assert.equal(job.message, 'Job result');
    assert.equal(jobs.localTranscription.acknowledged, true);
    await context.acknowledgeJob();
    assert.equal(badges.at(-1), '');
  }
});

test('opening popup preserves running badge and clears orphaned badges', async () => {
  const { context, jobs, badges } = environment();
  await context.acknowledgeJob();
  assert.equal(badges.at(-1), '');
  await context.storeJob({ id: 'working', state: 'resolving', createdAt: Date.now() });
  await context.acknowledgeJob();
  assert.equal(badges.at(-1), '...');
  assert.equal(jobs.localTranscription.acknowledged, undefined);
});

test('new extraction dismisses old terminal state but never discards an active job', async () => {
  const { context, jobs, badges } = environment();
  for (const state of ['complete', 'failed']) {
    jobs.localTranscription = { id: 'old', state, message: 'Old failure' };
    await context.dismissJob();
    assert.equal(jobs.localTranscription, undefined);
    assert.equal(badges.at(-1), '');
  }
  jobs.localTranscription = { id: 'active', state: 'transcribing' };
  await context.dismissJob();
  assert.equal(jobs.localTranscription.id, 'active');
});

const clientSource = readFileSync(new URL('../transcription-client.js', import.meta.url), 'utf8');
function popupEnvironment(settings = {}) {
  const elements = {};
  const calls = [];
  let failRead = false;
  let failWrite = false;
  for (const id of ['auto-transcribe', 'transcription-confirmation', 'transcription-confirm',
    'transcription-cancel', 'extract', 'status', 'track']) {
    elements[id] = {
      checked: false, hidden: true, disabled: false, textContent: '',
      classList: { add() {}, remove() {}, toggle() {} },
      listeners: {},
      addEventListener(event, listener) { this.listeners[event] = listener; },
    };
  }
  const context = vm.createContext({
    document: { getElementById: id => elements[id] },
    window: { addEventListener() {} },
    setTimeout() { return 1; }, clearTimeout() {},
    chrome: {
      storage: { local: {
        async get(key) {
          if (failRead) throw new Error('Storage read failed');
          return { [key]: settings[key] };
        },
        async set(values) {
          if (failWrite) throw new Error('Storage write failed');
          Object.assign(settings, values);
        },
      } },
      runtime: { async sendMessage(message) {
        calls.push(message);
        return message.type === 'transcribe'
          ? { job: { state: 'queued', message: 'Queued' } }
          : { job: { state: 'complete', message: 'Old completed job' } };
      } },
    },
  });
  vm.runInContext(clientSource + '\nglobalThis.client = localTranscription;', context);
  return {
    client: context.client, elements, calls,
    failRead() { failRead = true; }, failWrite() { failWrite = true; },
  };
}
const fallbackTab = { id: 42, url: 'https://pub.substack.com/p/post' };

test('changing transcript selection invalidates a pending Whisper confirmation', async () => {
  const popup = popupEnvironment();
  await popup.client.start('substack', fallbackTab, 'md', '');
  popup.elements.track.listeners.change();
  await popup.elements['transcription-confirm'].listeners.click();
  assert.equal(popup.elements['transcription-confirmation'].hidden, true);
  assert.match(popup.elements.status.textContent, /Transcript selection changed/);
  assert.equal(popup.calls.some(call => call.type === 'transcribe'), false);
});

test('default fallback prompts without invoking the helper, and cancel starts nothing', async () => {
  const { client, elements, calls } = popupEnvironment();
  await client.start('substack', fallbackTab, 'md', 'Title');
  assert.equal(elements['auto-transcribe'].checked, false);
  assert.equal(elements['transcription-confirmation'].hidden, false);
  assert.match(elements.status.textContent, /bandwidth and CPU/);
  assert.equal(client.busy, false);
  assert.equal(calls.length, 0);
  await client.restore();
  assert.match(elements.status.textContent, /Download the recording/);
  await elements['transcription-cancel'].listeners.click();
  assert.equal(elements['transcription-confirmation'].hidden, true);
  assert.equal(calls.filter(call => call.type === 'transcribe').length, 0);
});

test('confirmation queues exactly one job with the requested tab, format and filename', async () => {
  const { client, elements, calls } = popupEnvironment();
  await client.start('stream', fallbackTab, 'vtt', 'My recording');
  await Promise.all([
    elements['transcription-confirm'].listeners.click(),
    elements['transcription-confirm'].listeners.click(),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'stream');
  assert.equal(calls[0].tabId, 42);
  assert.equal(calls[0].tabUrl, fallbackTab.url);
  assert.equal(calls[0].format, 'vtt');
  assert.equal(calls[0].name, 'My recording');
  assert.equal(elements['transcription-confirmation'].hidden, true);
  assert.equal(client.busy, true);
});

test('automatic opt-in persists across popups; opting out restores confirmation', async () => {
  const settings = {};
  const first = popupEnvironment(settings);
  await first.client.start('youtube', fallbackTab, 'md', '');
  first.elements['auto-transcribe'].checked = true;
  first.elements['auto-transcribe'].listeners.change();
  await first.client.start('youtube', fallbackTab, 'md', '');
  assert.equal(settings.automaticLocalTranscription, true);
  assert.equal(first.calls.length, 1);

  const second = popupEnvironment(settings);
  await second.client.start('youtube', fallbackTab, 'md', '');
  assert.equal(second.elements['auto-transcribe'].checked, true);
  assert.equal(second.calls.length, 1);
  second.elements['auto-transcribe'].checked = false;
  second.elements['auto-transcribe'].listeners.change();
  const third = popupEnvironment(settings);
  await third.client.start('youtube', fallbackTab, 'md', '');
  assert.equal(third.calls.length, 0);
  assert.equal(third.elements['transcription-confirmation'].hidden, false);
});

test('preference read failures cannot silently authorize transcription', async () => {
  const popup = popupEnvironment({ automaticLocalTranscription: true });
  popup.failRead();
  await assert.rejects(popup.client.start('substack', fallbackTab, 'md', ''), /Storage read failed/);
  assert.equal(popup.calls.length, 0);
});

test('failed opt-in or opt-out cannot silently start transcription', async () => {
  for (const enabled of [false, true]) {
    const popup = popupEnvironment({ automaticLocalTranscription: enabled });
    await popup.client.restore();
    popup.failWrite();
    popup.elements['auto-transcribe'].checked = !enabled;
    popup.elements['auto-transcribe'].listeners.change();
    await assert.rejects(popup.client.start('substack', fallbackTab, 'md', ''), /Storage write failed/);
    assert.equal(popup.elements['auto-transcribe'].checked, enabled);
    assert.equal(popup.calls.filter(call => call.type === 'transcribe').length, 0);
  }
});

test('a new extraction discards an earlier unconfirmed request', async () => {
  const popup = popupEnvironment();
  await popup.client.start('substack', fallbackTab, 'md', '');
  popup.elements.extract.listeners.click();
  await popup.elements['transcription-confirm'].listeners.click();
  assert.equal(popup.calls.filter(call => call.type === 'transcribe').length, 0);
  assert.equal(popup.calls.at(-1).type, 'transcription-dismiss');
  assert.equal(popup.elements['transcription-confirmation'].hidden, true);
});

test('old terminal status cannot overwrite a new published extraction result', async () => {
  const popup = popupEnvironment();
  const restoring = popup.client.restore();
  popup.elements.extract.listeners.click();
  popup.elements.status.textContent = 'Published transcript saved';
  await restoring;
  await popup.client.restore();
  assert.equal(popup.elements.status.textContent, 'Published transcript saved');
});
