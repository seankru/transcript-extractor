import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const injected = source.slice(source.indexOf('async function extractAndDownload('),
  source.indexOf('\nfunction clickViewRecap('));

async function extract({ speaker = false, format = 'md', timestamps = true, rowsPresent = true,
  resource = false, metadata = null, selection, blocked = false } = {}) {
  let payload;
  const downloads = [];
  const requests = [];
  const metadataUrl = 'https://tenant.sharepoint.com/_api/v2.1/drives/drive/items/video?select=media%2Ftranscripts';
  const scroller = { scrollTop: 0, scrollHeight: 600, clientHeight: 300, scrollBy() {} };
  const rows = ['First sentence.', 'Final sentence.'].map((text, index) => ({
    id: `listItem-${index}`,
    parentElement: scroller,
    getBoundingClientRect: () => ({ width: 300, height: 40 }),
    querySelector(selector) {
      if (selector.includes('entryText-')) return {
        hasAttribute: () => true,
        getAttribute: name => name === 'aria-posinset' ? String(index + 1) : '2',
        cloneNode: () => ({ textContent: text, querySelectorAll: () => [] }),
      };
      if (selector.includes('baseTimestamp-')) {
        const recognized = speaker || selector.includes('timestamp-button');
        return timestamps && recognized ? { textContent: index ? '1:29' : '0:00' } : null;
      }
      if (selector.includes('itemDisplayName-') && speaker) return { textContent: 'Example speaker' };
      return null;
    },
  }));
  const context = vm.createContext({
    document: {
      title: 'Example.mp4',
      scrollingElement: scroller,
      body: { appendChild() {} },
      getElementById: () => null,
      querySelector: selector => selector.includes('aria-setsize') && rowsPresent
        ? { getAttribute: () => '2' } : null,
      querySelectorAll: selector => {
        if (selector.includes('listItemWithSpeaker-')) {
          return rowsPresent && (speaker || selector.includes('listItemNoSpeaker-')) ? rows : [];
        }
        return [];
      },
      createElement: () => ({ click() { downloads.push(this.download); }, remove() {} }),
    },
    performance: { getEntriesByType: () => metadata ? [{ name: metadataUrl }] : resource
      ? [{ name: 'https://tenant.sharepoint.com/media/transcripts/example/streamContent?format=json' }] : [] },
    fetch: async url => {
      requests.push(url);
      if (url === metadataUrl) return { ok: true, json: async () => ({ media: { transcripts: metadata } }) };
      return { ok: !blocked, status: blocked ? 403 : 200,
        text: async () => 'not captions',
        json: async () => ({ entries: [
          { startOffset: '00:00:00', endOffset: '00:00:05', text: url.includes('/fr') ? 'Phrase francaise.' : 'Published sentence.' },
        ] }) };
    },
    getComputedStyle: () => ({ overflowY: 'auto' }),
    setTimeout: callback => { callback(); return 1; },
    Blob, AbortSignal,
    URL: class extends URL {
      static createObjectURL(blob) { payload = blob; return 'blob:test'; }
      static revokeObjectURL() {}
    },
  });
  vm.runInContext(injected, context);
  const result = await context.extractAndDownload(null, format, null, selection);
  return { result, downloads, requests, payload: payload ? await payload.text() : null };
}

const metadata = [
  { id: 'original', languageTag: 'en-US', isDefault: true, isVisible: true, temporaryDownloadUrl: 'https://tenant.sharepoint.com/en?token=shortlived' },
  { id: 'translated', languageTag: 'fr-FR', isVisible: true, temporaryDownloadUrl: 'https://tenant.sharepoint.com/fr?token=shortlived' },
  { id: 'hidden', languageTag: 'de-DE', isVisible: false, temporaryDownloadUrl: 'https://tenant.sharepoint.com/de' }
];

