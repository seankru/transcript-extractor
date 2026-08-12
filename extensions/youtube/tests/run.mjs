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
  'cleanText', 'trackName', 'jsonToCues', 'decodeEntities', 'xmlToCues',
  'vttTime', 'shortTime', 'cuesToVtt', 'cuesToMarkdown', 'fillCueEndTimes',
  'isYouTubeCaptionHost', 'isYouTubeTabUrl', 'captionUrlMatchesTrack',
  'extractChapters'
];

const preamble = 'const location = { href: "https://www.youtube.com/watch?v=abc" };\n';
const body = NAMES.map(extractFunction).join('\n');
const api = new Function(
  'DOMParser',
  `${preamble}${body}\nreturn { ${NAMES.join(', ')} };`
)(globalThis.DOMParser);

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

// --- decodeEntities ---------------------------------------------------------
check('decodeEntities resolves the second escaping level',
  api.decodeEntities('it&#39;s &amp; more &lt;tag&gt;'),
  "it's & more <tag>");
check('decodeEntities leaves unknown entities alone',
  api.decodeEntities('&notareal; text'), '&notareal; text');
check('decodeEntities handles hex references', api.decodeEntities('&#x27;'), "'");

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
  ['WEBVTT', '', '00:00:00.000 --> 00:00:01.000', 'a &amp; b &lt;c> -> d', ''].join('\n'));

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
check('cuesToMarkdown renders a heading and cue lines',
  noChapters.markdown, ['# Title', '', '**[00:00]** a', ''].join('\n'));

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

// --- xmlToCues (needs a DOMParser) -----------------------------------------
if (typeof globalThis.DOMParser === 'function') {
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
} else {
  console.log('SKIP xmlToCues - this runtime has no DOMParser');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
