// Shot-plan normalisation, verbatim-coverage reconciliation and weak-direction detection.

export const SUBJECT_FOCUS = ['character', 'environment', 'object/detail', 'group', 'business/process', 'on-screen idea', 'consequence'];
export const VISIBILITY = ['on_screen', 'background', 'off_screen'];

/** Pull the first JSON object out of a model response (tolerates fences, prose, trailing commas). */
export function extractJson(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty model response');
  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object found in model response');
  s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch {
    // Common LLM slip: trailing commas.
    return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
  }
}

const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

function pickEnum(value, allowed, fallback) {
  if (!value) return fallback;
  const v = String(value).trim().toLowerCase();
  return allowed.find((a) => a === v) || allowed.find((a) => v.includes(a)) || fallback;
}

export function normalizeCharacter(c) {
  const vp = c?.visual_persona || {};
  return {
    name: str(c?.name) || 'Narrator',
    description: str(c?.description) || '',
    appearance: str(c?.appearance) || '',
    visual_persona: {
      art_style: str(vp.art_style) || '',
      physical_description: str(vp.physical_description) || '',
      facial_features: str(vp.facial_features) || '',
      color_palette: str(vp.color_palette) || '',
      distinctive_elements: str(vp.distinctive_elements) || '',
      expression_type: str(vp.expression_type) || '',
    },
    real_person: str(c?.real_person),
  };
}

export function normalizeShot(raw) {
  const type = String(raw?.type || '').toLowerCase() === 'edit' ? 'edit' : 'keyframe';
  const dur = Number(raw?.duration_hint_seconds);
  return {
    text: typeof raw?.text === 'string' ? raw.text : '',
    type,
    character_name: str(raw?.character_name),
    scene_description: str(raw?.scene_description),
    edit_instruction: str(raw?.edit_instruction),
    base_shot_index: raw?.base_shot_index ?? null,
    subject_focus: pickEnum(raw?.subject_focus, SUBJECT_FOCUS, 'character'),
    character_visibility: pickEnum(raw?.character_visibility, VISIBILITY, 'on_screen'),
    wardrobe_override: type === 'keyframe' ? str(raw?.wardrobe_override) : null,
    setting_period: str(raw?.setting_period),
    expression: str(raw?.expression) || '',
    pose: str(raw?.pose) || '',
    action: str(raw?.action) || '',
    background_mood: str(raw?.background_mood) || '',
    duration_hint_seconds: Number.isFinite(dur) && dur > 0 ? dur : 1,
  };
}

/**
 * Enforce the plan's structural rules in place:
 * first shot is a keyframe, edits reference the immediately preceding shot,
 * keyframes carry scene_description only and edits carry edit_instruction only.
 * `offset` is the global index of shots[0]; `allowLeadingEdit` lets a later chunk continue the previous chunk.
 */
export function enforceStructure(shots, { offset = 0, allowLeadingEdit = false } = {}) {
  shots.forEach((s, i) => {
    if (i === 0 && s.type === 'edit' && !allowLeadingEdit) s.type = 'keyframe';
    if (s.type === 'keyframe') {
      if (!s.scene_description && s.edit_instruction) s.scene_description = s.edit_instruction;
      s.edit_instruction = null;
      s.base_shot_index = null;
    } else {
      if (!s.edit_instruction && s.scene_description) s.edit_instruction = s.scene_description;
      s.scene_description = null;
      s.wardrobe_override = null;
      s.base_shot_index = offset + i - 1;
    }
  });
  return shots;
}

// ---- verbatim coverage -------------------------------------------------------

/** Letters/digits only, lowercased, with a map back to the original string offsets. */
function compact(text) {
  const chars = [];
  const map = [];
  const norm = text.normalize('NFKC');
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i].toLowerCase();
    if (/[\p{L}\p{N}]/u.test(ch)) {
      chars.push(ch);
      map.push(i);
    }
  }
  return { s: chars.join(''), map, norm };
}

/**
 * Make shot texts an exact, gap-free, overlap-free partition of `script`.
 * Shots whose text can't be located are dropped (their narration is absorbed by neighbours).
 * Returns { shots, fixes } where fixes is a list of human-readable notes.
 */
