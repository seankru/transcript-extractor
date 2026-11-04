import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const start = source.indexOf('  async function readTranscriptPanel(');
const end = source.indexOf('\n  function fillCueEndTimes', start);
const panelFunction = source.slice(start, end);

function environment({ language = 'English', rows, loading = false, changeVideo = false,
  search = '', panelPresent = true, openButton = true, virtual = false } = {}) {
  const cue = (start, text, end) => ({
    data: { startMs: start, endMs: end },
    querySelector: selector => selector === '.segment-text' ? { textContent: text } : null,
  });
  const first = cue('0', 'First line', '1000');
  const last = cue('95000', 'Final line', '98000');
  const scroller = {
    scrollTop: 10, clientHeight: 100,
    get scrollHeight() { return virtual ? 400 : 100; },
  };
  let ticks = 0;
  const footer = {
    data: { languageMenu: { sortFilterSubMenuRenderer: { title: language } } },
    querySelector: () => null,
  };
  const panel = {
    isConnected: true,
    getClientRects: () => [{}],
    getAttribute: () => 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED',
    querySelector(selector) {
      if (selector === 'ytd-transcript-segment-renderer') return first;
      if (selector === 'ytd-transcript-footer-renderer') return footer;
      if (selector === '#segments-container') return scroller;
      if (selector.includes('input')) return search ? { value: search } : null;
      if (selector.includes('continuation')) return loading ? {} : null;
      return null;
    },
    querySelectorAll: () => rows || (virtual ? scroller.scrollTop < 200 ? [first] : [last] : [first, last]),
  };
  const context = vm.createContext({
    URL, location: { href: 'https://www.youtube.com/watch?v=abc' },
    document: {
      querySelectorAll(selector) {
        if (selector.includes('section-list')) return panelPresent ? [panel] : [];
        return openButton ? [{ disabled: false, getClientRects: () => [{}], click() { panelPresent = true; } }] : [];
      },
    },
    getPlayerResponse: () => ({ videoDetails: { videoId: changeVideo && ticks > 1 ? 'different' : 'abc' } }),
    trackName: track => track.name.simpleText,
    cleanText: value => String(value || '').replace(/\s+/g, ' ').trim(),
    setTimeout(callback) { ticks++; callback(); },
  });
  vm.runInContext(panelFunction, context);
  return {
    run: () => context.readTranscriptPanel({ name: { simpleText: 'English' } }, 'abc', 100000),
    scroller, panel, footer, cue,
  };
}

test('panel fallback captures complete timestamped rows and restores scroll', async () => {
  const env = environment();
  const result = await env.run();
  assert.equal(result.cues.length, 2);
  assert.equal(result.cues[1].startMs, 95000);
  assert.equal(result.cues[1].text, 'Final line');
  assert.equal(env.scroller.scrollTop, 10);
});

test('virtualized transcript is scrolled through, deduplicated and restored', async () => {
  const env = environment({ virtual: true });
  const result = await env.run();
  assert.equal(result.cues.length, 2);
  assert.equal(result.cues[0].startMs, 0);
  assert.equal(result.cues[1].startMs, 95000);
  assert.equal(env.scroller.scrollTop, 10);
});

test('opens native transcript control when panel is not already open', async () => {
  assert.equal((await environment({ panelPresent: false }).run()).cues.length, 2);
});

