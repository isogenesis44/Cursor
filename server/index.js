import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(); } catch { /* no .env file — rely on real environment variables */ }

const express = (await import('express')).default;
const multer = (await import('multer')).default;
const AdmZip = (await import('adm-zip')).default;
const { parseMedia } = await import('@remotion/media-parser');
const { nodeReader } = await import('@remotion/media-parser/node');
const store = await import('./store.js');
const { planScript } = await import('./director/planner.js');
const { normalizeShot, normalizeCharacter, reconcileCoverage, enforceStructure, coverageMatches } = await import('./director/validate.js');
const { buildImagePrompt } = await import('./director/imagePrompts.js');
const { buildChatGptJob, kickoffMessage, planRuns, ASPECTS } = await import('./export/chatgpt.js');
const { transcribe, normalizeTranscript } = await import('./sync/transcribe.js');
const { alignShots } = await import('./sync/align.js');
const { renderVideo, timelineToProps } = await import('./render/render.js');
const replicate = await import('./replicate.js');
const { shotNumberFromName } = await import('./images.js');

const { getProject, save, setJob, projectDir } = store;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(root, 'public')));
// Project files (images/audio/renders) — also what Remotion loads while rendering.
app.use('/files', express.static(path.join(store.DATA_DIR, 'projects'), { maxAge: 0 }));

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i;
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, projectDir(req.params.id, 'uploads')),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}-${path.basename(file.originalname).replace(/[^\w.-]+/g, '_')}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 600 },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function view(p) {
  const shots = p.plan?.shots?.length || 0;
  const missing = [];
  for (let n = 1; n <= shots; n++) if (!p.images[n]) missing.push(n);
  return {
    ...p,
    derived: {
      shots,
      imageCount: Object.keys(p.images).filter((n) => Number(n) <= shots).length,
      missing,
      runs: p.plan ? planRuns(p.plan.shots, p.settings.imagesPerRun) : [],
      prompts: p.plan ? p.plan.shots.map((_, i) => buildImagePrompt(p.plan, i, { styleReference: Boolean(p.styleImage), style: p.settings.style, appendStyle: true })) : [],
      coverageOk: p.plan && p.script ? coverageMatches(p.script.normalize('NFKC'), p.plan.shots) : null,
    },
  };
}

// ---- projects ----------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ replicateToken: replicate.hasToken(), aspects: Object.keys(ASPECTS), defaults: store.DEFAULT_SETTINGS });
});

app.get('/api/projects', (_req, res) => res.json(store.listProjects()));

app.post('/api/projects', (req, res) => res.json(view(store.createProject(req.body?.title))));

app.get('/api/projects/:id', (req, res) => res.json(view(getProject(req.params.id))));

app.delete('/api/projects/:id', (req, res) => {
  getProject(req.params.id);
  store.deleteProject(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/projects/:id', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  const { title, script, settings } = req.body || {};
  if (typeof title === 'string') p.title = title.trim() || p.title;
  if (typeof script === 'string') p.script = script;
  if (settings && typeof settings === 'object') {
    for (const [k, v] of Object.entries(settings)) {
      if (!(k in store.DEFAULT_SETTINGS)) continue;
      p.settings[k] = typeof store.DEFAULT_SETTINGS[k] === 'number' ? Number(v) : v;
    }
    if (!ASPECTS[p.settings.aspectRatio]) p.settings.aspectRatio = '16:9';
    p.settings.imagesPerRun = Math.max(1, Math.round(p.settings.imagesPerRun) || 40);
    p.settings.fps = [24, 25, 30, 60].includes(p.settings.fps) ? p.settings.fps : 30;
  }
  await save(p);
  res.json(view(p));
}));

// ---- style reference image -------------------------------------------------------

app.post('/api/projects/:id/style-image', upload.single('file'), wrap(async (req, res) => {
  const p = getProject(req.params.id);
  if (!req.file || !IMAGE_EXT.test(req.file.originalname)) throw Object.assign(new Error('Upload a PNG, JPG or WEBP image.'), { status: 400 });
  const name = `style-reference${path.extname(req.file.originalname).toLowerCase()}`;
  if (p.styleImage) fs.rmSync(projectDir(p.id, p.styleImage), { force: true });
  fs.renameSync(req.file.path, projectDir(p.id, name));
  p.styleImage = name;
  p.styleImageUrl = null; // re-uploaded to Replicate on next plan
  await save(p);
  res.json(view(p));
}));

app.delete('/api/projects/:id/style-image', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  if (p.styleImage) fs.rmSync(projectDir(p.id, p.styleImage), { force: true });
  p.styleImage = null;
  p.styleImageUrl = null;
  await save(p);
  res.json(view(p));
}));

// ---- planning --------------------------------------------------------------------

function running(p, kind) {
  return p.jobs[kind]?.status === 'running';
}

