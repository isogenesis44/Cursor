const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let project = null;
let pollTimer = null;
let planSig = '';
let imageSig = '';

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), isError ? 7000 : 3000);
}

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { toast(err.message, true); }
};

const fmtTime = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
};

// ---- projects ------------------------------------------------------------------

async function loadProjects(selectId) {
  const list = await api('GET', '/api/projects');
  const sel = $('projectSelect');
  sel.innerHTML = list.map((p) => `<option value="${p.id}">${esc(p.title)} — ${p.shots} shots</option>`).join('') || '<option value="">(no videos yet)</option>';
  const id = selectId || localStorage.getItem('project') || list[0]?.id;
  if (id && list.some((p) => p.id === id)) {
    sel.value = id;
    await openProject(id);
  } else if (!list.length) {
    $('app').classList.add('hidden');
  }
}

async function openProject(id) {
  localStorage.setItem('project', id);
  planSig = '';
  imageSig = '';
  project = await api('GET', `/api/projects/${id}`);
  fillForm();
  render();
  $('app').classList.remove('hidden');
}

const SETTING_FIELDS = ['aspectRatio', 'style', 'model', 'reasoningEffort', 'maxTokens', 'chunkWords', 'imagesPerRun', 'driveFolder', 'whisperEngine', 'language', 'leadSeconds', 'fps', 'motion', 'transition', 'transitionFrames'];

function fillForm() {
  $('title').value = project.title;
  $('script').value = project.script || '';
  for (const k of SETTING_FIELDS) $(k).value = project.settings[k] ?? '';
  updateWordCount();
}

function updateWordCount() {
  $('wordCount').textContent = ($('script').value.match(/\S+/g) || []).length;
}

let saveTimer = null;
function queueSave(patch) {
  clearTimeout(saveTimer);
  queueSave.pending = { ...(queueSave.pending || {}), ...patch, settings: { ...(queueSave.pending?.settings || {}), ...(patch.settings || {}) } };
  saveTimer = setTimeout(flushSave, 500);
}
async function flushSave() {
  clearTimeout(saveTimer);
  const patch = queueSave.pending;
  queueSave.pending = null;
  if (!patch || !project) return;
  project = await api('PATCH', `/api/projects/${project.id}`, patch);
  render();
}

// ---- rendering -----------------------------------------------------------------