export function reconcileCoverage(script, shots) {
  const fixes = [];
  const sc = compact(script);
  const anchors = []; // { shot, start (compact idx) }
  let cursor = 0;
  for (const shot of shots) {
    const t = compact(shot.text || '').s;
    if (!t) {
      fixes.push('Dropped a shot with empty text.');
      continue;
    }
    let pos = sc.s.indexOf(t, cursor);
    const maxJump = Math.max(400, t.length * 3);
    if (pos < 0 || pos - cursor > maxJump) {
      // Try a prefix match (model sometimes paraphrases the end of an excerpt).
      const prefix = t.slice(0, Math.min(t.length, 24));
      const p2 = prefix.length >= 8 ? sc.s.indexOf(prefix, cursor) : -1;
      if (p2 >= 0 && p2 - cursor <= maxJump) {
        pos = p2;
        fixes.push(`Shot text was not verbatim; re-anchored "${shot.text.slice(0, 40)}…" to the script.`);
      } else {
        fixes.push(`Dropped a shot whose text is not in the script: "${shot.text.slice(0, 60)}".`);
        continue;
      }
    }
    if (pos > cursor && anchors.length) fixes.push(`Filled a narration gap before "${shot.text.slice(0, 40)}…".`);
    anchors.push({ shot, start: pos });
    cursor = Math.max(cursor, pos + Math.max(1, Math.min(t.length, sc.s.length - pos)));
  }
  if (!anchors.length) return { shots: [], fixes: fixes.concat('No shot could be matched to the script.') };

  // Collapse anchors that start at the same compact position (duplicates).
  const uniq = anchors.filter((a, i) => i === 0 || a.start > anchors[i - 1].start);
  if (uniq.length < anchors.length) fixes.push(`Removed ${anchors.length - uniq.length} overlapping duplicate shot(s).`);

  const result = uniq.map((a, i) => {
    const from = i === 0 ? 0 : sc.map[a.start];
    const to = i + 1 < uniq.length ? sc.map[uniq[i + 1].start] : sc.norm.length;
    return { ...a.shot, text: sc.norm.slice(from, to).trim() };
  });
  return { shots: result.filter((s) => s.text), fixes };
}

export function coverageMatches(script, shots) {
  const a = compact(script).s;
  const b = compact(shots.map((s) => s.text).join(' ')).s;
  return a === b;
}

// ---- weak direction detection ------------------------------------------------

const NON_CONTENT = new Set(`
a an the of and or with to on at for from in into as is are be it its this that these those by over under
cinematic photorealism photorealistic realistic realism stick figure figures anime watercolor watercolour style styled rendering render rendered
illustration illustrated art artistic digital painting painted 3d 2d cartoon cartoonish linework palette colour color colors colours
tones tone vibrant muted high quality detailed ultra hd 4k 8k sharp soft lighting light lit cinematic mood moody atmosphere
shot shots wide medium close closeup up extreme push pull zoom pan out angle low high overhead aerial framing frame framed composition
camera cut hard insert reverse shoulder establishing lens tracking dolly tilt view pov centre center centered full bleed
keep same preserve preserved continuity hold held locked consistent maintain maintained previous preceding retain retained continue continuing
comic sans ms text font typography title
`.split(/\s+/).filter(Boolean));

function words(text) {
  return (text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
}

export function directionOf(shot) {
  return shot.type === 'edit' ? shot.edit_instruction : shot.scene_description;
}

/** True when a direction is blank or only style/camera/continuity/persona language. */
export function isWeakDirection(shot, characters = [], style = '') {
  const dir = directionOf(shot);
  if (!dir || !dir.trim()) return true;
  const ignore = new Set(NON_CONTENT);
  for (const w of words(style)) ignore.add(w);
  const ch = characters.find((c) => c.name?.toLowerCase() === shot.character_name?.toLowerCase());
  if (ch) {
    const vp = ch.visual_persona || {};
    for (const w of words([vp.art_style, vp.physical_description, vp.facial_features, vp.color_palette, ch.name].join(' '))) ignore.add(w);
  }
  const content = words(dir).filter((w) => w.length > 2 && !ignore.has(w));
  return new Set(content).size < 3;
}