test('Stream metadata discovery lists visible language variants without exporting or exposing download tokens', async () => {
  const { result, downloads, requests } = await extract({ metadata, selection: { discover: true } });
  assert.equal(result.tracks.length, 2);
  assert.match(result.tracks[0].label, /en-US - platform default/);
  assert.match(result.tracks[1].label, /fr-FR/);
  assert.doesNotMatch(JSON.stringify(result), /shortlived|de-DE/);
  assert.equal(requests.length, 1);
  assert.deepEqual(downloads, []);
});

for (const format of ['md', 'vtt']) {
  test(`${format}: Stream honors explicit non-default transcript rather than native download or current DOM`, async () => {
    const discovery = await extract({ metadata, selection: { discover: true } });
    const selection = { ...discovery.result.tracks[1], metadataUrl: discovery.result.metadataUrl };
    const { result, downloads, requests, payload } = await extract({ metadata, format, selection });
    assert.equal(result.mode, 'fetched');
    assert.equal(result.languageTag, 'fr-FR');
    assert.equal(result.filename, `Example-fr-FR.${format}`);
    assert.match(payload, /Phrase francaise/);
    assert.doesNotMatch(payload, /First sentence|Published sentence/);
    assert.equal(downloads.length, 1);
    assert.equal(requests.length, 2);
    assert.match(requests[1], /\/fr\?/);
  });
}

test('Stream refuses stale or unavailable explicit selections instead of scraping a different transcript', async () => {
  const discovery = await extract({ metadata, selection: { discover: true } });
  const selection = { ...discovery.result.tracks[1], metadataUrl: discovery.result.metadataUrl };
  for (const options of [{ metadata: metadata.slice(0, 1) }, { metadata, blocked: true },
    { metadata, selection: { ...selection, metadataUrl: 'different recording' } }]) {
    const { result, downloads } = await extract({ selection, ...options });
    assert.ok(result.error);
    assert.equal(result.canTranscribe, undefined);
    assert.deepEqual(downloads, []);
  }
});

test('Stream selection survives metadata reordering without relying on list indices', async () => {
  for (const list of [metadata, metadata.map(({ id, ...track }) => track)]) {
    const discovery = await extract({ metadata: list, selection: { discover: true } });
    const selection = { ...discovery.result.tracks[1], metadataUrl: discovery.result.metadataUrl };
    const { result, payload } = await extract({ metadata: [...list].reverse(), selection });
    assert.equal(result.languageTag, 'fr-FR');
    assert.match(payload, /Phrase francaise/);
  }
});

for (const format of ['md', 'vtt']) {
  for (const speaker of [false, true]) {
    test(`${format}: extracts ${speaker ? 'speaker-labelled' : 'speakerless Clipchamp'} rows`, async () => {
      const { result, downloads, payload } = await extract({ format, speaker });
      assert.equal(result.mode, 'scraped');
      assert.equal(result.canTranscribe, undefined);
      assert.equal(result.cueCount, 2);
      assert.equal(result.coverage, '00:01:29.000');
      assert.equal(downloads.length, 1);
      assert.match(payload, /First sentence/);
      assert.match(payload, /Final sentence/);
      assert.match(payload, /00:01:29/);
      if (speaker) assert.match(payload, /Example speaker/);
      else assert.doesNotMatch(payload, /Example speaker/);
    });
  }
}

test('published API transcript is preferred to Whisper even without recognized rows', async () => {
  const { result, payload } = await extract({ rowsPresent: false, resource: true });
  assert.equal(result.mode, 'fetched');
  assert.equal(result.canTranscribe, undefined);
  assert.match(payload, /Published sentence/);
});

test('no rows and no published resource permits the consent-gated fallback', async () => {
  const { result, downloads } = await extract({ rowsPresent: false });
  assert.equal(result.canTranscribe, true);
  assert.equal(downloads.length, 0);
});

test('unreadable timestamps produce an error, not an empty success-shaped download', async () => {
  const { result, downloads } = await extract({ timestamps: false });
  assert.match(result.error, /no readable timestamps/);
  assert.equal(result.rowCount, 2);
  assert.equal(downloads.length, 0);
});
