import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const injected = source.slice(source.indexOf('async function extractAndDownload('));
assert.ok(injected.startsWith('async function extractAndDownload('));

const postId = 220448480;
const resource = (upload, file) =>
  `https://substackcdn.com/video_upload/post/${postId}/${upload}/123/${file}?signature=test`;
const fullVtt = resource('full', 'en.vtt');
const fullJson = resource('full', 'transcription.json');
const previewVtt = resource('preview', 'en.vtt');
const previewJson = resource('preview', 'transcription.json');
const vtt = 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\n<v SPEAKER_00>Opening sentence.\n\n' +
  '2\n00:22:30.000 --> 00:22:36.000\n<v SPEAKER_00>Final sentence.\n';
const sentences = [
  { start: 0, end: 5, text: 'Opening sentence.', words: [{}, {}], speaker: 'SPEAKER_00' },
  { start: 1350, end: 1356, text: 'Final sentence.', words: [{}, {}], speaker: 'SPEAKER_01' },
];
const transcript = (captionUrl = fullVtt, jsonUrl = fullJson, name = 'Full speaker') => ({
  signed_captions: [{ language: 'en', url: captionUrl }],
  cdn_url: jsonUrl,
  speaker_map: { SPEAKER_00: name, SPEAKER_01: name },
});
const preview = () => ({
  duration: 54.30857,
  transcription: transcript(previewVtt, previewJson, 'Preview speaker'),
});

