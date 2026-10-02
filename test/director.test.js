import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileCoverage, coverageMatches, enforceStructure, normalizeShot, isWeakDirection, extractJson } from '../server/director/validate.js';
import { splitScript, buildPlanningPrompt } from '../server/director/planner.js';
import { buildImagePrompt, EDIT_CONTINUITY_RULE, OFF_SCREEN_RULE, COMIC_SANS_RULE, STYLE_REFERENCE_RULE, EXACT_TEXT_RULE, STORY_FACTS_RULE } from '../server/director/imagePrompts.js';
import { buildChatGptJob, planRuns } from '../server/export/chatgpt.js';
import { shotNumberFromName } from '../server/images.js';

const script = 'Every morning, Daniel wrote down five things he wanted to change about his life: wake up earlier. Read more. A month later, nothing had changed.';

test('splitScript keeps every character and respects the word target', () => {
  const long = Array.from({ length: 120 }, (_, i) => `Sentence number ${i} has six words.`).join(' ');
  const chunks = splitScript(long, 100);
  assert.equal(chunks.join(''), long);
  assert.ok(chunks.length >= 7);
  for (const c of chunks.slice(0, -1)) assert.ok(c.split(/\s+/).filter(Boolean).length <= 100);
});

test('reconcileCoverage repairs gaps, paraphrase and junk so texts partition the script', () => {
  const shots = [
    { text: 'Every morning,' },
    { text: 'five things he wanted to change about his life:' }, // gap: "Daniel wrote down"
    { text: 'this sentence is not in the script' },
    { text: 'wake up earlier.' },
    { text: 'Read more.' },
    { text: 'A month later,' },
  ].map((s) => normalizeShot(s));
  const { shots: out, fixes } = reconcileCoverage(script, shots);
  assert.ok(coverageMatches(script, out));
  assert.equal(out.length, 5);
  assert.equal(out[0].text, 'Every morning, Daniel wrote down');
  assert.equal(out[4].text, 'A month later, nothing had changed.');
  assert.ok(fixes.some((f) => f.includes('not in the script')));
});

test('enforceStructure: first is keyframe, edits chain to the previous shot', () => {
  const shots = [
    normalizeShot({ type: 'edit', text: 'a', edit_instruction: 'x' }),
    normalizeShot({ type: 'edit', text: 'b', scene_description: 'moved' }),
    normalizeShot({ type: 'keyframe', text: 'c', edit_instruction: 'y', wardrobe_override: 'red coat' }),
  ];
  enforceStructure(shots);
  assert.equal(shots[0].type, 'keyframe');
  assert.equal(shots[0].scene_description, 'x');
  assert.equal(shots[1].base_shot_index, 0);
  assert.equal(shots[1].edit_instruction, 'moved');
  assert.equal(shots[1].scene_description, null);
  assert.equal(shots[2].scene_description, 'y');
  assert.equal(shots[2].edit_instruction, null);
});

test('weak direction detection ignores style, camera and persona words', () => {
  const characters = [{ name: 'Daniel', visual_persona: { art_style: 'stick figure', physical_description: 'tall slight hunch', facial_features: 'narrow eyes', color_palette: 'dark grey' } }];
  const weak = normalizeShot({ type: 'keyframe', character_name: 'Daniel', scene_description: 'STICK FIGURE, tall slight hunch, narrow eyes — medium shot, cinematic lighting' });
  const strong = normalizeShot({ type: 'keyframe', character_name: 'Daniel', scene_description: 'STICK FIGURE, tall — writing in a notebook at a kitchen table, coffee steaming' });
  assert.equal(isWeakDirection(weak, characters, 'stick figure'), true);
  assert.equal(isWeakDirection(strong, characters, 'stick figure'), false);
  assert.equal(isWeakDirection(normalizeShot({ type: 'edit' }), characters), true);
});

test('extractJson tolerates fences, prose and trailing commas', () => {
  assert.deepEqual(extractJson('Here:\n```json\n{"a": [1, 2,],}\n```'), { a: [1, 2] });
});

test('planning prompt contains the verbatim engine rules and optional blocks', () => {
  const p = buildPlanningPrompt({ script: 'Hello.', aspectRatio: '16:9', style: 'stick figure', hasReference: true, section: { number: 2, total: 3 }, knownNames: ['Daniel'], preceding: 'Last words: "…x"' });
  assert.ok(p.startsWith('Plan a cinematic shot list for this script.'));
  assert.ok(p.includes('SCRIPT:\nHello.\n\nOUTPUT ASPECT RATIO: 16:9.'));
  assert.ok(p.includes('=== REFERENCE IMAGE — SOLE STYLE AUTHORITY ==='));
  assert.ok(p.includes('=== SCRIPT SECTION 2 OF 3 ==='));
  assert.ok(p.includes('These characters are already established: Daniel.'));
  assert.ok(p.includes('=== END OF THE PRECEDING SECTION'));
  assert.ok(p.includes('=== STEP 1: CHARACTER BIBLE'));
  assert.ok(p.trim().endsWith('}'));
  const plain = buildPlanningPrompt({ script: 'Hello.', aspectRatio: '9:16', style: 'anime' });
  assert.ok(!plain.includes('SOLE STYLE AUTHORITY'));
  assert.ok(!plain.includes('SCRIPT SECTION'));
});