app.post('/api/projects/:id/plan', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  if (!p.script?.trim()) throw Object.assign(new Error('Paste a script first.'), { status: 400 });
  if (!replicate.hasToken()) throw Object.assign(new Error('REPLICATE_API_TOKEN is not set on the server.'), { status: 400 });
  if (running(p, 'plan')) throw Object.assign(new Error('Planning is already running.'), { status: 409 });
  setJob(p, 'plan', { status: 'running', message: 'Starting…', progress: 0, warnings: [] });
  res.json(view(p));

  (async () => {
    try {
      let styleImageUrl = null;
      if (p.styleImage) {
        const file = projectDir(p.id, p.styleImage);
        const ext = path.extname(file).slice(1).replace('jpg', 'jpeg');
        styleImageUrl = await replicate.uploadFile(file, `image/${ext}`);
      }
      const result = await planScript(p.script, { ...p.settings, styleImageUrl }, (u) => {
        const patch = { message: u.message || p.jobs.plan.message };
        if (u.total) patch.progress = u.done / u.total;
        setJob(p, 'plan', patch);
      });
      p.plan = { characters: result.characters, shots: result.shots };
      p.timeline = null;
      setJob(p, 'plan', { status: 'done', progress: 1, message: `Planned ${result.shots.length} shots.`, warnings: result.warnings });
    } catch (err) {
      console.error(err);
      setJob(p, 'plan', { status: 'error', message: err.message });
    }
  })();
}));

/** Import a plan JSON you already have (e.g. exported from the Replit app). */
app.post('/api/projects/:id/plan/import', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  const body = req.body?.plan || req.body;
  if (!Array.isArray(body?.shots) || !body.shots.length) throw Object.assign(new Error('JSON must contain a "shots" array.'), { status: 400 });
  let shots = body.shots.map(normalizeShot);
  const notes = [];
  if (p.script?.trim()) {
    const r = reconcileCoverage(p.script.normalize('NFKC'), shots);
    shots = r.shots;
    notes.push(...r.fixes);
  } else {
    p.script = shots.map((s) => s.text).join(' ');
  }
  enforceStructure(shots);
  p.plan = { characters: (body.characters || []).map(normalizeCharacter), shots };
  p.timeline = null;
  setJob(p, 'plan', { status: 'done', progress: 1, message: `Imported ${shots.length} shots.`, warnings: notes });
  res.json(view(p));
}));

app.patch('/api/projects/:id/shots/:n', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  const i = Number(req.params.n) - 1;
  const shot = p.plan?.shots?.[i];
  if (!shot) throw Object.assign(new Error('No such shot'), { status: 404 });
  const editable = ['scene_description', 'edit_instruction', 'wardrobe_override', 'character_visibility', 'subject_focus', 'prompt_override'];
  for (const k of editable) if (k in req.body) shot[k] = req.body[k] === '' ? null : req.body[k];
  await save(p);
  res.json(view(p));
}));

// ---- exports ---------------------------------------------------------------------

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video';
}

app.get('/api/projects/:id/export/chatgpt.json', (req, res) => {
  const p = getProject(req.params.id);
  if (!p.plan) throw Object.assign(new Error('Plan the script first.'), { status: 400 });
  const run = req.query.run ? Number(req.query.run) : null;
  const job = buildChatGptJob(p, { run });
  res.setHeader('Content-Disposition', `attachment; filename="${slug(p.title)}-chatgpt-images${run ? `-run${run}` : ''}.json"`);
  res.type('application/json').send(JSON.stringify(job, null, 2));
});

app.get('/api/projects/:id/export/instructions.txt', (req, res) => {
  const p = getProject(req.params.id);
  if (!p.plan) throw Object.assign(new Error('Plan the script first.'), { status: 400 });
  res.type('text/plain').send(kickoffMessage(p, planRuns(p.plan.shots, p.settings.imagesPerRun)));
});

app.get('/api/projects/:id/export/plan.json', (req, res) => {
  const p = getProject(req.params.id);
  res.setHeader('Content-Disposition', `attachment; filename="${slug(p.title)}-shot-plan.json"`);
  res.type('application/json').send(JSON.stringify(p.plan || {}, null, 2));
});

// ---- images ----------------------------------------------------------------------

function storeImage(p, n, srcPath, originalName) {
  const ext = path.extname(originalName).toLowerCase().replace('.jpeg', '.jpg');
  const name = `shot_${String(n).padStart(4, '0')}${ext}`;
  const prev = p.images[n];
  if (prev && prev !== name) fs.rmSync(projectDir(p.id, 'images', prev), { force: true });
  fs.renameSync(srcPath, projectDir(p.id, 'images', name));
  p.images[n] = name;
}

