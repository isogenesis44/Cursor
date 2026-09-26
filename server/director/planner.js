// "Direct This Script": script -> character bible + shot plan, via a Replicate-hosted LLM.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runText } from '../replicate.js';
import {
  extractJson, normalizeCharacter, normalizeShot, enforceStructure, reconcileCoverage,
  isWeakDirection, directionOf,
} from './validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name) => fs.readFileSync(path.join(here, 'prompts', name), 'utf8').replace(/\n$/, '');
const P = {
  system: load('system.txt'),
  header: load('planning_header.txt'),
  rules: load('planning_rules.txt'),
  reference: load('reference_image.txt'),
  section: load('chunk_section.txt'),
  known: load('chunk_known_characters.txt'),
  preceding: load('chunk_preceding.txt'),
  repairSystem: load('repair_system.txt'),
  repairUser: load('repair_user.txt'),
};

const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));

/** Split a script at sentence boundaries into ~targetWords chunks. Concatenating chunks returns the script. */
export function splitScript(script, targetWords = 400) {
  const sentences = script.match(/[^.!?…]*(?:[.!?…]+["'”’)\]]*|$)\s*/g)?.filter(Boolean) || [script];
  const chunks = [];
  let cur = '';
  let count = 0;
  for (const s of sentences) {
    const w = s.split(/\s+/).filter(Boolean).length;
    if (cur && count + w > targetWords) {
      chunks.push(cur);
      cur = '';
      count = 0;
    }
    cur += s;
    count += w;
  }
  if (cur.trim()) chunks.push(cur);
  else if (chunks.length && cur) chunks[chunks.length - 1] += cur;
  return chunks;
}

export function buildPlanningPrompt({ script, aspectRatio, style, hasReference, section, knownNames, preceding }) {
  const blocks = [];
  if (hasReference) blocks.push(P.reference);
  if (section && section.total > 1) {
    blocks.push(fill(P.section, { NUMBER: section.number, TOTAL: section.total }));
  }
  if (knownNames?.length) blocks.push(fill(P.known, { NAMES: knownNames.join(', ') }));
  if (preceding) blocks.push(fill(P.preceding, { PRECEDING: preceding }));
  const header = fill(P.header, {
    SCRIPT: script.trim(),
    ASPECT_RATIO: aspectRatio,
    STYLE: hasReference ? `${style || 'none selected'} (informational only — the reference image overrides it)` : style || 'Director\'s choice',
  });
  return header + '\n' + (blocks.length ? blocks.join('\n\n') + '\n\n' : '') + P.rules;
}

function precedingSummary(chunkText, shots) {
  const tail = chunkText.trim().split(/\s+/).slice(-40).join(' ');
  const last = shots[shots.length - 1];
  let lastKey = null;
  for (let i = shots.length - 1; i >= 0; i--) if (shots[i].type === 'keyframe') { lastKey = shots[i]; break; }
  const lines = [`Last words: "…${tail}"`];
  if (lastKey) {
    lines.push(`Current scene keyframe: ${lastKey.scene_description}`);
    if (lastKey.wardrobe_override) lines.push(`Current wardrobe: ${lastKey.wardrobe_override}`);
  }
  if (last && last !== lastKey && last.edit_instruction) lines.push(`Last visual state (edit): ${last.edit_instruction}`);
  if (last) lines.push(`Last shot: character=${last.character_name || 'none'}, visibility=${last.character_visibility}, subject=${last.subject_focus}`);
  return lines.join('\n');
}

async function callJson(model, request, settings, log, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1
      ? request.prompt
      : `${request.prompt}\n\nIMPORTANT: your previous answer could not be parsed as JSON (${lastErr.message}). Return ONLY the JSON object.`;
    const text = await runText(model, { ...request, prompt, reasoningEffort: settings.reasoningEffort, maxTokens: settings.maxTokens });
    try {
      return extractJson(text);
    } catch (err) {
      lastErr = err;
      log(`${label}: response was not valid JSON (attempt ${attempt}).`);
    }
  }
  throw new Error(`${label}: model did not return valid JSON — ${lastErr.message}`);
}

/**
 * Plan a whole script. settings = { model, aspectRatio, style, styleImageUrl, reasoningEffort, maxTokens, chunkWords }
 * progress({ stage, done, total, message })
 */
export async function planScript(scriptRaw, settings, progress = () => {}) {
  const script = scriptRaw.normalize('NFKC');
  const log = (message) => progress({ message });
  const chunks = splitScript(script, settings.chunkWords || 400);
  const characters = [];
  const shots = [];
  const chunkOf = []; // chunk index per shot
  const warnings = [];

  for (let c = 0; c < chunks.length; c++) {
    progress({ stage: 'planning', done: c, total: chunks.length, message: `Planning section ${c + 1} of ${chunks.length}…` });
    const prompt = buildPlanningPrompt({
      script: chunks[c],
      aspectRatio: settings.aspectRatio,
      style: settings.style,
      hasReference: Boolean(settings.styleImageUrl),
      section: { number: c + 1, total: chunks.length },
      knownNames: characters.map((ch) => ch.name),
      preceding: c > 0 ? precedingSummary(chunks[c - 1], shots) : null,
    });
    const json = await callJson(settings.model, {
      system: P.system,
      prompt,
      images: settings.styleImageUrl ? [settings.styleImageUrl] : [],
    }, settings, log, `Section ${c + 1}`);

    for (const raw of json.characters || []) {
      const ch = normalizeCharacter(raw);
      if (!characters.some((k) => k.name.toLowerCase() === ch.name.toLowerCase())) characters.push(ch);
    }
    const planned = (json.shots || []).map(normalizeShot);
    const { shots: covered, fixes } = reconcileCoverage(chunks[c], planned);
    fixes.forEach((f) => warnings.push(`Section ${c + 1}: ${f}`));
    if (!covered.length) throw new Error(`Section ${c + 1}: the Director returned no usable shots.`);
    enforceStructure(covered, { offset: shots.length, allowLeadingEdit: c > 0 });
    covered.forEach((s) => { shots.push(s); chunkOf.push(c); });
  }

  const plan = { characters, shots };
  progress({ stage: 'repair', done: 0, total: 1, message: 'Checking for weak visual directions…' });
  await repairWeakShots(plan, chunks, chunkOf, settings, warnings, log);
  enforceStructure(plan.shots);
  progress({ stage: 'done', done: 1, total: 1, message: `Planned ${plan.shots.length} shots.` });
  return { ...plan, warnings };
}

/** Narration-grounded fallback direction when the repair call cannot fix a shot. */
function fallbackDirection(shot) {
  const bits = [shot.action, shot.pose, shot.expression, shot.background_mood].filter(Boolean).join(', ');
  const lead = shot.type === 'edit' ? 'cut to a new angle that visibly shows' : 'a scene that visibly shows';
  return `${lead} the moment "${shot.text}"${bits ? ` — ${bits}` : ''}`;
}

async function repairWeakShots(plan, chunks, chunkOf, settings, warnings, log) {
  const weak = plan.shots.map((s, i) => i).filter((i) => isWeakDirection(plan.shots[i], plan.characters, settings.style));
  if (!weak.length) return;
  log(`Repairing ${weak.length} weak visual direction(s)…`);

  const replacements = new Map(); // index -> shots[]
  const byChunk = new Map();
  for (const i of weak) {
    const c = chunkOf[i];
    if (!byChunk.has(c)) byChunk.set(c, []);
    byChunk.get(c).push(i);
  }
  for (const [c, indexes] of byChunk) {
    for (let b = 0; b < indexes.length; b += 20) {
      const batch = indexes.slice(b, b + 20);
      const targets = batch.map((i) => {
        const s = plan.shots[i];
        return { index: i, type: s.type, text: s.text, character_name: s.character_name, expression: s.expression, pose: s.pose, action: s.action, background_mood: s.background_mood };
      });
      const prompt = fill(P.repairUser, {
        SCRIPT: chunks[c].trim(), STYLE: settings.style || '', ASPECT_RATIO: settings.aspectRatio,
        TARGETS: JSON.stringify(targets, null, 2),
      });
      try {
        const json = await callJson(settings.model, { system: P.repairSystem, prompt }, settings, log, 'Repair');
        for (const r of json.repairs || []) {
          const idx = Number(r.index);
          if (!batch.includes(idx) || !Array.isArray(r.shots) || !r.shots.length) continue;
          const orig = plan.shots[idx];
          const reps = r.shots.map((x) => ({ ...normalizeShot(x), subject_focus: orig.subject_focus, character_visibility: orig.character_visibility, duration_hint_seconds: orig.duration_hint_seconds }));
          reps[0].type = orig.type;
          if (orig.type === 'keyframe') reps[0].wardrobe_override = orig.wardrobe_override;
          for (let k = 1; k < reps.length; k++) reps[k].type = 'edit';
          enforceStructure(reps, { allowLeadingEdit: orig.type === 'edit' });
          const { shots: checked } = reconcileCoverage(orig.text, reps);
          const sameText = checked.length === reps.length && checked.map((s) => s.text).join('').replace(/\s+/g, '') === orig.text.replace(/\s+/g, '');
          if (sameText && checked.every((s) => !isWeakDirection(s, plan.characters, settings.style))) {
            replacements.set(idx, checked);
          }
        }
      } catch (err) {
        warnings.push(`Repair call failed: ${err.message}`);
      }
    }
  }

  // Apply from the end so earlier indexes stay valid.
  for (const i of [...weak].sort((a, b) => b - a)) {
    if (replacements.has(i)) {
      plan.shots.splice(i, 1, ...replacements.get(i));
    } else {
      const s = plan.shots[i];
      const dir = fallbackDirection(s);
      if (s.type === 'edit') s.edit_instruction = dir; else s.scene_description = dir;
      warnings.push(`Shot ${i + 1}: used a narration-grounded fallback direction ("${directionOf(s).slice(0, 60)}…").`);
    }
  }
}
