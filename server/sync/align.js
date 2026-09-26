// Aligns the planned shot texts (verbatim script) to Whisper's timed words, producing
// the exact moment each image should appear.

export function normToken(w) {
  return String(w)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function tokenize(text) {
  return String(text).split(/\s+/).map(normToken).filter(Boolean);
}

function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 4 || b.length < 4) return 0;
  // Levenshtein ratio for spelling variants ("colour"/"color", "okay"/"ok").
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

const MATCH = 3;
const FUZZY = 2;
const SUB = -1;
const GAP = -2;

/**
 * Banded global alignment (Needleman–Wunsch) of script tokens `a` against transcript tokens `b`.
 * Returns an array (length a.length) of transcript indexes or -1, plus a quality flag per pair.
 */
export function alignTokens(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return { map: new Array(n).fill(-1), exact: new Array(n).fill(false) };
  const band = Math.max(150, Math.abs(n - m) + 150);
  const W = 2 * band + 1;
  const center = (i) => Math.round((i * m) / n);
  const lo = (i) => Math.max(0, center(i) - band);
  const hi = (i) => Math.min(m, center(i) + band);
  const NEG = -1e9;
  const trace = new Uint8Array((n + 1) * W); // 1=diag 2=up(gap in b) 3=left(gap in a)
  let prevRow = new Float64Array(W).fill(NEG);
  let prevLo = lo(0);
  for (let j = prevLo; j <= hi(0); j++) {
    prevRow[j - prevLo] = j * GAP;
    trace[j - prevLo] = 3;
  }
  const simCache = new Map();
  const sim = (i, j) => {
    const key = a[i] + '|' + b[j];
    let v = simCache.get(key);
    if (v === undefined) { v = similarity(a[i], b[j]); simCache.set(key, v); }
    return v;
  };
  for (let i = 1; i <= n; i++) {
    const rowLo = lo(i);
    const rowHi = hi(i);
    const row = new Float64Array(W).fill(NEG);
    for (let j = rowLo; j <= rowHi; j++) {
      const k = j - rowLo;
      let best = NEG;
      let dir = 0;
      if (j > 0 && j - 1 >= prevLo && j - 1 - prevLo < W && prevRow[j - 1 - prevLo] > NEG) {
        const s = sim(i - 1, j - 1);
        const v = prevRow[j - 1 - prevLo] + (s === 1 ? MATCH : s >= 0.75 ? FUZZY : SUB);
        if (v > best) { best = v; dir = 1; }
      }
      if (j >= prevLo && j - prevLo < W && prevRow[j - prevLo] > NEG) {
        const v = prevRow[j - prevLo] + GAP;
        if (v > best) { best = v; dir = 2; }
      }
      if (j > rowLo && row[k - 1] > NEG) {
        const v = row[k - 1] + GAP;
        if (v > best) { best = v; dir = 3; }
      }
      if (j === 0 && dir === 0) { best = i * GAP; dir = 2; }
      row[k] = best;
      trace[i * W + k] = dir;
    }
    prevRow = row;
    prevLo = rowLo;
  }
  // Traceback from (n, m) — m is always inside the last row's band because center(n) = m.
  const map = new Array(n).fill(-1);
  const exact = new Array(n).fill(false);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const d = i === 0 ? 3 : trace[i * W + (j - lo(i))];
    if (d === 1) {
      map[i - 1] = j - 1;
      exact[i - 1] = sim(i - 1, j - 1) >= 0.75;
      i--; j--;
    } else if (d === 2) {
      i--;
    } else if (d === 3) {
      j--;
    } else {
      break;
    }
  }
  return { map, exact };
}

/**
 * shots: [{ text }]; words: [{ word, start, end }]; returns
 * { timeline: [{ shot, start, end, duration, matched }], stats }
 * options: { duration (audio length s), fps, leadSeconds (show image slightly before the word), minSeconds }
 */