app.post('/api/projects/:id/images', upload.array('files', 600), wrap(async (req, res) => {
  const p = getProject(req.params.id);
  const total = p.plan?.shots?.length || 0;
  const incoming = []; // { path, name, time }
  let times = {};
  try { times = JSON.parse(req.body?.lastModified || '{}'); } catch { /* optional */ }
  for (const f of req.files || []) {
    if (/\.zip$/i.test(f.originalname)) {
      // Google Drive "Download folder" gives you a .zip — unpack it.
      const zip = new AdmZip(f.path);
      for (const e of zip.getEntries()) {
        if (e.isDirectory || !IMAGE_EXT.test(e.entryName) || path.basename(e.entryName).startsWith('.')) continue;
        const out = projectDir(p.id, 'uploads', `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(e.entryName)}`);
        fs.writeFileSync(out, e.getData());
        incoming.push({ path: out, name: path.basename(e.entryName), time: e.header.time?.getTime?.() || 0 });
      }
      fs.rmSync(f.path, { force: true });
    } else if (IMAGE_EXT.test(f.originalname)) {
      incoming.push({ path: f.path, name: f.originalname, time: Number(times[f.originalname]) || 0 });
    } else {
      fs.rmSync(f.path, { force: true });
    }
  }
  const assigned = [];
  const unnumbered = [];
  const ignored = [];
  for (const f of incoming) {
    const n = shotNumberFromName(f.name);
    if (n && n >= 1 && (!total || n <= total)) {
      storeImage(p, n, f.path, f.name);
      assigned.push({ file: f.name, shot: n });
    } else if (n && total && n > total) {
      ignored.push(f.name);
      fs.rmSync(f.path, { force: true });
    } else {
      unnumbered.push(f);
    }
  }
  // Files without a shot number fill the lowest empty shots, oldest first (ChatGPT makes them in order),
  // falling back to natural filename order.
  unnumbered.sort((a, b) => (a.time - b.time) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  let slot = 1;
  for (const f of unnumbered) {
    while (p.images[slot] && (!total || slot <= total)) slot++;
    if (total && slot > total) { ignored.push(f.name); fs.rmSync(f.path, { force: true }); continue; }
    storeImage(p, slot, f.path, f.name);
    assigned.push({ file: f.name, shot: slot, guessed: true });
  }
  await save(p);
  res.json({ project: view(p), assigned, ignored });
}));

app.post('/api/projects/:id/images/:n', upload.single('file'), wrap(async (req, res) => {
  const p = getProject(req.params.id);
  const n = Number(req.params.n);
  if (!req.file || !IMAGE_EXT.test(req.file.originalname)) throw Object.assign(new Error('Upload a PNG, JPG or WEBP image.'), { status: 400 });
  storeImage(p, n, req.file.path, req.file.originalname);
  await save(p);
  res.json(view(p));
}));

app.delete('/api/projects/:id/images', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  fs.rmSync(projectDir(p.id, 'images'), { recursive: true, force: true });
  fs.mkdirSync(projectDir(p.id, 'images'), { recursive: true });
  p.images = {};
  await save(p);
  res.json(view(p));
}));

// ---- audio + whisper sync --------------------------------------------------------------

app.post('/api/projects/:id/audio', upload.single('file'), wrap(async (req, res) => {
  const p = getProject(req.params.id);
  if (!req.file || !AUDIO_EXT.test(req.file.originalname)) throw Object.assign(new Error('Upload an MP3, WAV, M4A, AAC, OGG, FLAC or WEBM file.'), { status: 400 });
  fs.rmSync(projectDir(p.id, 'audio'), { recursive: true, force: true });
  fs.mkdirSync(projectDir(p.id, 'audio'), { recursive: true });
  const name = `narration${path.extname(req.file.originalname).toLowerCase()}`;
  const dest = projectDir(p.id, 'audio', name);
  fs.renameSync(req.file.path, dest);
  let duration = Number(req.body?.duration) || null;
  try {
    const meta = await parseMedia({ src: dest, reader: nodeReader, fields: { durationInSeconds: true }, acknowledgeRemotionLicense: true });
    if (meta.durationInSeconds) duration = meta.durationInSeconds;
  } catch (err) {
    console.warn('Could not read audio duration on the server, using the browser value:', err.message);
  }
  p.audio = { file: name, originalName: req.file.originalname, duration };
  p.transcript = null;
  p.timeline = null;
  await save(p);
  res.json(view(p));
}));

function computeTimeline(p) {
  const { timeline, stats } = alignShots(p.plan.shots, p.transcript.words, {
    duration: p.audio?.duration,
    fps: p.settings.fps,
    leadSeconds: p.settings.leadSeconds,
  });
  p.timeline = timeline;
  p.alignStats = stats;
}

