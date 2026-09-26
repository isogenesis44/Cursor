import path from 'node:path';

/**
 * Work out which shot an uploaded image belongs to from its filename.
 * "shot_0012.png", "shot-12-final.jpg", "12.png", "image 12.png", "0012 (1).png" -> 12
 * Names like "ChatGPT Image Sep 26, 2026, 08_15_32 AM.png" -> null (a timestamp is not a shot number).
 */
export function shotNumberFromName(name) {
  const base = path.basename(name).replace(/\.[^.]+$/, '').replace(/\s*\(\d+\)$/, '').trim();
  const m = base.match(/shot[\s_-]*0*(\d{1,5})/i) || base.match(/^(?:image|img|frame|scene|pic|picture)?[\s_-]*0*(\d{1,5})$/i);
  return m ? Number(m[1]) : null;
}
