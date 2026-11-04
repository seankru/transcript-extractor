// Test harness for the YouTube caption extractor's pure logic.
//
// Run: node tests\run.mjs
//
// Most of the functions under test live inside the MAIN-world injected function
// in popup.js, which cannot be imported. Rather than copying them — which would
// drift from the shipped code silently — this harness reads popup.js and
// evaluates the named declarations it needs. A rename or deletion in popup.js
// fails the harness instead of letting it pass against a stale copy.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'popup.js'), 'utf8');

function extractFunction(name) {
  const marker = new RegExp(`\\n\\s*(?:async\\s+)?function ${name}\\s*\\(`);
  const match = marker.exec(source);
  if (!match) throw new Error(`popup.js no longer declares function ${name}`);

  const braceStart = source.indexOf('{', match.index + match[0].length - 1);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(match.index + 1, i + 1);
    }
  }
  throw new Error(`Unbalanced braces while extracting ${name}`);
}

const NAMES = [
  'cleanText', 'trackName', 'getPlayer', 'jsonToCues', 'decodeEntities', 'nodeTextWithBreaks',
  'xmlToCues', 'vttTime', 'shortTime', 'cuesToVtt', 'cuesToMarkdown',
  'fillCueEndTimes', 'isYouTubeCaptionHost', 'isYouTubeTabUrl',
  'captionUrlMatchesTrack', 'extractChapters', 'findAudioCaptionUrl',
  'findRuntimeCaptionUrl', 'fetchCaptionTrack', 'saveFile'
];

// xmlToCues is a supported extraction path and must be executed, not skipped.
// The previous harness guarded it on `typeof DOMParser === 'function'`, which is
// false under Node, so the suite printed SKIP and still exited 0 with the whole
// XML/SRV3 path unexercised. A test that cannot fail is not coverage.
let DOMParserImpl = globalThis.DOMParser;
if (typeof DOMParserImpl !== 'function') {
  try {
    ({ DOMParser: DOMParserImpl } = await import('@xmldom/xmldom'));
  } catch {
    console.error(
      'FAIL xmlToCues cannot run: no global DOMParser and @xmldom/xmldom is not installed.\n' +
      '  Install it (npm install) or run this suite in a browser.\n' +
      '  This is a hard failure by design: skipping leaves the XML/SRV3 path untested.'
    );
    process.exit(1);
  }
}

