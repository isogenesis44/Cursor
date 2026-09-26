// Minimal Replicate HTTP client (no SDK): run a model, poll until done, upload files.
import fs from 'node:fs/promises';
import path from 'node:path';

const API = process.env.REPLICATE_API_BASE || 'https://api.replicate.com/v1';
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const versionCache = new Map();

function token() {
  const t = process.env.REPLICATE_API_TOKEN;
  if (!t) throw new Error('REPLICATE_API_TOKEN is not set. Add it to your .env file (see .env.example).');
  return t;
}

async function api(method, url, body, extraHeaders = {}) {
  const headers = { Authorization: `Bearer ${token()}`, ...extraHeaders };
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url.startsWith('http') ? url : API + url, { method, headers, body: payload });
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 5) {
        const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await sleep(Math.min(retryAfter, 30) * 1000);
        continue;
      }
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`Replicate ${method} ${url} failed (${res.status}): ${data.detail || data.title || text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "owner/name" or "owner/name:versionhash"
async function createPrediction(model, input) {
  const [ref, pinned] = model.split(':');
  if (pinned) {
    return api('POST', '/predictions', { version: pinned, input }, { Prefer: 'wait=55' });
  }
  // Official models (e.g. openai/*) accept the model-scoped endpoint. Community models need a version.
  try {
    return await api('POST', `/models/${ref}/predictions`, { input }, { Prefer: 'wait=55' });
  } catch (err) {
    if (![404, 422].includes(err.status)) throw err;
    let version = versionCache.get(ref);
    if (!version) {
      const info = await api('GET', `/models/${ref}`);
      version = info.latest_version?.id;
      if (!version) throw err;
      versionCache.set(ref, version);
    }
    return api('POST', '/predictions', { version, input }, { Prefer: 'wait=55' });
  }
}

/**
 * Run a model to completion and return the prediction's output.
 * onStatus(prediction) is called on every poll.
 */
export async function runModel(model, input, { onStatus, timeoutMs = 30 * 60 * 1000 } = {}) {
  let pred = await createPrediction(model, input);
  const started = Date.now();
  while (!TERMINAL.has(pred.status)) {
    onStatus?.(pred);
    if (Date.now() - started > timeoutMs) throw new Error(`Replicate prediction ${pred.id} timed out`);
    await sleep(2000);
    pred = await api('GET', pred.urls?.get || `/predictions/${pred.id}`);
  }
  if (pred.status !== 'succeeded') {
    throw new Error(`Replicate prediction ${pred.id} ${pred.status}: ${pred.error || 'no error message'}`);
  }
  return pred.output;
}

/** Run a text LLM (e.g. openai/gpt-5.6-sol) and return the concatenated text output. */
export async function runText(model, { system, prompt, images = [], reasoningEffort, maxTokens }, opts) {
  const input = { prompt, system_prompt: system };
  if (images.length) input.image_input = images;
  if (reasoningEffort) input.reasoning_effort = reasoningEffort;
  if (maxTokens) input.max_completion_tokens = maxTokens;
  const out = await runModel(model, input, opts);
  return Array.isArray(out) ? out.join('') : typeof out === 'string' ? out : JSON.stringify(out);
}

/** Upload a local file to Replicate's file store and return a URL models can read. */
export async function uploadFile(filePath, contentType = 'application/octet-stream') {
  const buf = await fs.readFile(filePath);
  const form = new FormData();
  form.append('content', new Blob([buf], { type: contentType }), path.basename(filePath));
  const data = await api('POST', '/files', form);
  return data.urls?.get;
}

export function hasToken() {
  return Boolean(process.env.REPLICATE_API_TOKEN);
}
