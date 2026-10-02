// Turns a planned shot into the exact image prompt the original app sent to the image model
// ("What is actually sent as each image prompt").

export const COMIC_SANS_RULE =
  'If this frame includes readable on-screen writeup or title text, render it in Comic Sans MS.';

export const OFF_SCREEN_RULE =
  'Keep the continuity character entirely off-screen. Frame the stated primary subject, not a person, unless this narration explicitly introduces someone else.';

export const BACKGROUND_RULE =
  'Keep any character incidental in the background; the stated primary subject owns the frame.';

export const EDIT_CONTINUITY_RULE =
  'Use the preceding frame as the continuity source: retain the same environment, props, lighting logic, and story state unless this narration changes them. Do not force a character into this view unless character_visibility is on_screen or background; preserve their identity when they are shown. The camera may hard-cut to a distinct, independently composed view of the same world. If continuing a writeup/title, preserve its alignment, safe-area position, scale, and baseline exactly.';

export const STYLE_REFERENCE_RULE =
  'STYLE REFERENCE RULE: Use the first supplied reference image only for its visual language—linework, palette, rendering, and overall artistic treatment. Do not copy, recreate, or reuse any source-specific subject, pose, scene, framing, layout, video frame, caption, subtitle, timestamp, watermark, logo, interface, or readable text from that reference. Create the requested story scene from this prompt instead.';

export const EXACT_TEXT_RULE =
  'EXACT TEXT: spell every quoted on-screen word exactly as written in this prompt, letter for letter, including brand names, spacing, capitals and accents. Add no other words, taglines, slogans, logos, icons or labels.';

export const STORY_FACTS_RULE =
  'STORY FACTS: anything readable or identifiable in the frame (phone and caller screens, signs, plaques, documents, banknotes, vehicles) must agree with this prompt and the story: show only the names, callers, places, currency, language and vehicles it states, never an invented substitute.';

export const RETRY_WIDER =
  'Framing requirement for this next shot: pull the camera back to a clearly wider composition (zoom out). Show noticeably more of the surrounding setting while keeping the same subjects and the story change requested above.';

export const RETRY_DIFFERENT =
  'This is a second correction attempt: the previous regeneration still looked almost identical to the reference frame. Do not repeat the same camera framing again. Cut to a genuinely different shot: if the reference frame is a wide or medium shot, move to a close insert on the specific detail that is changing (for example the notebook page, the object in hand, or the character\'s face); if the reference frame is already a close-up, pull back to a clearly wider shot. Keep the same subjects and the story change requested above.';

const join = (parts, sep = ', ') => parts.map((p) => (p || '').trim()).filter(Boolean).join(sep);

export function findCharacter(plan, name) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return plan.characters.find((c) => c.name.trim().toLowerCase() === n) || null;
}

/** The wardrobe in force for a shot: its own override (keyframe) or the one from its scene's keyframe. */
export function activeWardrobe(plan, index) {
  for (let i = index; i >= 0; i--) {
    const s = plan.shots[i];
    if (s.type === 'keyframe') return s.wardrobe_override || null;
  }
  return null;
}

/** The outfit a visible character wears in this shot: the scene's override, else their default. */
export function outfitFor(plan, index, ch) {
  const isMain = ch && plan.shots[index].character_name && findCharacter(plan, plan.shots[index].character_name) === ch;
  return (isMain && activeWardrobe(plan, index)) || ch?.visual_persona?.color_palette || null;
}

/** Other bible characters named in this shot's own scene/edit description (not just the narration). */
export function otherCharactersIn(plan, index) {
  const shot = plan.shots[index];
  const body = `${shot.scene_description || ''} ${shot.edit_instruction || ''}`.toLowerCase();
  const main = (shot.character_name || '').trim().toLowerCase();
  return plan.characters.filter((c) => {
    const n = c.name.trim().toLowerCase();
    if (!n || n === main || !c.visual_persona) return false;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}])${esc}([^\\p{L}]|$)`, 'u').test(body);
  });
}

const castLine = (plan, index, c) => {
  const vp = c.visual_persona;
  const outfit = outfitFor(plan, index, c);
  return `${c.name} looks exactly as established: ${join([vp.physical_description, vp.facial_features])}${outfit ? `, wearing ${outfit}` : ''}${vp.distinctive_elements ? `, with ${vp.distinctive_elements}` : ''}`;
};

/**
 * Build the final image prompt for shot `index`.
 * options.styleReference: true when a style reference image will be attached (appends the STYLE REFERENCE RULE on keyframes).
 * options.style: visual style text (appended as a style line only when there is no reference image and options.appendStyle is true).
 */
export function buildImagePrompt(plan, index, options = {}) {
  const shot = plan.shots[index];
  if (shot.prompt_override) return shot.prompt_override;
  const ch = findCharacter(plan, shot.character_name);
  const visible = shot.character_visibility !== 'off_screen';
  const vp = ch?.visual_persona;
  const parts = [];

  if (shot.type === 'keyframe') {
    if (ch && visible && vp) {
      const identity = join([vp.art_style, vp.physical_description, vp.facial_features]);
      parts.push(
        shot.wardrobe_override
          ? `${identity} — for THIS scene only, wearing ${shot.wardrobe_override} instead of the usual outfit`
          : join([identity, vp.color_palette]),
      );
    }
    parts.push(shot.scene_description || shot.text);
  } else {
    if (ch && visible && vp) {
      // Edits used to carry only the face, and ChatGPT drifted the clothes (and even the person)
      // across a scene. Repeat the build and the outfit in force so they stay locked.
      const outfit = outfitFor(plan, index, ch);
      parts.push(join([vp.art_style, vp.physical_description, vp.facial_features, outfit ? `wearing ${outfit}` : '', vp.distinctive_elements]));
    }
    parts.push(shot.edit_instruction || shot.text);
  }

  for (const other of otherCharactersIn(plan, index)) parts.push(castLine(plan, index, other));

  if (shot.character_visibility === 'off_screen' && shot.character_name) parts.push(OFF_SCREEN_RULE);
  if (shot.character_visibility === 'background') parts.push(BACKGROUND_RULE);
  if (shot.type === 'edit') parts.push(EDIT_CONTINUITY_RULE);
  if (options.appendStyle && options.style && !options.styleReference) parts.push(`Visual style: ${options.style}`);
  parts.push(COMIC_SANS_RULE);
  const body = `${shot.scene_description || ''} ${shot.edit_instruction || ''}`;
  if (/["“”«»]|reading|reads|labell?ed|text/i.test(body)) parts.push(EXACT_TEXT_RULE);
  parts.push(STORY_FACTS_RULE);
  if (options.styleReference && shot.type === 'keyframe' && options.includeStyleRule !== false) parts.push(STYLE_REFERENCE_RULE);

  return join(parts, ' — ');
}
