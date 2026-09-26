// Renders the synced timeline to MP4 with Remotion.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let bundlePromise = null;

function getBundle() {
  if (!bundlePromise) {
    bundlePromise = bundle({ entryPoint: path.join(root, 'remotion/index.jsx') }).catch((err) => {
      bundlePromise = null;
      throw err;
    });
  }
  return bundlePromise;
}

function browserExecutable() {
  if (process.env.REMOTION_BROWSER_EXECUTABLE) return process.env.REMOTION_BROWSER_EXECUTABLE;
  // Use a preinstalled Chromium headless shell when one exists (e.g. Playwright's), else let Remotion download its own.
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && fs.existsSync(base)) {
    const dir = fs.readdirSync(base).find((d) => d.startsWith('chromium_headless_shell'));
    if (dir) {
      for (const sub of ['chrome-linux/headless_shell', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
        const p = path.join(base, dir, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

/**
 * props: { fps, width, height, durationInFrames, shots: [{ src, from, durationInFrames }], audioSrc, motion, transition, transitionFrames }
 */
export async function renderVideo(props, outputPath, onProgress = () => {}) {
  onProgress({ stage: 'bundling', progress: 0 });
  const serveUrl = await getBundle();
  const exe = browserExecutable();
  const composition = await selectComposition({
    serveUrl,
    id: 'DirectorVideo',
    inputProps: props,
    ...(exe ? { browserExecutable: exe } : {}),
  });
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps: props,
    crf: Number(process.env.RENDER_CRF) || 18,
    audioBitrate: '320k',
    concurrency: Number(process.env.RENDER_CONCURRENCY) || null,
    timeoutInMilliseconds: 120000,
    ...(exe ? { browserExecutable: exe } : {}),
    onProgress: ({ progress, renderedFrames, encodedFrames, stitchStage }) =>
      onProgress({ stage: stitchStage || 'rendering', progress, renderedFrames, encodedFrames }),
  });
  onProgress({ stage: 'done', progress: 1 });
  return outputPath;
}

/** Convert a timeline (seconds) + image URLs into Remotion props with exact frame boundaries. */
export function timelineToProps({ timeline, imageUrl, audioUrl, fps, width, height, motion, transition, transitionFrames }) {
  const shots = timeline.map((t) => {
    const from = Math.round(t.start * fps);
    const to = Math.round(t.end * fps);
    return { src: imageUrl(t.shot), from, durationInFrames: Math.max(1, to - from) };
  });
  const last = shots[shots.length - 1];
  return {
    fps, width, height,
    durationInFrames: last ? last.from + last.durationInFrames : 1,
    shots,
    audioSrc: audioUrl,
    motion,
    transition,
    transitionFrames,
  };
}