test('missing panel reports retrieval failure without authorizing Whisper', async () => {
  const result = await environment({ panelPresent: false, openButton: false }).run();
  assert.match(result.error, /Open YouTube's Show transcript/);
  assert.equal(result.canTranscribe, undefined);
});

test('different panel language or auto-generated track is not silently relabelled', async () => {
  for (const language of ['English (auto-generated)', 'German', '']) {
    const result = await environment({ language }).run();
    assert.match(result.error, /does not match/);
    assert.equal(result.canTranscribe, undefined);
  }
});

test('panel fallback switches its native menu to the explicitly selected language', async () => {
  const env = environment({ language: 'French' });
  let opened = false;
  const button = {
    getClientRects: () => [{}],
    getAttribute: () => null,
    click() { opened = !opened; }
  };
  env.footer.querySelector = () => button;
  const option = {
    textContent: 'English',
    getClientRects: () => [{}],
    getAttribute: () => null,
    click() { env.footer.data.languageMenu.sortFilterSubMenuRenderer.title = 'English'; }
  };
  const context = vm.createContext({
    document: {
      querySelectorAll: selector => selector.includes('section-list') ? [env.panel] : opened ? [option] : []
    },
    getPlayerResponse: () => ({ videoDetails: { videoId: 'abc' } }),
    trackName: track => track.name.simpleText,
    cleanText: value => String(value || '').trim(),
    setTimeout: callback => callback()
  });
  vm.runInContext(panelFunction, context);
  const result = await context.readTranscriptPanel({ name: { simpleText: 'English' } }, 'abc', 100000);
  assert.equal(result.cues.length, 2);
  assert.equal(env.footer.data.languageMenu.sortFilterSubMenuRenderer.title, 'English');
});

test('active search, navigation, loading continuation and partial coverage fail explicitly', async () => {
  for (const options of [{ search: 'query' }, { changeVideo: true }, { loading: true }]) {
    const result = await environment(options).run();
    assert.ok(result.error);
    assert.equal(result.cues, undefined);
  }
  const env = environment();
  env.panel.querySelectorAll = () => [env.cue('0', 'Preview', '4000')];
  assert.match((await env.run()).error, /full recording/);
});

test('the live YouTube text search input cannot produce a filtered download', async () => {
  const env = environment();
  const original = env.panel.querySelector;
  env.panel.querySelector = selector => selector.includes('input#transcript-search-box-input')
    ? { value: 'filtered words' } : original(selector);
  assert.match((await env.run()).error, /Clear the transcript search/);
});

test('timestamp text is supported and malformed rows never produce partial success', async () => {
  const env = environment();
  const row = {
    querySelector: selector => ({ textContent: selector === '.segment-text' ? 'Last cue' : '1:35' }),
  };
  env.panel.querySelectorAll = () => [row];
  assert.equal((await env.run()).cues[0].startMs, 95000);
  row.querySelector = selector => ({ textContent: selector === '.segment-text' ? 'Last cue' : 'unreadable' });
  assert.match((await env.run()).error, /unreadable/);
});

test('source code prefers creator captions in popup and routes failed fetches to panel first', () => {
  assert.match(source, /trackEl\.value = String\(discoveredTracks\[0\]\.index\)/);
  assert.match(source, /panelResult = await readTranscriptPanel\(track, currentVideoId/);
  assert.match(source, /source: panelResult \? 'transcript-panel' : 'caption-track'/);
});

test('full injected extraction saves panel captions in both formats after empty or failed requests', async () => {
  for (const format of ['md', 'vtt']) {
    for (const networkFailure of [false, true]) {
      const env = environment();
      const blobs = [];
      const downloads = [];
      const response = {
        videoDetails: { videoId: 'abc', title: 'Published video', lengthSeconds: '100' },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
          languageCode: 'en', name: { simpleText: 'English' }, vssId: '.en',
          baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en',
        }] } },
      };
      const document = {
        querySelectorAll: selector => selector.includes('section-list') ? [env.panel] : [],
        getElementById: () => ({ getPlayerResponse: () => response }),
        createElement: () => ({ click() { downloads.push(this.download); }, remove() {} }),
        body: { appendChild() {} },
        title: 'Published video',
      };
      class TestURL extends URL {
        static createObjectURL(blob) { blobs.push(blob); return 'blob:download'; }
        static revokeObjectURL() {}
      }
      const context = vm.createContext({
        document, window: {}, location: { href: 'https://www.youtube.com/watch?v=abc' },
        URL: TestURL, Blob, TextEncoder, AbortSignal,
        fetch: async () => {
          if (networkFailure) throw new TypeError('Network unavailable');
          return { ok: true, status: 200, text: async () => '' };
        },
        setTimeout(callback, delay) { if (delay < 1000) callback(); },
      });

      vm.runInContext(source.slice(source.indexOf('async function extractAndDownload(')), context);
      const result = await context.extractAndDownload(0, 'panel regression', format, 'abc');
      assert.equal(result.source, 'transcript-panel');
      assert.equal(result.cueCount, 2);
      assert.equal(result.isAutoGenerated, false);
      assert.equal(result.canTranscribe, undefined);
      assert.equal(downloads[0], `panel regression-English.${format}`);
      const text = await blobs[0].text();
      assert.match(text, /First line/);
      assert.match(text, /Final line/);
      assert.match(text, format === 'md' ? /^# Published video/ : /^WEBVTT/);
      assert.equal(env.scroller.scrollTop, 10);
    }
  }
});

