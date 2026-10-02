// Builds the "image job" JSON you paste/attach into ChatGPT (Pro) and schedule as a recurring task.
import { buildImagePrompt, STYLE_REFERENCE_RULE, COMIC_SANS_RULE } from '../director/imagePrompts.js';

export const ASPECTS = {
  '16:9': { label: 'landscape 16:9', chatgptSize: '1536x1024 (landscape)', video: [1920, 1080] },
  '9:16': { label: 'portrait 9:16', chatgptSize: '1024x1536 (portrait)', video: [1080, 1920] },
  '1:1': { label: 'square 1:1', chatgptSize: '1024x1024 (square)', video: [1080, 1080] },
  '4:5': { label: 'portrait 4:5', chatgptSize: '1024x1536 (portrait, crop to 4:5)', video: [1080, 1350] },
  '4:3': { label: 'landscape 4:3', chatgptSize: '1536x1024 (landscape, crop to 4:3)', video: [1440, 1080] },
};

export const fileNameFor = (n) => `shot_${String(n).padStart(4, '0')}.png`;

/**
 * Split shots into runs of ~perRun images. A run prefers to end right before a keyframe
 * (new scene) so an edit shot rarely has to pick up yesterday's reference image.
 */
export function planRuns(shots, perRun) {
  const runs = [];
  let start = 0;
  while (start < shots.length) {
    let end = Math.min(start + perRun, shots.length); // exclusive
    if (end < shots.length) {
      const floor = start + Math.max(1, Math.floor(perRun * 0.75));
      for (let e = end; e >= floor; e--) {
        if (shots[e].type === 'keyframe') { end = e; break; }
      }
    }
    runs.push({ run: runs.length + 1, first: start + 1, last: end, count: end - start });
    start = end;
  }
  return runs;
}

export function kickoffMessage(project, runs) {
  const s = project.settings;
  const total = project.plan.shots.length;
  const folder = s.driveFolder || `AI Director/${project.title}`;
  const hasRef = Boolean(project.styleImage);
  return [
    `You are my image production assistant. The attached JSON file is an image job for the video "${project.title}".${hasRef ? ' I have also attached my STYLE REFERENCE image.' : ''}`,
    '',
    `STEP 0 — Read the whole JSON first, then reply with: total images (${total}), images per run (${s.imagesPerRun}), number of runs (${runs.length}), and the first/last file_name of each run. Do not generate anything in that first reply.`,
    '',
    'EVERY RUN (this is a scheduled task — do this each time it fires):',
    `1. Open the Google Drive folder "${folder}" and list which file_name values from the JSON already exist there.`,
    `2. Generate the next ${s.imagesPerRun} MISSING images, strictly in ascending "number" order. Never skip a number.`,
    '3. For each image, use its "prompt" exactly as written — do not shorten, summarise, or rewrite it.',
    `4. Every image is ${ASPECTS[s.aspectRatio]?.label || s.aspectRatio} (${ASPECTS[s.aspectRatio]?.chatgptSize || ''}). No borders, captions, subtitles, watermarks, or text that the prompt does not ask for.`,
    '5. If "kind" is "continues_previous": use the image named in "reference_image" (from this chat or from the Drive folder) as the continuity reference — same characters, faces, wardrobe, environment, props, and lighting — and change ONLY what the prompt asks, with the new camera framing it describes.',
    '6. If "kind" is "new_scene": compose a fresh frame (do not copy the previous composition), but keep every character\'s identity anchor (art style, build, face) identical.',
    hasRef
      ? `7. STYLE LOCK: the attached style reference image is the SOLE style authority and overrides every other style word. ${STYLE_REFERENCE_RULE}`
      : `7. STYLE LOCK: every image uses this style, which overrides anything else: ${s.style || '(see style_lock in the JSON)'}.`,
    `8. ${COMIC_SANS_RULE}`,
    '9. CHECK BEFORE SAVING — compare the finished image with its prompt and regenerate it once if any of these fail: (a) every quoted word is spelled exactly as in the prompt, with nothing extra (no taglines, logos or invented labels); (b) each named character has the face, build and outfit the prompt gives them, and a different person is never drawn with the main character\'s face; (c) screens, callers, signs, plaques, money and vehicles match the prompt and the story (right caller name, local currency, the stated car); (d) it is a new image, not a copy of an earlier file_name.',
    `10. Save each image to "${folder}" as a PNG named EXACTLY its "file_name" (e.g. shot_0001.png). Save loose PNGs, not zip files, and never save one image under another number.`,
    '11. If an image fails, retry it once; if it still fails, note it and continue with the next number.',
    '12. End each run with a short report: files saved this run, any failures, and the next file_name to make. When all images exist, say "ALL IMAGES COMPLETE".',
  ].join('\n');
}

export function buildChatGptJob(project, { run = null } = {}) {
  const { plan, settings: s } = project;
  const shots = plan.shots;
  const runs = planRuns(shots, s.imagesPerRun);
  const selected = run ? runs.find((r) => r.run === run) : null;
  if (run && !selected) throw Object.assign(new Error(`Run ${run} does not exist (there are ${runs.length}).`), { status: 400 });
  const from = selected ? selected.first - 1 : 0;
  const to = selected ? selected.last : shots.length;
  const hasRef = Boolean(project.styleImage);

  const images = [];
  for (let i = from; i < to; i++) {
    const shot = shots[i];
    images.push({
      number: i + 1,
      file_name: fileNameFor(i + 1),
      kind: shot.type === 'edit' ? 'continues_previous' : 'new_scene',
      reference_image: shot.type === 'edit' && i > 0 ? fileNameFor(i) : null,
      narration: shot.text,
      prompt: buildImagePrompt(plan, i, { styleReference: hasRef, style: s.style, appendStyle: true }),
    });
  }

  return {
    format: 'ai-director-chatgpt-image-job/v1',
    project: project.title,
    total_images: shots.length,
    images_in_this_file: images.length,
    ...(selected ? { this_file_is_run: selected } : {}),
    aspect_ratio: s.aspectRatio,
    image_size: ASPECTS[s.aspectRatio]?.chatgptSize || s.aspectRatio,
    google_drive_folder: s.driveFolder || `AI Director/${project.title}`,
    style_lock: hasRef
      ? { source: 'attached style reference image', rule: STYLE_REFERENCE_RULE, informational_style_text: s.style || null }
      : { source: 'text', style: s.style || null },
    schedule: { images_per_run: s.imagesPerRun, total_runs: runs.length, runs },
    instructions_for_chatgpt: kickoffMessage(project, runs),
    characters: plan.characters.map((c) => ({
      name: c.name,
      identity_anchor: [c.visual_persona.art_style, c.visual_persona.physical_description, c.visual_persona.facial_features].filter(Boolean).join(', '),
      default_palette: c.visual_persona.color_palette,
      always_carries: c.visual_persona.distinctive_elements,
    })),
    images,
  };
}