async function extract(post, { format = 'vtt', stringify = false, extra = {}, responses = {}, raw } = {}) {
  const requests = [];
  const downloads = [];
  let payload;
  const preloads = { post: { id: postId, ...post }, ...extra };
  const document = {
    title: 'Test post - Test publication',
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild() {} },
    createElement: () => ({
      click() { downloads.push(this.download); },
      remove() {},
    }),
  };
  const context = vm.createContext({
    window: { _preloads: raw ?? (stringify ? JSON.stringify(preloads) : preloads) },
    document,
    Blob,
    URL: {
      createObjectURL(blob) { payload = blob; return 'blob:test'; },
      revokeObjectURL() {},
    },
    setTimeout() {},
    fetch: async url => {
      requests.push(url);
      if (url in responses) return responses[url];
      if (url === fullVtt) return { ok: true, text: async () => vtt };
      if (url === fullJson) return { ok: true, json: async () => sentences };
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  vm.runInContext(injected, context);
  const result = await context.extractAndDownload(null, format);
  return { result, requests, downloads, payload: payload ? await payload.text() : null };
}

for (const format of ['vtt', 'md']) {
  for (const stringify of [false, true]) {
    test(`${format}: preview-only captions never download (${stringify ? 'string' : 'object'} preloads)`, async () => {
      const { result, requests, downloads } = await extract({
        podcastPreviewUpload: preview(),
        videoUpload: { duration: 1356.8982, transcription: null, extractedAudio: { transcription: null } },
        podcastUpload: { duration: 1356.8523, transcription: null },
      }, { format, stringify });
      assert.match(result.error, /short podcast preview/);
      assert.match(result.error, /not the full recording/);
      assert.deepEqual(requests, []);
      assert.deepEqual(downloads, []);
    });
  }

  test(`${format}: full recording wins even when preview appears first`, async () => {
    const { result, requests, payload } = await extract({
      podcastPreviewUpload: preview(),
      videoUpload: { duration: 1356.8982, extractedAudio: { transcription: transcript() } },
    }, { format });
    assert.equal(result.error, undefined);
    assert.equal(result.sourceUrl, format === 'md' ? fullJson : fullVtt);
    assert.deepEqual(requests, format === 'md' ? [fullJson] : [fullVtt]);
    assert.match(payload, /Final sentence/);
    assert.match(payload, /Full speaker/);
    assert.doesNotMatch(payload, /Preview speaker/);
    assert.match(payload, format === 'md' ? /22:30/ : /00:22:36\.000/);
  });

  test(`${format}: sidebar transcript cannot fill missing primary captions`, async () => {
    const { result, requests } = await extract({
      videoUpload: { transcription: null },
    }, { format, extra: { recentPosts: [{ id: postId, transcription: transcript() }] } });
    assert.match(result.error, /No transcript was found/);
    assert.deepEqual(requests, []);
  });

  test(`${format}: missing primary JSON does not fall back to preview JSON`, async () => {
    const { result, requests, payload } = await extract({
      podcastPreviewUpload: preview(),
      videoUpload: {
        transcription: { signed_captions: [{ language: 'en', url: fullVtt }], speaker_map: { SPEAKER_00: 'Full speaker' } },
      },
    }, { format });
    assert.equal(result.error, undefined);
    assert.equal(result.source, format === 'md' ? 'vtt-heuristic' : 'vtt');
    assert.deepEqual(requests, [fullVtt]);
    assert.match(payload, /Final sentence/);
  });
}

test('direct video transcription and snake_case extracted audio remain supported', async () => {
  for (const post of [
    { videoUpload: { transcription: transcript() } },
    { video_upload: { extracted_audio: { transcription: transcript() } } },
    { videoUpload: { extracted_audio: { transcription: transcript() } } },
    { podcastUpload: { transcription: transcript() } },
  ]) {
    const { result, payload } = await extract(post, { format: 'md' });
    assert.equal(result.source, 'transcription-json');
    assert.equal(result.sentenceCount, 2);
    assert.match(payload, /Final sentence/);
  }
});

test('legacy post-scoped captions exclude previews and retain speaker mapping', async () => {
  const { result, requests, payload } = await extract({
    podcastPreviewUpload: preview(),
    captions: fullVtt,
    podcastFields: { speaker_map: { SPEAKER_00: 'Legacy speaker' } },
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(requests, [fullVtt]);
  assert.match(payload, /Legacy speaker/);
});

test('unparsed metadata containing preview uploads fails closed', async () => {
  const raw = `window._preloads = ${JSON.stringify({
    post: { id: postId, podcastPreviewUpload: preview(), videoUpload: { transcription: null } },
  })};`;
  const { result, requests, downloads } = await extract({}, { raw });
  assert.match(result.error, /Could not distinguish/);
  assert.deepEqual(requests, []);
  assert.deepEqual(downloads, []);
});

test('expired captions fail without downloading', async () => {
  const { result, downloads } = await extract({
    videoUpload: { transcription: transcript() },
  }, { responses: { [fullVtt]: { ok: false, status: 403 } } });
  assert.match(result.error, /HTTP 403/);
  assert.deepEqual(downloads, []);
});

test('unavailable full JSON falls back only to the full VTT', async () => {
  const { result, requests, payload } = await extract({
    podcastPreviewUpload: preview(),
    videoUpload: { extractedAudio: { transcription: transcript() } },
  }, { format: 'md', responses: { [fullJson]: { ok: false, status: 403 } } });
  assert.equal(result.source, 'vtt-heuristic');
  assert.deepEqual(requests, [fullJson, fullVtt]);
  assert.match(payload, /Final sentence/);
});

test('partial primary captions trigger local transcription without a misleading download', async () => {
  const { result, downloads } = await extract({
    videoUpload: { duration: 1356, transcription: transcript() },
  }, { responses: { [fullVtt]: { ok: true, text: async () =>
    'WEBVTT\n\n00:00:49.000 --> 00:00:54.000\nShort preview.\n' } } });
  assert.equal(result.canTranscribe, true);
  assert.match(result.error, /only part/);
  assert.deepEqual(downloads, []);
});

test('Markdown uses full published JSON without requiring published captions', async () => {
  const { result, requests, payload } = await extract({
    videoUpload: { duration: 1356, transcription: { cdn_url: fullJson } },
    podcastPreviewUpload: preview(),
  }, { format: 'md' });
  assert.equal(result.source, 'transcription-json');
  assert.deepEqual(requests, [fullJson]);
  assert.match(payload, /Final sentence/);
});

test('Markdown prefers full JSON even when captions are partial or expired', async () => {
  const { result, requests } = await extract({
    videoUpload: { duration: 1356, transcription: transcript() },
  }, { format: 'md', responses: { [fullVtt]: { ok: false, status: 403 } } });
  assert.equal(result.source, 'transcription-json');
  assert.deepEqual(requests, [fullJson]);
});

test('partial JSON falls back to full captions rather than saving a truncated transcript', async () => {
  const { result, requests, payload } = await extract({
    videoUpload: { duration: 1356, transcription: transcript() },
  }, { format: 'md', responses: { [fullJson]: { ok: true, json: async () => sentences.slice(0, 1) } } });
  assert.equal(result.source, 'vtt-heuristic');
  assert.deepEqual(requests, [fullJson, fullVtt]);
  assert.match(payload, /Final sentence/);
});

test('JSON-only partial transcripts trigger local transcription', async () => {
  const { result, downloads } = await extract({
    videoUpload: { duration: 1356, transcription: { cdn_url: fullJson } },
  }, { format: 'md', responses: { [fullJson]: { ok: true, json: async () => sentences.slice(0, 1) } } });
  assert.equal(result.canTranscribe, true);
  assert.deepEqual(downloads, []);
});

test('minute-only WebVTT timestamps remain supported', async () => {
  const { result } = await extract({
    videoUpload: { duration: 1356, transcription: transcript() },
  }, { responses: { [fullVtt]: { ok: true, text: async () => vtt.replaceAll('00:22:', '22:').replaceAll('00:00:', '00:') } } });
  assert.equal(result.error, undefined);
  assert.equal(result.cueCount, 2);
});
