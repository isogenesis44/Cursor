// Whisper via Replicate, normalised to a flat list of timed words: [{ word, start, end }].
import { runModel, uploadFile } from '../replicate.js';

export const WHISPER_MODELS = {
  whisperx: 'victor-upmeet/whisperx', // word-level timestamps via forced alignment (most accurate)
  fast: 'vaibhavs10/incredibly-fast-whisper', // word-level timestamps, very fast
  openai: 'openai/whisper', // segment-level only; words are interpolated inside each segment
};

const AUDIO_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm' };

export async function transcribe(audioPath, { engine = 'openai', language, onStatus } = {}) {
  const ext = audioPath.split('.').pop().toLowerCase();
  const url = await uploadFile(audioPath, AUDIO_TYPES[ext] || 'application/octet-stream');
  const model = process.env[`WHISPER_MODEL_${engine.toUpperCase()}`] || WHISPER_MODELS[engine];
  if (!model) throw new Error(`Unknown whisper engine "${engine}"`);
  // No script initial_prompt: feeding Whisper the script made it hallucinate whole passages.
  let input;
  if (engine === 'whisperx') {
    input = { audio_file: url, align_output: true, ...(language ? { language } : {}) };
  } else if (engine === 'fast') {
    // This model wants the language name ("english"), not the ISO code ("en").
    const languageName = language ? languageToName(language) : null;
    input = { audio: url, timestamp: 'word', task: 'transcribe', ...(languageName ? { language: languageName } : {}) };
  } else {
    input = { audio: url, transcription: 'plain text', temperature: 0, condition_on_previous_text: false, ...(language ? { language } : {}) };
  }
  const output = await runModel(model, input, { onStatus });
  const words = normalizeTranscript(output);
  if (!words.length) throw new Error('Whisper returned no words.');
  return { engine, model, words };
}

function languageToName(language) {
  if (language.length > 3) return language.toLowerCase();
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(language).toLowerCase();
  } catch {
    return null;
  }
}

const clean = (w) => String(w ?? '').trim();

/** Accepts WhisperX / incredibly-fast-whisper / openai-whisper / our own saved format. */
export function normalizeTranscript(output) {
  if (!output) return [];
  if (Array.isArray(output.words)) return fillGaps(output.words.map((w) => ({ word: clean(w.word ?? w.text), start: num(w.start), end: num(w.end) })));

  const segments = Array.isArray(output) ? output : output.segments || output.chunks;
  if (!Array.isArray(segments)) return [];
  const words = [];
  for (const seg of segments) {
    if (Array.isArray(seg.words) && seg.words.length) {
      for (const w of seg.words) words.push({ word: clean(w.word ?? w.text), start: num(w.start), end: num(w.end) });
    } else if (Array.isArray(seg.timestamp)) {
      // incredibly-fast-whisper chunk: { text, timestamp: [start, end] } (word or phrase)
      spread(words, clean(seg.text), num(seg.timestamp[0]), num(seg.timestamp[1]));
    } else {
      spread(words, clean(seg.text), num(seg.start), num(seg.end));
    }
  }
  return fillGaps(words.filter((w) => w.word));
}

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** Spread a phrase's words across its time span, weighted by word length. */
function spread(out, text, start, end) {
  const parts = text.split(/\s+/).filter(Boolean);
  if (!parts.length) return;
  if (start === null || end === null || parts.length === 1) {
    parts.forEach((p) => out.push({ word: p, start, end: parts.length === 1 ? end : null }));
    return;
  }
  const weights = parts.map((p) => p.length + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  let t = start;
  parts.forEach((p, i) => {
    const d = ((end - start) * weights[i]) / total;
    out.push({ word: p, start: t, end: t + d });
    t += d;
  });
}

/** Interpolate missing start/end values (WhisperX leaves them off numbers/symbols). */
function fillGaps(words) {
  const n = words.length;
  for (let i = 0; i < n; i++) {
    if (words[i].start !== null) continue;
    let prev = i - 1;
    while (prev >= 0 && words[prev].start === null) prev--;
    let next = i + 1;
    while (next < n && words[next].start === null) next++;
    const missing = next - prev - 1; // words in this unknown run
    const t0 = prev >= 0 ? (words[prev].end ?? words[prev].start) : 0;
    const t1 = next < n ? Math.max(t0, words[next].start) : t0 + 0.3 * missing;
    const k = i - prev - 1; // 0-based position inside the run
    words[i].start = t0 + ((t1 - t0) * k) / missing;
  }
  for (let i = 0; i < n; i++) {
    if (words[i].end === null || words[i].end < words[i].start) {
      words[i].end = i + 1 < n ? Math.max(words[i].start, words[i + 1].start) : words[i].start + 0.3;
    }
  }
  // Force monotonic starts.
  for (let i = 1; i < n; i++) if (words[i].start < words[i - 1].start) words[i].start = words[i - 1].start;
  return words;
}
