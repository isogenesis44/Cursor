// File-based project store: data/projects/<id>/project.json plus images/, audio/, renders/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const PROJECTS = path.join(DATA_DIR, 'projects');
fs.mkdirSync(PROJECTS, { recursive: true });

const cache = new Map();
const writeChains = new Map();

export const projectDir = (id, ...sub) => {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('Bad project id');
  return path.join(PROJECTS, id, ...sub);
};

export const DEFAULT_SETTINGS = {
  aspectRatio: '16:9',
  style: '',
  model: process.env.REPLICATE_TEXT_MODEL || 'openai/gpt-5.6-sol',
  reasoningEffort: 'medium',
  maxTokens: 32000,
  chunkWords: 400,
  imagesPerRun: 40,
  driveFolder: '',
  whisperEngine: 'whisperx',
  language: 'en',
  fps: 30,
  motion: 'kenburns',
  transition: 'cut',
  transitionFrames: 4,
  leadSeconds: 0,
};

function load(id) {
  if (cache.has(id)) return cache.get(id);
  const file = projectDir(id, 'project.json');
  if (!fs.existsSync(file)) return null;
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.settings = { ...DEFAULT_SETTINGS, ...p.settings };
  // Jobs that were running when the server stopped can't still be running.
  for (const job of Object.values(p.jobs || {})) {
    if (job.status === 'running') Object.assign(job, { status: 'error', message: 'Interrupted (server restarted). Start it again.' });
  }
  cache.set(id, p);
  return p;
}

export function getProject(id) {
  const p = load(id);
  if (!p) {
    const err = new Error('Project not found');
    err.status = 404;
    throw err;
  }
  return p;
}

export function listProjects() {
  return fs.readdirSync(PROJECTS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PROJECTS, d.name, 'project.json')))
    .map((d) => load(d.name))
    .filter(Boolean)
    .map((p) => ({ id: p.id, title: p.title, updatedAt: p.updatedAt, shots: p.plan?.shots?.length || 0, images: Object.keys(p.images || {}).length }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function createProject(title) {
  const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  for (const sub of ['images', 'audio', 'renders', 'uploads']) fs.mkdirSync(projectDir(id, sub), { recursive: true });
  const now = new Date().toISOString();
  const p = {
    id, title: title?.trim() || 'Untitled video', createdAt: now, updatedAt: now,
    settings: { ...DEFAULT_SETTINGS }, script: '', styleImage: null,
    plan: null, images: {}, audio: null, transcript: null, timeline: null, alignStats: null,
    jobs: {}, renders: [],
  };
  cache.set(id, p);
  save(p);
  return p;
}

export function save(p) {
  p.updatedAt = new Date().toISOString();
  const file = projectDir(p.id, 'project.json');
  const data = JSON.stringify(p, null, 2);
  const prev = writeChains.get(p.id) || Promise.resolve();
  const next = prev.then(async () => {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, file);
  }).catch((err) => console.error('save failed', err));
  writeChains.set(p.id, next);
  return next;
}

export function deleteProject(id) {
  cache.delete(id);
  fs.rmSync(projectDir(id), { recursive: true, force: true });
}

export function setJob(p, kind, patch) {
  p.jobs[kind] = { ...(p.jobs[kind] || {}), ...patch, updatedAt: new Date().toISOString() };
  save(p);
}