function jobBox(el, job, extra = '') {
  if (!job) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.className = `job ${job.status}`;
  const pct = Math.round((job.progress || 0) * 100);
  const warnings = job.warnings?.length ? `<details><summary>${job.warnings.length} note(s)</summary><ul>${job.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : '';
  el.innerHTML = `${job.status === 'running' ? '⏳' : job.status === 'error' ? '⚠️' : '✅'} ${esc(job.message || '')}${extra}
    ${job.status === 'running' ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}${warnings}`;
}

function render() {
  const p = project;
  const d = p.derived;
  jobBox($('planJob'), p.jobs.plan);
  jobBox($('transcribeJob'), p.jobs.transcribe);
  jobBox($('renderJob'), p.jobs.render);
  $('planBtn').disabled = p.jobs.plan?.status === 'running';
  $('transcribeBtn').disabled = p.jobs.transcribe?.status === 'running';
  $('renderBtn').disabled = p.jobs.render?.status === 'running';

  // Style reference
  if (p.styleImage) {
    $('styleImg').src = `/files/${p.id}/${p.styleImage}?t=${encodeURIComponent(p.updatedAt)}`;
    $('styleImg').classList.remove('hidden');
    $('removeStyle').classList.remove('hidden');
  } else {
    $('styleImg').classList.add('hidden');
    $('removeStyle').classList.add('hidden');
  }

  renderPlan();
  renderImages();
  renderAudio();
  renderRenders();

  const busy = Object.values(p.jobs).some((j) => j.status === 'running');
  clearTimeout(pollTimer);
  if (busy) pollTimer = setTimeout(poll, 1500);
}

async function poll() {
  if (!project) return;
  try {
    project = await api('GET', `/api/projects/${project.id}`);
    render();
  } catch (err) {
    pollTimer = setTimeout(poll, 4000);
  }
}

function renderPlan() {
  const p = project;
  const plan = p.plan;
  $('planEmpty').classList.toggle('hidden', Boolean(plan));
  $('planBody').classList.toggle('hidden', !plan);
  if (!plan) return;
  const d = p.derived;
  const keys = plan.shots.filter((s) => s.type === 'keyframe').length;
  const est = plan.shots.reduce((a, s) => a + (s.duration_hint_seconds || 1), 0);
  $('planStats').innerHTML = `
    <span class="stat"><b>${plan.shots.length}</b>images to generate</span>
    <span class="stat"><b>${keys}</b>new scenes</span>
    <span class="stat"><b>${plan.shots.length - keys}</b>continuation edits</span>
    <span class="stat"><b>${plan.characters.length}</b>characters</span>
    <span class="stat"><b>${d.runs.length}</b>ChatGPT runs of ≤${p.settings.imagesPerRun}</span>
    <span class="stat"><b>~${Math.round(est)}s</b>Director's pacing estimate</span>
    ${d.coverageOk === false ? '<span class="stat bad">⚠ shot texts don\'t cover the current script — re-direct it</span>' : d.coverageOk ? '<span class="stat ok">✓ every word of the script is covered</span>' : ''}`;
  $('dlJob').href = `/api/projects/${p.id}/export/chatgpt.json`;
  $('dlPlan').href = `/api/projects/${p.id}/export/plan.json`;
  $('runs').innerHTML = d.runs.length > 1
    ? `<span class="muted small">Per-run files:</span>` + d.runs.map((r) => `<a class="button ghost" href="/api/projects/${p.id}/export/chatgpt.json?run=${r.run}" download>Run ${r.run} · #${r.first}–${r.last}</a>`).join('')
    : '';

  const sig = `${p.jobs.plan?.updatedAt}|${plan.shots.length}|${p.styleImage}|${p.settings.style}`;
  if (sig === planSig) return;
  planSig = sig;

  $('charCount').textContent = plan.characters.length;
  $('characters').innerHTML = plan.characters.map((c) => `
    <div class="char"><h4>${esc(c.name)}</h4><div class="muted">${esc(c.description)}</div>
      <dl>${Object.entries(c.visual_persona).filter(([, v]) => v).map(([k, v]) => `<dt>${k.replace(/_/g, ' ')}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    </div>`).join('');

  $('shotRows').innerHTML = plan.shots.map((s, i) => {
    const n = i + 1;
    const field = s.type === 'edit' ? 'edit_instruction' : 'scene_description';
    const img = p.images[n];
    return `<tr data-n="${n}">
      <td>${n}</td>
      <td><span class="tag ${s.type}">${s.type}</span><div class="meta">${esc(s.subject_focus)}<br>${esc(s.character_visibility)}${s.character_name ? `<br>${esc(s.character_name)}` : ''}</div></td>
      <td class="narr">${esc(s.text)}${s.wardrobe_override ? `<div class="meta">👕 ${esc(s.wardrobe_override)}</div>` : ''}</td>
      <td><textarea data-field="${field}" data-n="${n}">${esc(s[field] || '')}</textarea>
        <details><summary>Final image prompt sent to ChatGPT</summary><pre id="prompt-${n}">${esc(d.prompts[i])}</pre></details></td>
      <td>${img ? `<img class="thumb" loading="lazy" src="/files/${p.id}/images/${encodeURIComponent(img)}?t=${encodeURIComponent(p.updatedAt)}" />` : '<div class="thumb"></div>'}</td>
    </tr>`;
  }).join('');
}

function renderImages() {
  const p = project;
  const d = p.derived;
  const total = d.shots;
  $('imageStats').innerHTML = total
    ? `<span class="stat ${d.missing.length ? 'warn' : 'ok'}"><b>${d.imageCount}</b>of ${total} images uploaded</span>
       ${d.missing.length ? `<span class="stat warn">Missing: ${d.missing.length > 30 ? d.missing.slice(0, 30).join(', ') + '…' : d.missing.join(', ')}</span>` : ''}`
    : `<span class="stat"><b>${Object.keys(p.images).length}</b>images uploaded (no plan yet)</span>`;
  const sig = `${p.updatedAt}|${Object.keys(p.images).length}|${total}`;
  if (sig === imageSig) return;
  imageSig = sig;
  const count = Math.max(total, ...Object.keys(p.images).map(Number), 0);
  const cells = [];
  for (let n = 1; n <= count; n++) {
    const img = p.images[n];
    cells.push(`<div class="cell"><span class="n">${n}</span>
      ${img ? `<img loading="lazy" src="/files/${p.id}/images/${encodeURIComponent(img)}?t=${encodeURIComponent(p.updatedAt)}" />` : '<div class="missing">missing</div>'}
      <label>${img ? 'replace' : 'upload'}<input type="file" hidden accept="image/*" data-replace="${n}" /></label></div>`);
  }
  $('imageGrid').innerHTML = cells.join('');
}

function renderAudio() {
  const p = project;
  if (p.audio) {
    $('audioInfo').textContent = `${p.audio.originalName} · ${p.audio.duration ? fmtTime(p.audio.duration) : 'duration unknown'}`;
    const src = `/files/${p.id}/audio/${encodeURIComponent(p.audio.file)}`;
    if (!$('audioPlayer').src.endsWith(src)) $('audioPlayer').src = src;
    $('audioPlayer').classList.remove('hidden');
  } else {
    $('audioInfo').textContent = 'No audio yet.';
    $('audioPlayer').classList.add('hidden');
  }
  const st = p.alignStats;
  if (p.timeline && st) {
    const low = p.timeline.filter((t) => t.matched < 0.5).length;
    const short = p.timeline.filter((t) => t.duration < 0.4).length;
    $('syncStats').innerHTML = `
      <span class="stat ${st.matchRate > 0.85 ? 'ok' : 'warn'}"><b>${Math.round(st.matchRate * 100)}%</b>script words matched in audio</span>
      <span class="stat"><b>${fmtTime(st.totalSeconds)}</b>video length</span>
      <span class="stat"><b>${(st.totalSeconds / p.timeline.length).toFixed(2)}s</b>average per image</span>
      ${low ? `<span class="stat warn"><b>${low}</b>shots with weak word matches (timing interpolated)</span>` : ''}
      ${short ? `<span class="stat warn"><b>${short}</b>images shorter than 0.4s</span>` : ''}`;
    const total = st.totalSeconds || 1;
    $('timelineBar').innerHTML = p.timeline.map((t) => {
      const s = p.plan.shots[t.shot - 1];
      const cls = t.matched < 0.5 ? 'lo' : s?.type === 'edit' ? 'e' : 'k';
      return `<div class="${cls}" style="width:${(t.duration / total) * 100}%" title="#${t.shot} · ${fmtTime(t.start)} → ${t.duration.toFixed(2)}s · ${esc(s?.text || '')}"></div>`;
    }).join('');
    $('preview').classList.remove('hidden');
    if (!$('previewImg').dataset.src) {
      const first = Object.keys(p.images).map(Number).sort((a, b) => a - b)[0];
      if (first) { $('previewImg').src = `/files/${p.id}/images/${encodeURIComponent(p.images[first])}`; $('previewImg').dataset.src = $('previewImg').src; }
    }
  } else {
    $('syncStats').innerHTML = p.transcript ? '' : '<span class="muted small">Upload audio, then Transcribe &amp; sync.</span>';
    $('timelineBar').innerHTML = '';
    $('preview').classList.add('hidden');
  }
}

function renderRenders() {
  const p = project;
  $('renders').innerHTML = (p.renders || []).map((r, i) => `
    <div class="render">
      ${i === 0 ? `<video controls src="/files/${p.id}/renders/${encodeURIComponent(r.file)}"></video>` : ''}
      <div><a class="button" href="/files/${p.id}/renders/${encodeURIComponent(r.file)}" download>⬇ ${esc(r.file)}</a>
      <div class="muted small">${new Date(r.createdAt).toLocaleString()}${r.missing?.length ? ` · ${r.missing.length} missing image(s) held the previous frame` : ''}</div></div>
    </div>`).join('');
}

// ---- preview player ------------------------------------------------------------

function previewTick() {
  const p = project;
  const audio = $('audioPlayer');
  if (p?.timeline && !audio.paused) {
    const t = audio.currentTime;
    let lo = 0;
    let hi = p.timeline.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (p.timeline[mid].start <= t) lo = mid; else hi = mid - 1; }
    const cur = p.timeline[lo];
    let n = cur.shot;
    while (n > 1 && !p.images[n]) n--;
    const img = p.images[n];
    const src = img ? `/files/${p.id}/images/${encodeURIComponent(img)}` : '';
    if ($('previewImg').dataset.src !== src) { $('previewImg').src = src; $('previewImg').dataset.src = src; }
    $('previewCaption').textContent = `#${cur.shot} · ${p.plan.shots[cur.shot - 1]?.text || ''}`;
  }
  requestAnimationFrame(previewTick);
}