export function alignShots(shots, words, { duration, fps = 30, leadSeconds = 0, minSeconds } = {}) {
  const tokenShot = [];
  const scriptTokens = [];
  shots.forEach((s, si) => {
    for (const t of tokenize(s.text)) { scriptTokens.push(t); tokenShot.push(si); }
  });
  const wordTokens = [];
  const wordIndex = [];
  words.forEach((w, wi) => {
    // A Whisper "word" can hold two tokens ("well,so"); split but keep its timing.
    for (const t of tokenize(w.word)) { wordTokens.push(t); wordIndex.push(wi); }
  });

  const { map, exact } = alignTokens(scriptTokens, wordTokens);

  // Anchor time per script token: exact/fuzzy matches first, substitutions as weaker anchors.
  const n = scriptTokens.length;
  const time = new Array(n).fill(null);
  let exactCount = 0;
  for (let i = 0; i < n; i++) {
    if (map[i] >= 0) {
      time[i] = words[wordIndex[map[i]]].start;
      if (exact[i]) exactCount++;
    }
  }
  // Drop anchors that would go backwards in time.
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    if (time[i] === null) continue;
    if (time[i] < last) time[i] = null; else last = time[i];
  }
  // Interpolate the rest.
  const audioEnd = duration ?? (words.length ? words[words.length - 1].end + 0.5 : 0);
  const known = [];
  for (let i = 0; i < n; i++) if (time[i] !== null) known.push(i);
  if (!known.length) {
    for (let i = 0; i < n; i++) time[i] = (audioEnd * i) / Math.max(1, n);
  } else {
    for (let i = 0; i < known[0]; i++) time[i] = Math.max(0, time[known[0]] - 0.3 * (known[0] - i));
    for (let k = 0; k + 1 < known.length; k++) {
      const a = known[k];
      const b = known[k + 1];
      for (let i = a + 1; i < b; i++) time[i] = time[a] + ((time[b] - time[a]) * (i - a)) / (b - a);
    }
    const lastK = known[known.length - 1];
    for (let i = lastK + 1; i < n; i++) time[i] = Math.min(audioEnd, time[lastK] + 0.3 * (i - lastK));
  }

  // Shot start = its first token's time.
  const frame = 1 / fps;
  const minDur = Math.max(frame, minSeconds ?? frame);
  const firstToken = new Array(shots.length).fill(-1);
  const matchedTokens = new Array(shots.length).fill(0);
  const totalTokens = new Array(shots.length).fill(0);
  for (let i = 0; i < n; i++) {
    const s = tokenShot[i];
    if (firstToken[s] < 0) firstToken[s] = i;
    totalTokens[s]++;
    if (exact[i]) matchedTokens[s]++;
  }
  const starts = shots.map((_, si) => {
    if (firstToken[si] >= 0) return Math.max(0, time[firstToken[si]] - leadSeconds);
    return null; // shot with no words (e.g. only punctuation): placed after the previous one
  });
  starts[0] = 0; // the first image covers the intro before the first word
  for (let si = 1; si < starts.length; si++) {
    const floor = starts[si - 1] + minDur;
    if (starts[si] === null || starts[si] < floor) starts[si] = floor;
  }
  // Snap to frames.
  const snap = (t) => +(Math.round(t * fps) / fps).toFixed(4);
  const end = Math.max(snap(audioEnd), snap(starts[starts.length - 1] + minDur));
  const timeline = shots.map((_, si) => {
    const start = snap(starts[si]);
    const stop = si + 1 < shots.length ? snap(starts[si + 1]) : end;
    return {
      shot: si + 1,
      start,
      end: stop,
      duration: +(stop - start).toFixed(3),
      matched: totalTokens[si] ? +(matchedTokens[si] / totalTokens[si]).toFixed(2) : 0,
    };
  });
  return {
    timeline,
    stats: {
      scriptWords: n,
      transcriptWords: wordTokens.length,
      matchedWords: exactCount,
      matchRate: n ? +(exactCount / n).toFixed(3) : 0,
      totalSeconds: end,
    },
  };
}