test('a stale selected track is rejected before fetching, including when tracks disappear', async () => {
  const expected = { name: 'French', languageCode: 'fr', vssId: '.fr', isAutoGenerated: false };
  for (const tracks of [[], [{
    name: { simpleText: 'English' }, languageCode: 'en', vssId: '.en', baseUrl: 'https://www.youtube.com/api/timedtext'
  }]]) {
    const context = vm.createContext({
      URL, location: { href: 'https://www.youtube.com/watch?v=abc' },
      document: { getElementById: () => ({ getPlayerResponse: () => ({
        videoDetails: { videoId: 'abc' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } }
      }) }) },
      fetch: () => assert.fail('A stale selection must not fetch another track')
    });
    vm.runInContext(source.slice(source.indexOf('async function extractAndDownload(')), context);
    const result = await context.extractAndDownload(0, null, 'md', 'abc', expected);
    assert.match(result.error, /Caption tracks changed/);
    assert.equal(result.canTranscribe, undefined);
  }
});

test('direct extraction fetches the explicitly selected language and manual/ASR identity in either format', async () => {
  const tracks = [
    { name: { simpleText: 'English (auto-generated)' }, languageCode: 'en', kind: 'asr', vssId: 'a.en',
      baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr' },
    { name: { simpleText: 'French' }, languageCode: 'fr', vssId: '.fr',
      baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=fr' }
  ];
  for (const format of ['md', 'vtt']) {
    for (const index of [0, 1]) {
      const requests = [];
      let payload;
      const track = tracks[index];
      const context = vm.createContext({
        document: {
          getElementById: () => ({ getPlayerResponse: () => ({
            videoDetails: { videoId: 'abc', title: 'Video' },
            captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } }
          }) }),
          createElement: () => ({ click() {}, remove() {} }),
          body: { appendChild() {} }
        },
        window: {}, URL: class extends URL {
          static createObjectURL(blob) { payload = blob; return 'blob:download'; }
          static revokeObjectURL() {}
        },
        location: { href: 'https://www.youtube.com/watch?v=abc' },
        Blob, TextEncoder, AbortSignal, setTimeout() {},
        fetch: async url => {
          requests.push(new URL(url));
          return { ok: true, status: 200, text: async () => JSON.stringify({
            events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: track.languageCode === 'fr' ? 'Bonjour' : 'Hello' }] }]
          }) };
        }
      });
      vm.runInContext(source.slice(source.indexOf('async function extractAndDownload(')), context);
      const result = await context.extractAndDownload(index, 'selected', format, 'abc', {
        name: track.name.simpleText, languageCode: track.languageCode,
        vssId: track.vssId, isAutoGenerated: track.kind === 'asr'
      });
      assert.equal(result.source, 'caption-track');
      assert.equal(result.languageCode, track.languageCode);
      assert.equal(result.isAutoGenerated, track.kind === 'asr');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].searchParams.get('lang'), track.languageCode);
      assert.equal(requests[0].searchParams.get('kind') === 'asr', track.kind === 'asr');
      assert.match(await payload.text(), track.languageCode === 'fr' ? /Bonjour/ : /Hello/);
    }
  }
});

test('Shorts refreshes captions through shorts-player, never the hidden watch player, without a panel', async () => {
  for (const format of ['md', 'vtt']) {
    let restored = false;
    let selected = false;
    let payload;
    const rawUrl = 'https://www.youtube.com/api/timedtext?v=short1&lang=iw&kind=asr';
    const runtimeUrl = rawUrl + '&pot=native&c=WEB';
    const track = { languageCode: 'iw', kind: 'asr', vssId: 'a.iw', name: { simpleText: 'Hebrew (auto-generated)' }, baseUrl: rawUrl };
    const player = {
      getPlayerResponse: () => ({ videoDetails: { videoId: 'short1', title: 'A Short', lengthSeconds: '50' },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [track] } } }),
      getOptions: () => ['captions'],
      getOption: (module, key) => key === 'tracklist' ? [track] : { vssId: 'a.en' },
      setOption(module, key, value) {
        if (value.vssId === 'a.iw') selected = true;
        if (selected && value.vssId === 'a.en') restored = true;
      }
    };
    const context = vm.createContext({
      document: {
        getElementById(id) { assert.equal(id, 'shorts-player'); return player; },
        querySelectorAll: () => assert.fail('Shorts extraction must not need a transcript panel'),
        createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} }
      },
      location: { href: 'https://www.youtube.com/shorts/short1' }, window: {},
      performance: { now: () => 10, getEntriesByType: () => selected ? [{ name: runtimeUrl, startTime: 11 }] : [] },
      URL: class extends URL {
        static createObjectURL(blob) { payload = blob; return 'blob:short'; }
        static revokeObjectURL() {}
      },
      Blob, TextEncoder, AbortSignal,
      setTimeout(callback, delay) { if (delay < 1000) callback(); },
      fetch: async url => ({ ok: true, status: 200, text: async () => url.includes('c=WEB')
        ? JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 49000, segs: [{ utf8: 'Hebrew caption text' }] }] }) : '' })
    });
    vm.runInContext(source.slice(source.indexOf('async function extractAndDownload(')), context);
    const result = await context.extractAndDownload(0, 'short', format, 'short1');
    assert.equal(result.source, 'caption-track');
    assert.equal(result.filename, `short-Hebrew (auto-generated).${format}`);
    assert.equal(result.languageCode, 'iw');
    assert.equal(result.canTranscribe, undefined);
    assert.equal(restored, true);
    assert.match(await payload.text(), /Hebrew caption text/);
  }
});

