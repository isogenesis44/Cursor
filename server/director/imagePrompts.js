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
      parts.push(join([vp.art_style, vp.facial_features]));
    }
    parts.push(shot.edit_instruction || shot.text);
  }

  if (shot.character_visibility === 'off_screen' && shot.character_name) parts.push(OFF_SCREEN_RULE);
  if (shot.character_visibility === 'background') parts.push(BACKGROUND_RULE);
  if (shot.type === 'edit') parts.push(EDIT_CONTINUITY_RULE);
  if (options.appendStyle && options.style && !options.styleReference) parts.push(`Visual style: ${options.style}`);
  parts.push(COMIC_SANS_RULE);
  if (options.styleReference && shot.type === 'keyframe' && options.includeStyleRule !== false) parts.push(STYLE_REFERENCE_RULE);

  return join(parts, ' — ');
}