const preamble = 'const location = { href: "https://www.youtube.com/watch?v=abc" };\n';
const body = NAMES.map(extractFunction).join('\n');
// The globals below are read through globalThis rather than captured, so a test
// can install a fake player or fetch after the functions are built.
const api = new Function(
  'DOMParser',
  `${preamble}${body}\nreturn { ${NAMES.join(', ')} };`
)(DOMParserImpl);

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`);
  }
}

function checkTrue(name, value) {
  check(name, value === true, true);
}

// popup.js declares trackName and getPlayerResponse once in each injected
// function, because Chrome serializes those into the page's MAIN world and they
// must stay self-contained. extractFunction takes the first regex match, so the
// harness only ever tests one copy. Assert the copies are identical: without
// this, an edit to one of them diverges silently and the suite still passes.
function allDeclarations(name) {
  const marker = new RegExp(`\\n\\s*(?:async\\s+)?function ${name}\\s*\\(`, 'g');
  const bodies = [];
  let match;
  while ((match = marker.exec(source)) !== null) {
    const braceStart = source.indexOf('{', match.index + match[0].length - 1);
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) {
        bodies.push(source.slice(match.index + 1, i + 1).trim());
        break;
      }
    }
  }
  return bodies;
}

for (const duplicated of ['trackName', 'getPlayer', 'getPlayerResponse']) {
  const bodies = allDeclarations(duplicated);
  checkTrue(`${duplicated} copies in popup.js are identical (${bodies.length} found)`,
    bodies.length > 0 && bodies.every(body => body === bodies[0]));
}

// --- jsonToCues -------------------------------------------------------------
check('jsonToCues parses segs and skips empty events',
  api.jsonToCues({
    events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello ' }, { utf8: 'world' }] },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: '  \n ' }] },
      { tStartMs: 2000, segs: [{ utf8: 'no duration' }] },
      { tStartMs: 3000, dDurationMs: 500 }
    ]
  }),
  [
    { startMs: 0, endMs: 1000, text: 'hello world' },
    { startMs: 2000, endMs: 2000, text: 'no duration' }
  ]);

check('jsonToCues tolerates missing input', api.jsonToCues(null), []);

check('jsonToCues sorts out-of-order events so cue ends are correct',
  api.jsonToCues({
    events: [
      { tStartMs: 5000, segs: [{ utf8: 'later' }] },
      { tStartMs: 0, segs: [{ utf8: 'earlier' }] }
    ]
  }),
  [
    { startMs: 0, endMs: 0, text: 'earlier' },
    { startMs: 5000, endMs: 5000, text: 'later' }
  ]);

// --- decodeEntities ---------------------------------------------------------
check('decodeEntities resolves the second escaping level',
  api.decodeEntities('it&#39;s &amp; more &lt;tag&gt;'),
  "it's & more <tag>");
check('decodeEntities leaves unknown entities alone',
  api.decodeEntities('&notareal; text'), '&notareal; text');
check('decodeEntities handles hex references', api.decodeEntities('&#x27;'), "'");
// String.fromCodePoint throws RangeError above U+10FFFF; unguarded it aborted
// the entire XML fallback extraction.
check('decodeEntities leaves an out-of-range code point intact',
  api.decodeEntities('a &#x110000; b'), 'a &#x110000; b');
check('decodeEntities leaves a lone surrogate intact',
  api.decodeEntities('a &#xD800; b'), 'a &#xD800; b');

// --- fillCueEndTimes --------------------------------------------------------
check('fillCueEndTimes uses the next start when the duration is zero',
  api.fillCueEndTimes([
    { startMs: 0, endMs: 0, text: 'a' },
    { startMs: 1500, endMs: 1500, text: 'b' }
  ]),
  [
    { startMs: 0, endMs: 1500, text: 'a' },
    { startMs: 1500, endMs: 3500, text: 'b' }
  ]);

// --- time formatting --------------------------------------------------------
check('vttTime formats hours', api.vttTime(3723456), '01:02:03.456');
check('vttTime clamps negatives', api.vttTime(-5), '00:00:00.000');
check('shortTime drops the hour when zero', api.shortTime(65000), '01:05');
check('shortTime keeps the hour when present', api.shortTime(3665000), '1:01:05');

// --- cuesToVtt --------------------------------------------------------------
check('cuesToVtt escapes markup and arrows',
  api.cuesToVtt([{ startMs: 0, endMs: 1000, text: 'a & b <c> --> d' }]),
  ['WEBVTT', '', '00:00:00.000 --> 00:00:01.000', 'a &amp; b &lt;c&gt; --&gt; d', ''].join('\n'));

// --- cuesToMarkdown ---------------------------------------------------------
// Regression for the panel's top finding: chapters starting after the last cue
// were dropped from the file while the popup still reported them.
const trailing = api.cuesToMarkdown(
  [{ startMs: 0, text: 'a' }, { startMs: 10000, text: 'b' }],
  'Title',
  [
    { startMs: 0, title: 'Intro' },
    { startMs: 5000, title: 'Body' },
    { startMs: 60000, title: 'Outro' },
    { startMs: 90000, title: 'Credits' }
  ]
);
check('cuesToMarkdown emits chapters that start after the last cue',
  (trailing.markdown.match(/^## /gm) || []).length, 4);
check('cuesToMarkdown reports the count it actually wrote',
  trailing.chapterCount, 4);
checkTrue('cuesToMarkdown keeps trailing chapters in time order',
  trailing.markdown.indexOf('Outro') < trailing.markdown.indexOf('Credits'));
checkTrue('cuesToMarkdown places trailing chapters after the last cue line',
  trailing.markdown.indexOf('**[00:10]** b') < trailing.markdown.indexOf('Outro'));

const noChapters = api.cuesToMarkdown([{ startMs: 0, text: 'a' }], 'Title', []);
check('cuesToMarkdown reports zero when there are no chapters',
  noChapters.chapterCount, 0);
// A title containing a newline injected extra Markdown headings into the export.
check('cuesToMarkdown flattens a multi-line title into one heading',
  (api.cuesToMarkdown([{ startMs: 0, text: 'a' }], 'Real\n## Injected', []).markdown
    .match(/^#+ /gm) || []).length, 1);
check('cuesToMarkdown renders a heading and cue lines',
  noChapters.markdown, ['# Title', '', '**[00:00]** a', ''].join('\n'));

// A YouTube-supplied chapter title beginning with '##' produced a malformed
// heading line: '## [00:00] ## Real'.
check('cuesToMarkdown strips leading hashes from a chapter title',
  api.cuesToMarkdown([{ startMs: 0, text: 'a' }], 'Title',
    [{ startMs: 0, title: '## Sneaky' }]).markdown.split('\n')[2],
  '## [00:00] Sneaky');

// --- host allowlist ---------------------------------------------------------
checkTrue('isYouTubeCaptionHost accepts www.youtube.com',
  api.isYouTubeCaptionHost('www.youtube.com'));
checkTrue('isYouTubeCaptionHost accepts the apex domain',
  api.isYouTubeCaptionHost('youtube.com'));
checkTrue('isYouTubeCaptionHost accepts youtube-nocookie.com',
  api.isYouTubeCaptionHost('www.youtube-nocookie.com'));
check('isYouTubeCaptionHost rejects a lookalike suffix',
  api.isYouTubeCaptionHost('evil-youtube.com'), false);
check('isYouTubeCaptionHost rejects a prefixed lookalike',
  api.isYouTubeCaptionHost('youtube.com.evil.net'), false);

// --- popup-side tab origin check -------------------------------------------
checkTrue('isYouTubeTabUrl accepts a watch page',
  api.isYouTubeTabUrl('https://www.youtube.com/watch?v=abc'));
check('isYouTubeTabUrl rejects http', api.isYouTubeTabUrl('http://www.youtube.com/'), false);
check('isYouTubeTabUrl rejects an unrelated origin',
  api.isYouTubeTabUrl('https://intranet.example.com/'), false);
check('isYouTubeTabUrl rejects a lookalike host',
  api.isYouTubeTabUrl('https://notyoutube.com/watch?v=abc'), false);
check('isYouTubeTabUrl rejects a non-URL', api.isYouTubeTabUrl('about:blank'), false);

// --- captionUrlMatchesTrack -------------------------------------------------
const asrTrack = { languageCode: 'en', kind: 'asr', vssId: 'a.en', name: { simpleText: 'English' } };
checkTrue('captionUrlMatchesTrack accepts a matching timedtext URL',
  api.captionUrlMatchesTrack(
    'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&vssId=a.en', asrTrack, 'abc'));
check('captionUrlMatchesTrack rejects a different video',
  api.captionUrlMatchesTrack(
    'https://www.youtube.com/api/timedtext?v=zzz&lang=en&kind=asr', asrTrack, 'abc'), false);
check('captionUrlMatchesTrack rejects a non-timedtext path',
  api.captionUrlMatchesTrack('https://www.youtube.com/watch?v=abc', asrTrack, 'abc'), false);
// A resource-timing entry can come from any origin on the page; a third-party
// URL must not be able to hijack the POT fallback into a refused fetch.
check('captionUrlMatchesTrack rejects a non-YouTube host',
  api.captionUrlMatchesTrack(
    'https://evil.example.com/api/timedtext?v=abc&lang=en&kind=asr&vssId=a.en', asrTrack, 'abc'), false);
check('captionUrlMatchesTrack rejects http',
  api.captionUrlMatchesTrack(
    'http://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&vssId=a.en', asrTrack, 'abc'), false);
// Missing identifying parameters were treated as wildcards.
check('captionUrlMatchesTrack rejects a URL with no video id',
  api.captionUrlMatchesTrack(
    'https://www.youtube.com/api/timedtext?lang=en&kind=asr', asrTrack, 'abc'), false);
check('captionUrlMatchesTrack rejects a URL with no language',
  api.captionUrlMatchesTrack(
    'https://www.youtube.com/api/timedtext?v=abc&kind=asr', asrTrack, 'abc'), false);
// An absent kind was treated as a wildcard, so an ASR track matched a manual
// track's URL of the same language and isAutoGenerated was then reported from
// the requested track rather than the delivered one.
check('captionUrlMatchesTrack rejects an ASR track against a URL with no kind',
  api.captionUrlMatchesTrack(
    'https://www.youtube.com/api/timedtext?v=abc&lang=en&vssId=a.en', asrTrack, 'abc'), false);
const manualTrack = { languageCode: 'en', vssId: '.en', name: { simpleText: 'English' } };
check('captionUrlMatchesTrack rejects a manual track against an ASR URL',
  api.captionUrlMatchesTrack(
    'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&vssId=.en', manualTrack, 'abc'), false);
checkTrue('captionUrlMatchesTrack accepts a manual track against a kind-less URL',
  api.captionUrlMatchesTrack(
    'https://www.youtube.com/api/timedtext?v=abc&lang=en&vssId=.en', manualTrack, 'abc'));
check('captionUrlMatchesTrack rejects an explicit vssId that differs from the track',
  api.captionUrlMatchesTrack(
    'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&vssId=a.de', asrTrack, 'abc'), false);
// Real YouTube timed-text URLs do not consistently carry vssId even when the
// player-response track object does. The AI Native DevCon reproduction video
// exposes both shapes below; rejecting the missing parameter made both tracks
// visible in the popup but impossible to fetch through the POT fallbacks.
const devConManualTrack = {
  languageCode: 'en-US',
  vssId: '.en-US',
  name: { simpleText: 'English (United States)' }
};
checkTrue('captionUrlMatchesTrack accepts the DevCon manual URL without vssId',
  api.captionUrlMatchesTrack(
    'https://www.youtube.com/api/timedtext?v=tTcxVv8HHNw&lang=en-US',
    devConManualTrack,
    'tTcxVv8HHNw'));
checkTrue('captionUrlMatchesTrack accepts the DevCon ASR URL without vssId',
  api.captionUrlMatchesTrack(
    'https://www.youtube.com/api/timedtext?v=tTcxVv8HHNw&lang=en&kind=asr',
    asrTrack,
    'tTcxVv8HHNw'));
// With no known video id the v parameter was left unconstrained, so a POT
// fallback could accept another video's timedtext URL outright.
check('captionUrlMatchesTrack still requires a video id when none is known',
  api.captionUrlMatchesTrack(
    'https://www.youtube.com/api/timedtext?lang=en&kind=asr&vssId=a.en', asrTrack, null), false);
checkTrue('captionUrlMatchesTrack accepts any video id when none is known',
  api.captionUrlMatchesTrack(
    'https://www.youtube.com/api/timedtext?v=zzz&lang=en&kind=asr&vssId=a.en', asrTrack, null));

// --- extractChapters --------------------------------------------------------
check('extractChapters reads, cleans and sorts chapter markers',
  api.extractChapters({
    playerOverlays: {
      playerOverlayRenderer: {
        decoratedPlayerBarRenderer: {
          decoratedPlayerBarRenderer: {
            playerBar: {
              multiMarkersPlayerBarRenderer: {
                markersMap: [{
                  key: 'DESCRIPTION_CHAPTERS',
                  value: {
                    chapters: [
                      { chapterRenderer: { title: { simpleText: 'Second' }, timeRangeStartMillis: 5000 } },
                      { chapterRenderer: { title: { runs: [{ text: 'Fi' }, { text: 'rst' }] }, timeRangeStartMillis: 0 } },
                      { chapterRenderer: { title: { simpleText: '  ' }, timeRangeStartMillis: 9000 } }
                    ]
                  }
                }]
              }
            }
          }
        }
      }
    }
  }),
  [{ startMs: 0, title: 'First' }, { startMs: 5000, title: 'Second' }]);

check('extractChapters returns empty when the player response has none',
  api.extractChapters({}), []);

// markersMap is served in the /next response (window.ytInitialData) on real
// watch pages; reading only the player response most likely emitted no chapters.
const chaptersIn = (markers) => ({
  playerOverlays: {
    playerOverlayRenderer: {
      decoratedPlayerBarRenderer: {
        decoratedPlayerBarRenderer: {
          playerBar: { multiMarkersPlayerBarRenderer: { markersMap: markers } }
        }
      }
    }
  }
});
const initialDataChapters = chaptersIn([{
  key: 'DESCRIPTION_CHAPTERS',
  value: {
    chapters: [
      { chapterRenderer: { title: { simpleText: 'From ytInitialData' }, timeRangeStartMillis: 0 } }
    ]
  }
}]);

check('extractChapters falls back to ytInitialData when the player response has none',
  api.extractChapters({}, initialDataChapters),
  [{ startMs: 0, title: 'From ytInitialData' }]);

check('extractChapters ignores a ytInitialData markersMap with no chapter key',
  api.extractChapters({}, chaptersIn([{ key: 'AUTO_CHAPTERS', value: { chapters: [] } }])), []);

check('extractChapters tolerates a missing ytInitialData argument',
  api.extractChapters({}, undefined), []);

// ytInitialData is a page global that SPA navigation can leave pointing at a
// previously watched video, which would write the wrong video's chapters into
// the export. The player response is guarded by video id at the call site.
const staleInitialData = {
  ...initialDataChapters,
  currentVideoEndpoint: { watchEndpoint: { videoId: 'previous' } }
};
check('extractChapters ignores ytInitialData left on a previous video',
  api.extractChapters({}, staleInitialData, 'current'), []);

check('extractChapters uses ytInitialData when its video id matches',
  api.extractChapters({}, staleInitialData, 'previous'),
  [{ startMs: 0, title: 'From ytInitialData' }]);

check('extractChapters uses ytInitialData that carries no video id',
  api.extractChapters({}, initialDataChapters, 'current'),
  [{ startMs: 0, title: 'From ytInitialData' }]);

// --- functions the previous harness never loaded ----------------------------
// findAudioCaptionUrl, findRuntimeCaptionUrl, fetchCaptionTrack and saveFile
// were absent from NAMES, so the POT/player-internals code had zero coverage.
// These run in the page's MAIN world, so the browser globals they reach for are
// stubbed here rather than captured at build time.
globalThis.document = { getElementById: () => null };
globalThis.performance = globalThis.performance || { getEntriesByType: () => [] };

check('findAudioCaptionUrl returns null when the player is absent',
  api.findAudioCaptionUrl(asrTrack, 'abc'), null);

const potUrl = 'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&vssId=a.en&pot=TOKEN';
function fakePlayer(captionTracks) {
  globalThis.document = {
    getElementById: (id) => id === 'movie_player'
      ? { getAudioTrack: () => ({ captionTracks }) }
      : null
  };
}
fakePlayer([{ vssId: 'a.en', baseUrl: potUrl }]);
check('findAudioCaptionUrl returns a matching tokenized URL',
  api.findAudioCaptionUrl(asrTrack, 'abc'), potUrl);

const potUrlWithoutVssId =
  'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&pot=TOKEN';
fakePlayer([{ baseUrl: potUrlWithoutVssId }]);
check('findAudioCaptionUrl accepts one tokenized candidate without vssId',
  api.findAudioCaptionUrl(asrTrack, 'abc'), potUrlWithoutVssId);

fakePlayer([
  { baseUrl: potUrlWithoutVssId },
  { baseUrl: potUrlWithoutVssId.replace('pot=TOKEN', 'pot=OTHER') }
]);
check('findAudioCaptionUrl rejects ambiguous candidates without vssId',
  api.findAudioCaptionUrl(asrTrack, 'abc'), null);

fakePlayer([{ vssId: 'a.other', baseUrl: potUrlWithoutVssId }]);
check('findAudioCaptionUrl rejects an explicit object-level vssId mismatch',
  api.findAudioCaptionUrl(asrTrack, 'abc'), null);

fakePlayer([{ vssId: 'a.en', baseUrl: potUrl.replace('&pot=TOKEN', '') }]);
check('findAudioCaptionUrl rejects a candidate with no POT token',
  api.findAudioCaptionUrl(asrTrack, 'abc'), null);

fakePlayer([{ vssId: 'a.en', baseUrl: 'https://evil.example.com/api/timedtext?v=abc&lang=en&kind=asr&pot=T' }]);
check('findAudioCaptionUrl rejects an off-YouTube candidate',
  api.findAudioCaptionUrl(asrTrack, 'abc'), null);

globalThis.document = { getElementById: () => null };
checkTrue('findRuntimeCaptionUrl resolves to null without a player',
  (await api.findRuntimeCaptionUrl(asrTrack, 'abc')) === null);

// findRuntimeCaptionUrl is the most fragile code here and was covered only on
// its no-player early return. A fake movie_player plus a stubbed resource-timing
// buffer exercises the setOption sequencing, the stale-resource rejection and
// the finally-restore round-trip without a browser.
function runtimePlayer({ tracklist = [], priorTrack, priorTrackThrows = false,
                         loadedModules, entries = [] } = {}) {
  const calls = [];
  const player = {
    getOptions: () => loadedModules,
    getOption: (module, key) => {
      if (key === 'tracklist') return tracklist;
      if (key === 'track') {
        calls.push('getOption:track');
        if (priorTrackThrows) throw new Error('captions module not loaded');
        return priorTrack;
      }
      return undefined;
    },
    setOption: (module, key, value) => calls.push({ set: value }),
    loadModule: (name) => calls.push(`loadModule:${name}`),
    unloadModule: (name) => calls.push(`unloadModule:${name}`)
  };
  globalThis.document = { getElementById: (id) => (id === 'movie_player' ? player : null) };
  globalThis.performance = {
    now: () => 1000,
    getEntriesByType: () => entries,
    setResourceTimingBufferSize: () => {}
  };
  return calls;
}

const runtimeEntry = (name, startTime) => ({ name, startTime });

let calls = runtimePlayer({
  tracklist: [{ vssId: 'a.en', languageCode: 'en', kind: 'asr' }],
  priorTrack: { vssId: '.en', languageCode: 'en' },
  loadedModules: ['captions'],
  entries: [runtimeEntry(potUrl, 1500)]
});
check('findRuntimeCaptionUrl returns a tokenized URL seen after the request',
  await api.findRuntimeCaptionUrl(asrTrack, 'abc'), potUrl);
checkTrue('findRuntimeCaptionUrl restores the previous track it read',
  JSON.stringify(calls[calls.length - 1]) ===
    JSON.stringify({ set: { vssId: '.en', languageCode: 'en' } }));

calls = runtimePlayer({
  tracklist: [{ vssId: 'a.en', languageCode: 'en', kind: 'asr' }],
  priorTrack: { vssId: '.en', languageCode: 'en' },
  loadedModules: ['captions'],
  entries: [runtimeEntry(potUrlWithoutVssId, 1500)]
});
check('findRuntimeCaptionUrl accepts a fresh tokenized URL without vssId',
  await api.findRuntimeCaptionUrl(asrTrack, 'abc'), potUrlWithoutVssId);

runtimePlayer({
  tracklist: [{ vssId: 'a.en', languageCode: 'en', kind: 'asr' }],
  loadedModules: ['captions'], priorTrack: {},
  entries: [runtimeEntry(potUrl + '&c=WEB', 1500), runtimeEntry(potUrl, 1600)]
});
check('findRuntimeCaptionUrl prefers complete client context over a newer incomplete POT URL',
  await api.findRuntimeCaptionUrl(asrTrack, 'abc'), potUrl + '&c=WEB');

runtimePlayer({
  tracklist: [{ vssId: 'a.en', languageCode: 'en', kind: 'asr' }],
  loadedModules: ['captions'], priorTrack: {},
});
let resourceReads = 0;
globalThis.performance.getEntriesByType = () => ++resourceReads < 4
  ? [runtimeEntry(potUrl, 1500)] : [runtimeEntry(potUrl, 1500), runtimeEntry(potUrl + '&c=WEB', 1600)];
check('findRuntimeCaptionUrl waits for the full native request rather than returning an early incomplete URL',
  await api.findRuntimeCaptionUrl(asrTrack, 'abc'), potUrl + '&c=WEB');

calls = runtimePlayer({
  tracklist: [{ vssId: 'a.other', languageCode: 'en', kind: 'asr' }],
  priorTrack: { vssId: '.en', languageCode: 'en' },
  loadedModules: ['captions'],
  entries: [runtimeEntry(potUrlWithoutVssId, 1500)]
});
await api.findRuntimeCaptionUrl(asrTrack, 'abc');
check('findRuntimeCaptionUrl does not select an explicit vssId mismatch',
  calls.find(call => call?.set?.vssId === 'a.other'), undefined);

// A resource logged before the request was issued is a leftover from an earlier
// extraction; accepting it would return a stale, possibly expired URL.
calls = runtimePlayer({
  tracklist: [{ vssId: 'a.en', languageCode: 'en', kind: 'asr' }],
  priorTrack: { vssId: '.en' },
  loadedModules: ['captions'],
  entries: [runtimeEntry(potUrl, 500)]
});
check('findRuntimeCaptionUrl rejects a resource timed before the request',
  await api.findRuntimeCaptionUrl(asrTrack, 'abc'), null);

// The captions module was not loaded before we touched it, so leaving it loaded
// would change what the viewer sees.
calls = runtimePlayer({
  tracklist: [{ vssId: 'a.en', languageCode: 'en', kind: 'asr' }],
  priorTrack: { vssId: '.en' },
  loadedModules: [],
  entries: [runtimeEntry(potUrl, 1500)]
});
await api.findRuntimeCaptionUrl(asrTrack, 'abc');
checkTrue('findRuntimeCaptionUrl unloads a captions module it loaded itself',
  calls.includes('loadModule:captions') && calls[calls.length - 1] === 'unloadModule:captions');

// An off-YouTube resource-timing entry must never win the fallback.
calls = runtimePlayer({
  tracklist: [{ vssId: 'a.en', languageCode: 'en', kind: 'asr' }],
  priorTrack: { vssId: '.en' },
  loadedModules: ['captions'],
  entries: [runtimeEntry('https://evil.example.com/api/timedtext?v=abc&lang=en&kind=asr&vssId=a.en&pot=T', 1500)]
});
check('findRuntimeCaptionUrl ignores an off-YouTube resource entry',
  await api.findRuntimeCaptionUrl(asrTrack, 'abc'), null);

globalThis.document = { getElementById: () => null };
globalThis.performance = { getEntriesByType: () => [] };

// fetchCaptionTrack must refuse a non-YouTube host before any network call.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; return { ok: true, status: 200, text: async () => 'body' }; };
const blocked = await api.fetchCaptionTrack('https://evil.example.com/api/timedtext?v=abc');
check('fetchCaptionTrack blocks a non-YouTube host',
  { blocked: blocked.blocked, ok: blocked.ok }, { blocked: true, ok: false });
check('fetchCaptionTrack makes no network call when blocked', fetchCalls, 0);

const blockedHttp = await api.fetchCaptionTrack('http://www.youtube.com/api/timedtext?v=abc');
check('fetchCaptionTrack blocks plain http', blockedHttp.blocked, true);

let requestedUrl = null;
globalThis.fetch = async (url) => {
  requestedUrl = url;
  return { ok: true, status: 200, text: async () => 'caption body' };
};
const allowed = await api.fetchCaptionTrack('https://www.youtube.com/api/timedtext?v=abc');
check('fetchCaptionTrack fetches an allowed host',
  { ok: allowed.ok, body: allowed.body }, { ok: true, body: 'caption body' });
checkTrue('fetchCaptionTrack requests json3',
  new URL(requestedUrl).searchParams.get('fmt') === 'json3');

// saveFile - the README claims the harness covers filename sanitisation.
const savedNames = [];
globalThis.URL.createObjectURL = () => 'blob:fake';
globalThis.URL.revokeObjectURL = () => {};
globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
globalThis.document = {
  createElement: () => ({ click() {}, remove() {}, set download(v) { savedNames.push(v); } }),
  body: { appendChild() {} }
};
check('saveFile strips path-hostile characters',
  api.saveFile('body', 'a/b:c*?"<>|d', '.vtt', 'fallback'), 'a_b_c______d.vtt');
check('saveFile trims the YouTube suffix and applies the extension',
  api.saveFile('body', 'My Talk - YouTube', '.md', 'fallback'), 'My Talk.md');
check('saveFile falls back when the name is empty after cleaning',
  api.saveFile('body', '   ', '.vtt', ''), 'youtube-captions.vtt');
check('saveFile does not double up an existing extension',
  api.saveFile('body', 'notes.md', '.md', 'fallback'), 'notes.md');
check('saveFile includes the selected transcript after a custom basename',
  api.saveFile('body', 'notes.md', '.md', 'fallback', 'Hebrew'), 'notes-Hebrew.md');
check('saveFile includes the selected transcript after the video title',
  api.saveFile('body', null, '.vtt', 'My Talk - YouTube', 'English (auto-generated)'),
  'My Talk-English (auto-generated).vtt');
check('saveFile sanitizes the selected transcript suffix',
  api.saveFile('body', 'notes', '.md', 'fallback', 'Hebrew/../other'), 'notes-Hebrew_.._other.md');

// --- xmlToCues (always runs; see the DOMParser resolution above) ------------
const xml = '<transcript>' +
  '<text start="2" dur="1">later &amp;#39;quote&amp;#39;</text>' +
  '<text start="0" dur="1">earlier</text>' +
  '</transcript>';
check('xmlToCues sorts cues chronologically and decodes double escaping',
  api.xmlToCues(xml),
  [
    { startMs: 0, endMs: 1000, text: 'earlier' },
    { startMs: 2000, endMs: 3000, text: "later 'quote'" }
  ]);

// textContent drops <br/> without whitespace, joining words across caption line
// breaks: "first<br/>second" exported as the corrupt "firstsecond".
check('xmlToCues keeps a word boundary across a legacy <br/>',
  api.xmlToCues('<transcript><text start="0" dur="1">first<br/>second</text></transcript>'),
  [{ startMs: 0, endMs: 1000, text: 'first second' }]);

check('xmlToCues reads an SRV3 <p> element',
  api.xmlToCues('<timedtext><body><p t="1500" d="500">srv3 cue</p></body></timedtext>'),
  [{ startMs: 1500, endMs: 2000, text: 'srv3 cue' }]);

check('xmlToCues keeps a word boundary across an SRV3 <br/>',
  api.xmlToCues('<timedtext><body><p t="0" d="1000">alpha<br/>beta</p></body></timedtext>'),
  [{ startMs: 0, endMs: 1000, text: 'alpha beta' }]);

check('xmlToCues drops cues that are empty after cleaning',
  api.xmlToCues('<transcript><text start="0" dur="1">   </text></transcript>'), []);

check('xmlToCues survives an out-of-range entity rather than throwing',
  api.xmlToCues('<transcript><text start="0" dur="1">ok &amp;#x110000; end</text></transcript>'),
  [{ startMs: 0, endMs: 1000, text: 'ok &#x110000; end' }]);

// A bot interstitial or soft error page is served with HTTP 200 and parses as
// well-formed XML. Without a structural check every <p> in it became a cue and
// the export was reported to the user as a success — silent data corruption on
// the exact failure mode the README documents as likely.
check('xmlToCues rejects an HTML body that parses as XML',
  api.xmlToCues('<html><body><p>Sign in to confirm you are not a bot</p><p>Learn more</p></body></html>'),
  []);

check('xmlToCues rejects a timed-text root whose cues carry no timing attributes',
  api.xmlToCues('<timedtext><body><p>no timing here</p></body></timedtext>'), []);

check('xmlToCues keeps a t=0 cue, which is falsy but present',
  api.xmlToCues('<timedtext><body><p t="0" d="1000">zero start</p></body></timedtext>'),
  [{ startMs: 0, endMs: 1000, text: 'zero start' }]);

check('xmlToCues accepts a legacy cue carrying only start',
  api.xmlToCues('<transcript><text start="1">only start</text></transcript>'),
  [{ startMs: 1000, endMs: 1000, text: 'only start' }]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