app.post('/api/projects/:id/transcribe', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  if (!p.audio) throw Object.assign(new Error('Upload the narration audio first.'), { status: 400 });
  if (!replicate.hasToken()) throw Object.assign(new Error('REPLICATE_API_TOKEN is not set on the server.'), { status: 400 });
  if (running(p, 'transcribe')) throw Object.assign(new Error('Transcription is already running.'), { status: 409 });
  setJob(p, 'transcribe', { status: 'running', message: 'Uploading audio to Replicate…', progress: 0 });
  res.json(view(p));
  (async () => {
    try {
      const result = await transcribe(projectDir(p.id, 'audio', p.audio.file), {
        engine: p.settings.whisperEngine,
        language: p.settings.language || undefined,
        onStatus: (pred) => setJob(p, 'transcribe', { message: `Whisper: ${pred.status}…` }),
      });
      p.transcript = { engine: result.engine, model: result.model, words: result.words };
      if (p.plan) computeTimeline(p);
      setJob(p, 'transcribe', { status: 'done', progress: 1, message: `Transcribed ${result.words.length} words${p.alignStats ? `, ${Math.round(p.alignStats.matchRate * 100)}% matched to the script` : ''}.` });
    } catch (err) {
      console.error(err);
      setJob(p, 'transcribe', { status: 'error', message: err.message });
    }
  })();
}));

/** Use your own Whisper/WhisperX JSON output instead of calling Replicate. */
app.post('/api/projects/:id/transcript/import', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  const words = normalizeTranscript(req.body);
  if (!words.length) throw Object.assign(new Error('Could not find timed words/segments in that JSON.'), { status: 400 });
  p.transcript = { engine: 'imported', model: null, words };
  if (p.plan) computeTimeline(p);
  await save(p);
  res.json(view(p));
}));

app.post('/api/projects/:id/sync', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  if (!p.plan) throw Object.assign(new Error('No shot plan yet.'), { status: 400 });
  if (!p.transcript) throw Object.assign(new Error('Transcribe the audio first.'), { status: 400 });
  computeTimeline(p);
  await save(p);
  res.json(view(p));
}));

// ---- render ----------------------------------------------------------------------

app.post('/api/projects/:id/render', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  if (!p.timeline) throw Object.assign(new Error('Sync the audio first.'), { status: 400 });
  if (running(p, 'render')) throw Object.assign(new Error('A render is already running.'), { status: 409 });
  const shots = p.plan.shots.length;
  // Missing images hold the previous available image so the video never goes black mid-story.
  const resolved = [];
  let lastAvailable = null;
  for (let n = 1; n <= shots; n++) {
    if (p.images[n]) lastAvailable = n;
    resolved[n] = p.images[n] ? n : lastAvailable;
  }
  const firstAvailable = Object.keys(p.images).map(Number).filter((n) => n <= shots).sort((a, b) => a - b)[0];
  if (!firstAvailable) throw Object.assign(new Error('Upload the images first.'), { status: 400 });
  const missing = [];
  for (let n = 1; n <= shots; n++) if (!p.images[n]) missing.push(n);
  const [width, height] = ASPECTS[p.settings.aspectRatio].video;
  const base = `http://127.0.0.1:${PORT}/files/${p.id}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outName = `${slug(p.title)}-${stamp}.mp4`;
  const props = timelineToProps({
    timeline: p.timeline,
    imageUrl: (n) => `${base}/images/${encodeURIComponent(p.images[resolved[n] || firstAvailable])}`,
    audioUrl: p.audio ? `${base}/audio/${encodeURIComponent(p.audio.file)}` : null,
    fps: p.settings.fps, width, height,
    motion: p.settings.motion, transition: p.settings.transition, transitionFrames: p.settings.transitionFrames,
  });
  setJob(p, 'render', { status: 'running', progress: 0, message: missing.length ? `Rendering (${missing.length} missing image(s) will hold the previous image)…` : 'Rendering…' });
  res.json(view(p));
  (async () => {
    try {
      let lastSave = 0;
      await renderVideo(props, projectDir(p.id, 'renders', outName), (u) => {
        if (Date.now() - lastSave < 1500 && u.stage !== 'done') return;
        lastSave = Date.now();
        setJob(p, 'render', { progress: u.progress, message: `${u.stage}… ${Math.round((u.progress || 0) * 100)}%` });
      });
      p.renders.unshift({ file: outName, createdAt: new Date().toISOString(), missing });
      setJob(p, 'render', { status: 'done', progress: 1, message: 'Video ready.' });
    } catch (err) {
      console.error(err);
      setJob(p, 'render', { status: 'error', message: err.message });
    }
  })();
}));

// ---- errors ----------------------------------------------------------------------

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) err.status = 400;
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`AI Director Lite running at http://localhost:${PORT}`);
    if (!replicate.hasToken()) console.log('⚠  REPLICATE_API_TOKEN is not set — planning and Whisper will not work until you add it to .env');
  });
}

export { app };