const plan = {
  characters: [{ name: 'Daniel', visual_persona: { art_style: 'stick figure', physical_description: 'tall slight hunch', facial_features: 'narrow eyes', color_palette: 'dark grey lines, red accent' } }],
  shots: [
    { type: 'keyframe', text: 'Every morning,', character_name: 'Daniel', character_visibility: 'on_screen', scene_description: 'Daniel at his desk, sunrise', wardrobe_override: null },
    { type: 'edit', text: 'Daniel wrote down', character_name: 'Daniel', character_visibility: 'on_screen', edit_instruction: 'close insert on the pen writing' },
    { type: 'keyframe', text: 'A month later,', character_name: 'Daniel', character_visibility: 'off_screen', scene_description: 'near-black title card "A month later"' },
    { type: 'keyframe', text: 'nothing had changed.', character_name: 'Daniel', character_visibility: 'on_screen', scene_description: 'same desk, dust', wardrobe_override: 'olive hoodie' },
  ],
};

test('image prompts follow the engine assembly rules', () => {
  const k = buildImagePrompt(plan, 0, { styleReference: true });
  assert.ok(k.startsWith('stick figure, tall slight hunch, narrow eyes, dark grey lines, red accent — Daniel at his desk'));
  assert.ok(k.includes(COMIC_SANS_RULE) && k.includes(STYLE_REFERENCE_RULE));
  const e = buildImagePrompt(plan, 1, { styleReference: true });
  assert.ok(e.startsWith('stick figure, tall slight hunch, narrow eyes, wearing dark grey lines, red accent — close insert'));
  assert.ok(e.includes(EDIT_CONTINUITY_RULE));
  assert.ok(!e.includes(STYLE_REFERENCE_RULE));
  const off = buildImagePrompt(plan, 2, {});
  assert.ok(!off.includes('stick figure'));
  assert.ok(off.includes(OFF_SCREEN_RULE));
  const w = buildImagePrompt(plan, 3, {});
  assert.ok(w.includes('for THIS scene only, wearing olive hoodie instead of the usual outfit'));
  assert.ok(!w.includes('dark grey lines'));
});

test('image prompts lock outfits in edits, describe other named characters, and add text/story rules', () => {
  const p2 = {
    characters: [
      { name: 'Moussa', visual_persona: { art_style: 'painterly', physical_description: 'slim boy', facial_features: 'tight curls', color_palette: 'coral T-shirt' } },
      { name: 'Marcus', visual_persona: { art_style: 'painterly', physical_description: 'tall sturdy man', facial_features: 'trimmed goatee', color_palette: 'black beanie, reflective jacket' } },
    ],
    shots: [
      { type: 'keyframe', text: 'He goes out.', character_name: 'Moussa', character_visibility: 'on_screen', scene_description: 'Moussa at night', wardrobe_override: 'grey hoodie' },
      { type: 'edit', text: 'Marcus checks the hood.', character_name: 'Moussa', character_visibility: 'on_screen', edit_instruction: 'Marcus leans under the hood while Moussa watches' },
      { type: 'keyframe', text: 'Mot Flow.', character_name: 'Moussa', character_visibility: 'off_screen', scene_description: 'title card, centered text reading "Mot Flow"' },
    ],
  };
  const e = buildImagePrompt(p2, 1, {});
  assert.ok(e.includes('wearing grey hoodie'), 'edit keeps the scene outfit');
  assert.ok(!e.includes('coral T-shirt'));
  assert.ok(e.includes('Marcus looks exactly as established: tall sturdy man, trimmed goatee, wearing black beanie, reflective jacket'));
  assert.ok(e.includes(STORY_FACTS_RULE) && !e.includes(EXACT_TEXT_RULE));
  assert.ok(buildImagePrompt(p2, 2, {}).includes(EXACT_TEXT_RULE));
});

test('ChatGPT job: numbering, references, runs', () => {
  const project = { title: 'Test', styleImage: 'style-reference.png', settings: { aspectRatio: '16:9', style: 'stick', imagesPerRun: 2, driveFolder: '' }, plan };
  const job = buildChatGptJob(project);
  assert.equal(job.total_images, 4);
  assert.equal(job.images[0].file_name, 'shot_0001.png');
  assert.equal(job.images[1].kind, 'continues_previous');
  assert.equal(job.images[1].reference_image, 'shot_0001.png');
  assert.equal(job.images[2].reference_image, null);
  assert.ok(job.instructions_for_chatgpt.includes('total images (4)'));
  const run2 = buildChatGptJob(project, { run: 2 });
  assert.deepEqual(run2.images.map((i) => i.number), [3, 4]);
});

test('planRuns prefers to end a run before a new scene', () => {
  const shots = ['keyframe', 'edit', 'edit', 'keyframe', 'edit', 'edit', 'edit', 'keyframe', 'edit'].map((type) => ({ type }));
  const runs = planRuns(shots, 4);
  assert.deepEqual(runs.map((r) => [r.first, r.last]), [[1, 3], [4, 7], [8, 9]]);
});

test('shot numbers from filenames', () => {
  assert.equal(shotNumberFromName('shot_0012.png'), 12);
  assert.equal(shotNumberFromName('shot-7-final.jpg'), 7);
  assert.equal(shotNumberFromName('0034 (1).png'), 34);
  assert.equal(shotNumberFromName('image 5.webp'), 5);
  assert.equal(shotNumberFromName('ChatGPT Image Sep 26, 2026, 08_15_32 AM.png'), null);
});
