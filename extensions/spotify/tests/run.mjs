import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const injected = source.slice(source.indexOf('async function extractAndDownload'));
const id = '2SrZHaBoktCM0hlfk8NObx';
const uri = `spotify:episode:${id}`;
const title = 'Episode \u05e9\u05dc\u05d5\u05dd';
const fullSections = () => [
  { startMs: 0, title: { title: 'Speaker 1' } },
  { startMs: 0, text: { sentence: { text: 'Hello <everyone>', highlight: [{ startMs: 1000 }] } } },
  { startMs: 10000, title: { title: 'Speaker 2' } },
  { startMs: 10000, text: { sentence: { text: '\u05e9\u05dc\u05d5\u05dd', highlight: [{ startMs: 90000 }] } } },
  { startMs: 91000, musicClosedCaption: { text: 'Music playing', endMs: 100000 } },
];

function environment({ sections = fullSections(), host = 'open.spotify.com',
  path = `/episode/${id}`, transcriptTab = true, transcriptId = id, episodeName = title,
  loaded = true, metadataStatus = 200 } = {}) {
  const blobs = [];
  const downloads = [];
  const data = { section: sections, episodeName };
  const element = { '__reactFiber$test': {
    memoizedProps: {
      episodeUri: `spotify:episode:${transcriptId}`,
      readAlongUrl: `https://spclient.wg.spotify.com/transcript-read-along/v2/episode/${transcriptId}`,
    },
    memoizedState: { memoizedState: { data } },
  } };
  let clicks = 0;
  const state = { entities: { items: {
    [uri]: { id, name: title, duration: { totalMilliseconds: 100000 } },
  } } };
  const context = vm.createContext({
    location: { hostname: host, pathname: path }, TextDecoder, Uint8Array, atob, AbortSignal,
    DOMParser: class {
      parseFromString() {
        return { getElementById: () => ({ textContent: Buffer.from(JSON.stringify(state)).toString('base64') }) };
      }
    },
    fetch: async () => ({ ok: metadataStatus === 200, status: metadataStatus, text: async () => '' }),
    document: {
      querySelector: () => transcriptTab ? { click() { clicks++; }, getAttribute: () => 'false' } : null,
      getElementById: () => loaded ? { children: [element] } : null,
      createElement: () => ({ click() { downloads.push(this.download); } }),
    },
    Blob, URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:download'; }, revokeObjectURL() {} },
    setTimeout: (callback, delay) => { if (delay < 1000) callback(); },
  });
  vm.runInContext(injected, context);
  return { extract: (format = 'md', name = '') => context.extractAndDownload(name, format),
    blobs, downloads, get clicks() { return clicks; } };
}

test('full published Markdown preserves speakers, Unicode, source and final coverage', async () => {
  const env = environment();
  const result = await env.extract();
  assert.equal(result.cueCount, 3);
  assert.equal(result.coverage, '00:01:40.000');
  assert.match(result.filename, /\u05e9\u05dc\u05d5\u05dd\.md$/);
  const text = await env.blobs[0].text();
  assert.match(text, /Speaker 1/);
  assert.match(text, /Speaker 2/);
  assert.match(text, /\u05e9\u05dc\u05d5\u05dd/);
  assert.match(text, new RegExp(`Source: https://open.spotify.com/episode/${id}`));
  assert.match(text, /Music playing/);
  assert.equal(env.clicks, 1);
});

test('WebVTT has valid intervals, escaped text and voice tags', async () => {
  const env = environment();
  await env.extract('vtt', 'NUL');
  assert.equal(env.downloads[0], 'Spotify transcript.vtt');
  const text = await env.blobs[0].text();
  assert.match(text, /^WEBVTT\n/);
  assert.match(text, /00:00:00\.000 --> 00:00:10\.000/);
  assert.match(text, /<v Speaker 1>Hello &lt;everyone&gt;<\/v>/);
  assert.match(text, /00:01:31\.000 --> 00:01:40\.000/);
});

test('preview, empty and malformed transcripts offer fallback without downloading', async () => {
  for (const sections of [
    fullSections().slice(0, 2), [], [{ startMs: -1, text: { sentence: { text: 'bad' } } }],
    [...fullSections(), { startMs: 1 }], [{ startMs: 200000 }],
  ]) {
    const env = environment({ sections });
    const result = await env.extract();
    assert.equal(result.canTranscribe, true);
    assert.equal(env.blobs.length, 0);
  }
});

test('exact 90 percent coverage threshold is enforced', async () => {
  for (const [endMs, accepted] of [[87999, false], [88000, true]]) {
    const env = environment({ sections: [{ startMs: 0, musicClosedCaption: { text: 'Music', endMs } }] });
    const result = await env.extract();
    assert.equal(Boolean(result.cueCount), accepted);
  }
});

test('missing tab or unloaded transcript offers fallback; stale episode data never downloads', async () => {
  for (const options of [{ transcriptTab: false }, { loaded: false },
    { transcriptId: '5w1J27rlNDSnyVXS6CFAxC' }, { episodeName: 'Other episode' }]) {
    const env = environment(options);
    assert.equal((await env.extract()).canTranscribe, true);
    assert.equal(env.downloads.length, 0);
  }
});

test('wrong host, music, show and failed metadata do not authorize transcription', async () => {
  for (const options of [{ host: 'example.com' }, { path: `/track/${id}` },
    { path: `/show/${id}` }, { metadataStatus: 403 }]) {
    const env = environment(options);
    const result = await env.extract();
    assert.ok(result.error);
    assert.equal(result.canTranscribe, undefined);
    assert.equal(env.downloads.length, 0);
  }
});

test('localized Spotify episode URLs work and names cannot escape Downloads', async () => {
  const env = environment({ path: `/intl-he/episode/${id}` });
  const result = await env.extract('md', '../../bad:name.vtt');
  assert.doesNotMatch(result.filename, /[\\/:]/);
  assert.match(result.filename, /\.md$/);
});