test('language sorting puts preferred English first without losing original extraction indices', () => {
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function sortCaptionTracks('),
    source.indexOf('async function loadCaptionTracks(')), context);
  const tracks = [
    { index: 0, languageCode: 'ar', isAutoGenerated: true },
    { index: 1, languageCode: 'de', isAutoGenerated: false },
    { index: 2, languageCode: 'en', isAutoGenerated: true },
    { index: 3, languageCode: 'en-GB', isAutoGenerated: false },
    { index: 4, languageCode: 'en-US', isAutoGenerated: false },
    { index: 5, languageCode: 'fr', isAutoGenerated: false },
  ];
  const indices = languages => Array.from(context.sortCaptionTracks(tracks, languages), track => track.index);
  assert.deepEqual(indices(['en-US', 'fr', 'de']), [4, 3, 2, 5, 1, 0]);
  assert.deepEqual(indices(['en_US']), [4, 3, 2, 1, 5, 0]);
  assert.deepEqual(indices(['ar']), [0, 1, 3, 4, 5, 2]);
  assert.deepEqual(tracks.map(track => track.index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(Array.from(context.sortCaptionTracks([
    tracks[0], tracks[2]
  ], ['en-US']), track => track.index), [2, 0]);
  assert.deepEqual(Array.from(context.sortCaptionTracks([
    tracks[0], tracks[4]
  ], ['ja']), track => track.index), [0, 4]);
  assert.equal(context.sortCaptionTracks([], ['en-US']).length, 0);
});

test('popup defaults to first preferred publisher track but forwards a user-selected language or ASR version unchanged', async () => {
  const tracks = [
    { index: 0, name: 'English (auto-generated)', languageCode: 'en', vssId: 'a.en', isAutoGenerated: true },
    { index: 1, name: 'English', languageCode: 'en', vssId: '.en', isAutoGenerated: false },
    { index: 2, name: 'French', languageCode: 'fr', vssId: '.fr', isAutoGenerated: false },
  ];
  for (const index of [0, 2]) {
    const elements = new Map();
    const element = id => {
      if (!elements.has(id)) elements.set(id, {
        value: '', disabled: false, textContent: '', children: [], events: {},
        classList: { toggle() {} },
        appendChild(option) { this.children.push(option); if (!this.value) this.value = option.value; },
        addEventListener(name, callback) { this.events[name] = callback; },
        get selectedOptions() { return this.children.filter(option => option.value === this.value); }
      });
      return elements.get(id);
    };
    const calls = [];
    const context = vm.createContext({
      URL,
      navigator: { languages: ['en-US', 'en'], language: 'en-US' },
      document: { getElementById: element, createElement: () => ({}), querySelector: () => ({ value: 'md' }) },
      localTranscription: { busy: false, restore: async () => {} },
      chrome: {
        tabs: { query: async () => [{ id: 7, url: 'https://www.youtube.com/watch?v=abc' }] },
        scripting: { executeScript: async ({ func, args }) => {
          if (func.name === 'discoverCaptionTracks') return [{ result: { tracks, videoId: 'abc' } }];
          calls.push(args);
          return [{ result: { cueCount: 2, byteCount: 100, filename: 'captions.md', trackName: tracks[index].name } }];
        } }
      },
      discoverCaptionTracks: function discoverCaptionTracks() {},
      extractAndDownload: function extractAndDownload() {}
    });
    vm.runInContext(source.slice(0, source.indexOf('// Injected functions must')), context);
    await new Promise(setImmediate);
    assert.equal(element('track').value, '1');
    assert.equal(element('track').children[0].textContent, 'English');
    assert.equal(element('track').children[1].textContent, 'English (auto-generated)');
    element('track').value = String(index);
    element('track').events.change();
    await element('extract').events.click();
    assert.equal(calls[0][0], index);
    assert.equal(calls[0][4].languageCode, tracks[index].languageCode);
    assert.equal(calls[0][4].isAutoGenerated, tracks[index].isAutoGenerated);
    assert.equal(element('track').disabled, false);
  }
});