// ---- uploads -------------------------------------------------------------------

async function uploadImages(files) {
  files = [...files].filter((f) => /\.(png|jpe?g|webp|zip)$/i.test(f.name));
  if (!files.length) return toast('No images or .zip files found.', true);
  const box = $('uploadJob');
  const BATCH = 25;
  let assigned = 0;
  const ignored = [];
  try {
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      jobBox(box, { status: 'running', message: `Uploading ${Math.min(i + BATCH, files.length)} of ${files.length}…`, progress: i / files.length });
      const fd = new FormData();
      fd.append('lastModified', JSON.stringify(Object.fromEntries(batch.map((f) => [f.name, f.lastModified]))));
      batch.forEach((f) => fd.append('files', f, f.name));
      const r = await api('POST', `/api/projects/${project.id}/images`, fd);
      project = r.project;
      assigned += r.assigned.length;
      ignored.push(...r.ignored);
    }
    jobBox(box, { status: 'done', message: `Uploaded ${assigned} image(s).`, warnings: ignored.length ? [`Ignored (shot number beyond the plan): ${ignored.join(', ')}`] : [] });
  } catch (err) {
    jobBox(box, { status: 'error', message: err.message });
  }
  planSig = '';
  render();
}

function readJsonFile(file) {
  return file.text().then((t) => JSON.parse(t));
}

