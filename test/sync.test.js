import test from 'node:test';
import assert from 'node:assert/strict';
import { alignShots, alignTokens, consensusWords } from '../server/sync/align.js';
import { normalizeTranscript } from '../server/sync/transcribe.js';

test('alignTokens handles insertions, deletions and substitutions', () => {
  const a = ['one', 'member', 'is', 'worth', '12', 'billion', 'dollars'];
  const b = ['um', 'one', 'member', 'is', 'worth', 'twelve', 'billion', 'dollars'];
  const { map } = alignTokens(a, b);
  assert.deepEqual(map, [1, 2, 3, 4, 5, 6, 7]);
});

test('alignShots puts each image on the first word of its narration', () => {
  const shots = [{ text: 'Calm.' }, { text: 'Certain.' }, { text: 'He had total control.' }];
  const words = [
    { word: 'Calm.', start: 0.4, end: 0.8 },
    { word: 'Certain.', start: 1.3, end: 1.9 },
    { word: 'He', start: 2.5, end: 2.6 },
    { word: 'had', start: 2.6, end: 2.8 },
    { word: 'total', start: 2.8, end: 3.2 },
    { word: 'control.', start: 3.2, end: 3.8 },
  ];
  const { timeline, stats } = alignShots(shots, words, { duration: 4.5, fps: 30 });
  assert.deepEqual(timeline.map((t) => [t.start, t.end]), [[0, 1.3], [1.3, 2.5], [2.5, 4.5]]);
  assert.equal(stats.matchRate, 1);
});

test('alignShots leaves out closing shots the narrator never recorded', () => {
  const shots = [{ text: 'Calm.' }, { text: 'Certain.' }, { text: 'Subscribe for more.' }, { text: 'See you next time.' }];
  const words = [
    { word: 'Calm.', start: 0.4, end: 0.8 },
    { word: 'Certain.', start: 1.3, end: 1.9 },
  ];
  const { timeline, stats } = alignShots(shots, words, { duration: 3, fps: 30 });
  assert.deepEqual(timeline.map((t) => [t.shot, t.start, t.end]), [[1, 0, 1.3], [2, 1.3, 3]]);
  assert.equal(stats.unspokenShots, 2);
});

test('alignShots leaves out a skipped line in the middle instead of flashing it', () => {
  const shots = [
    { text: 'He says,' }, { text: 'Old is not the problem.' }, { text: 'Visible is the problem.' },
    { text: 'People hate old cars.' }, { text: 'You have nothing to say.' },
  ];
  const words = [
    { word: 'He', start: 0.2, end: 0.4 }, { word: 'says,', start: 0.4, end: 0.8 },
    { word: 'You', start: 0.9, end: 1.2 }, { word: 'have', start: 1.2, end: 1.4 },
    { word: 'nothing', start: 1.4, end: 1.8 }, { word: 'to', start: 1.8, end: 1.9 }, { word: 'say.', start: 1.9, end: 2.3 },
  ];
  const { timeline, stats } = alignShots(shots, words, { duration: 3, fps: 30 });
  assert.deepEqual(timeline.map((t) => [t.shot, t.start, t.end]), [[1, 0, 0.9], [5, 0.9, 3]]);
  assert.equal(stats.unspokenShots, 3);
});

test('consensusWords takes the cross-check where WhisperX skipped or misplaced words', () => {
  const shots = [{ text: 'He says,' }, { text: 'Old is the problem.' }, { text: 'You nod.' }];
  // WhisperX dropped the quote and stretched "You nod." over its audio (at 1.0s instead of 5.0s).
  const whisperx = [{ word: 'He', start: 0.2 }, { word: 'says,', start: 0.4 }, { word: 'You', start: 1.0 }, { word: 'nod.', start: 1.3 }];
  const openai = [
    { word: 'He', start: 0.1 }, { word: 'says,', start: 0.3 }, { word: 'Old', start: 1.0 }, { word: 'is', start: 1.4 },
    { word: 'the', start: 1.6 }, { word: 'problem.', start: 1.8 }, { word: 'You', start: 5.0 }, { word: 'nod.', start: 5.3 },
  ];
  const { words, fromSecondary } = consensusWords(shots, whisperx, openai);
  assert.deepEqual(words.map((w) => [w.word, w.start]), [
    ['he', 0.2], ['says', 0.4], ['old', 1.0], ['is', 1.4], ['the', 1.6], ['problem', 1.8], ['you', 5.0], ['nod', 5.3],
  ]);
  assert.equal(fromSecondary, 6);
  const { timeline } = alignShots(shots, words, { duration: 6, fps: 30 });
  assert.deepEqual(timeline.map((t) => [t.shot, t.start]), [[1, 0], [2, 1], [3, 5]]);
});

test('alignShots survives misheard words and keeps time monotonic', () => {
  const text = 'the quick brown fox jumps over the lazy dog and runs into the forest where nobody can find him';
  const tokens = text.split(' ');
  const shots = [];
  for (let i = 0; i < tokens.length; i += 3) shots.push({ text: tokens.slice(i, i + 3).join(' ') });
  const heard = tokens.map((w, i) => ({ word: i === 4 ? 'jumped' : i === 9 ? 'an' : w, start: i * 0.5, end: i * 0.5 + 0.4 }));
  heard.splice(7, 0, { word: 'uh', start: 3.45, end: 3.5 });
  const { timeline } = alignShots(shots, heard, { duration: tokens.length * 0.5, fps: 30 });
  for (let i = 1; i < timeline.length; i++) assert.ok(timeline[i].start > timeline[i - 1].start);
  assert.equal(timeline[1].start, 1.5); // "fox"
  assert.equal(timeline[3].start, 4.5); // "and"
  assert.equal(timeline.at(-1).end, tokens.length * 0.5);
});

test('normalizeTranscript reads WhisperX, fast-whisper chunks and plain segments', () => {
  const wx = normalizeTranscript({ segments: [{ start: 0, end: 2, text: 'Hi 12 there', words: [{ word: 'Hi', start: 0.1, end: 0.3 }, { word: '12' }, { word: 'there', start: 1.0, end: 1.4 }] }] });
  assert.equal(wx.length, 3);
  assert.ok(wx[1].start >= 0.3 && wx[1].start <= 1.0);
  const fast = normalizeTranscript({ text: 'a b', chunks: [{ text: ' a', timestamp: [0, 0.5] }, { text: ' b', timestamp: [0.5, 1] }] });
  assert.deepEqual(fast.map((w) => w.start), [0, 0.5]);
  const seg = normalizeTranscript({ segments: [{ start: 0, end: 3, text: 'one two three' }] });
  assert.equal(seg.length, 3);
  assert.ok(seg[1].start > 0 && seg[2].start < 3);
});