function audioDuration(file) {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => { resolve(Number.isFinite(a.duration) ? a.duration : null); URL.revokeObjectURL(a.src); };
    a.onerror = () => resolve(null);
    a.src = URL.createObjectURL(file);
  });
}

// ---- wiring --------------------------------------------------------------------

function wire() {
  $('projectSelect').onchange = guard((e) => openProject(e.target.value));
  $('newProject').onclick = guard(async () => {
    const title = prompt('Name this video', 'Untitled video');
    if (title === null) return;
    const p = await api('POST', '/api/projects', { title });
    await loadProjects(p.id);
  });
  $('deleteProject').onclick = guard(async () => {
    if (!project || !confirm(`Delete "${project.title}" and all its images, audio and renders?`)) return;
    await api('DELETE', `/api/projects/${project.id}`);
    localStorage.removeItem('project');
    project = null;
    await loadProjects();
  });

  $('title').oninput = () => queueSave({ title: $('title').value });
  $('script').oninput = () => { updateWordCount(); queueSave({ script: $('script').value }); };
  for (const k of SETTING_FIELDS) {
    $(k).addEventListener('change', () => queueSave({ settings: { [k]: $(k).value } }));
  }

  $('styleFile').onchange = guard(async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    project = await api('POST', `/api/projects/${project.id}/style-image`, fd);
    planSig = '';
    render();
    e.target.value = '';
  });
  $('removeStyle').onclick = guard(async () => {
    project = await api('DELETE', `/api/projects/${project.id}/style-image`);
    planSig = '';
    render();
  });

  $('planBtn').onclick = guard(async () => {
    await flushSave();
    if (project.plan && !confirm('Re-directing replaces the current shot plan (uploaded images stay, but may no longer match their shots). Continue?')) return;
    project = await api('POST', `/api/projects/${project.id}/plan`);
    render();
  });
  $('importPlan').onchange = guard(async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    await flushSave();
    project = await api('POST', `/api/projects/${project.id}/plan/import`, await readJsonFile(f));
    planSig = '';
    render();
    e.target.value = '';
  });

  $('copyInstructions').onclick = guard(async () => {
    const text = await fetch(`/api/projects/${project.id}/export/instructions.txt`).then((r) => r.text());
    await navigator.clipboard.writeText(text);
    toast('Instructions copied — paste them into ChatGPT with the JSON attached.');
  });

  // Direction edits (event delegation)
  $('shotRows').addEventListener('change', guard(async (e) => {
    const ta = e.target.closest('textarea[data-field]');
    if (!ta) return;
    const n = ta.dataset.n;
    project = await api('PATCH', `/api/projects/${project.id}/shots/${n}`, { [ta.dataset.field]: ta.value });
    $(`prompt-${n}`).textContent = project.derived.prompts[n - 1];
    toast(`Shot ${n} updated.`);
  }));

  // Images
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); uploadImages(e.dataTransfer.files); });
  $('imageFiles').onchange = (e) => { uploadImages(e.target.files); e.target.value = ''; };
  $('imageGrid').addEventListener('change', guard(async (e) => {
    const input = e.target.closest('input[data-replace]');
    if (!input?.files[0]) return;
    const fd = new FormData();
    fd.append('file', input.files[0]);
    project = await api('POST', `/api/projects/${project.id}/images/${input.dataset.replace}`, fd);
    planSig = '';
    render();
  }));
  $('clearImages').onclick = guard(async () => {
    if (!confirm('Remove all uploaded images for this video?')) return;
    project = await api('DELETE', `/api/projects/${project.id}/images`);
    planSig = '';
    render();
  });

  // Audio
  $('audioFile').onchange = guard(async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    const dur = await audioDuration(f);
    if (dur) fd.append('duration', String(dur));
    fd.append('file', f);
    toast('Uploading audio…');
    project = await api('POST', `/api/projects/${project.id}/audio`, fd);
    render();
    e.target.value = '';
  });
  $('transcribeBtn').onclick = guard(async () => {
    await flushSave();
    project = await api('POST', `/api/projects/${project.id}/transcribe`);
    render();
  });
  $('resyncBtn').onclick = guard(async () => {
    await flushSave();
    project = await api('POST', `/api/projects/${project.id}/sync`);
    render();
    toast('Re-synced.');
  });
  $('importTranscript').onchange = guard(async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    project = await api('POST', `/api/projects/${project.id}/transcript/import`, await readJsonFile(f));
    render();
    e.target.value = '';
  });

  // Render
  $('renderBtn').onclick = guard(async () => {
    await flushSave();
    const missing = project.derived.missing.length;
    if (missing && !confirm(`${missing} image(s) are missing. They will hold the previous image. Render anyway?`)) return;
    project = await api('POST', `/api/projects/${project.id}/render`);
    render();
  });
}

(async () => {
  wire();
  requestAnimationFrame(previewTick);
  try {
    const health = await api('GET', '/api/health');
    $('tokenWarning').classList.toggle('hidden', health.replicateToken);
    await loadProjects();
    if (!project) {
      const p = await api('POST', '/api/projects', { title: 'My first video' });
      await loadProjects(p.id);
    }
  } catch (err) {
    toast(err.message, true);
  }
})();
