// mouthshapes.js — shared character and SVG-editor viseme geometry.
//
// Standard viseme poses, their edit box, and coordinate fitting are pure.
// Editor document queries and undo-aware writes stay in the editor adapter.
// Path arithmetic lives in ./pathdata.js, shared with the drawing canvas.

import { pathBBox, scalePathD } from "./pathdata.js";

// ─────────────────── The mouth's edit box (pure) ──────────────────────────────

// The box the mouth is edited in: the union of every shape the mouth can take
// (each viseme plus its authored rest pose), padded so a wider shape still has
// room to grow, and snapped to whole units so the same face always reopens on
// the same grid.  One box for all of a face's visemes keeps them comparable —
// each shape is drawn at the same scale, the way the runtime morphs them.
//
// The box is also floored at half its own width, because a mouth that only
// authors a closed rest pose measures a few units tall, and nothing can be
// drawn outside the canvas: an author opening that mouth for "aa" needs the
// room BEFORE they drag, not after.
export function mouthViewBox(ds, { pad = 0.2, minPad = 2, minAspect = 0.5 } = {}) {
  const boxes = (ds || []).map(pathBBox).filter(Boolean);
  if (!boxes.length) return { x: 0, y: 0, w: 80, h: 40 };
  const minX = Math.min(...boxes.map(b => b.x));
  const minY = Math.min(...boxes.map(b => b.y));
  const maxX = Math.max(...boxes.map(b => b.x + b.w));
  const maxY = Math.max(...boxes.map(b => b.y + b.h));
  const padX = Math.max(minPad, (maxX - minX) * pad);
  const padY = Math.max(minPad, (maxY - minY) * pad);
  const x = Math.floor(minX - padX), y = Math.floor(minY - padY);
  const w = Math.max(1, Math.ceil(maxX + padX) - x);
  let h = Math.max(1, Math.ceil(maxY + padY) - y);
  const wanted = Math.ceil(w * minAspect);
  if (h >= wanted) return { x, y, w, h };
  // Grow about the shape's own centre so the mouth stays where it was.
  return { x, y: Math.floor(y + h / 2 - wanted / 2), w, h: wanted };
}

// Canvas size that shows `box` as large as fits without distorting it — the
// mouth is a wide, short shape, and stretching it to a 4:3 canvas would have
// the author drawing one curve and saving another.
export function fitCanvas(box, maxW, maxH, minW = 160) {
  const bw = Math.max(1, box.w), bh = Math.max(1, box.h);
  let scale = Math.min(maxW / bw, maxH / bh);
  if (bw * scale < minW) scale = minW / bw;
  return { w: Math.round(bw * scale), h: Math.round(bh * scale) };
}

// Wrap one mouth shape as a standalone SVG document positioned inside `box`,
// which is what the SVG editor loads.  The translate cancels the box origin so
// the shape lands on canvas even when the mouth is authored away from (0,0);
// `translatePathD(..., box.x, box.y)` puts it back on the way out.
export function wrapPathSvg(d, box, style = {}) {
  const fill   = style.fill   ?? "#8b3a3a";
  const stroke = style.stroke ?? "#c97b63";
  const sw     = style.sw     ?? 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box.w} ${box.h}" `
       + `width="${box.w}" height="${box.h}">`
       + `<g transform="translate(${-box.x}, ${-box.y})">`
       + `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`
       + `</g></svg>`;
}

// ─────────────────── The standard mouth poses ─────────────────────────────────

// One lip shape as a cubic-bezier path, in the mouth sprite's local 80×40
// space (centre (40, 20)).  Every pose uses the SAME command structure (M C C
// Z) so the runtime can morph between any two of them.
//   lx/rx — left/right x of the lip corner
//   top   — upward arc height of the upper lip
//   bot   — downward arc height of the lower lip
function lipPath(lx, rx, top, bot) {
  return `M ${lx},20 C ${lx},${20 - top} ${rx},${20 - top} ${rx},20 C ${rx},${20 + bot} ${lx},${20 + bot} ${lx},20 Z`;
}

// The 15 Preston-Blair phoneme groups and the pose each one names, in the
// order `EditorDoc::import_face` writes them (rest → U, frames 0-14).  This is
// the table a viseme entry is POINTING AT: `<mx:Viseme phoneme="aa" frame="10">`
// means "frame 10 of the mouth's clip is the aa pose".  Wider lx↔rx = wider
// mouth; larger arcs = more open.  All fifteen are distinct: two phonemes
// sharing a pose would give an author two chips they cannot tell apart.
export const STANDARD_VISEMES = [
  { phoneme: "rest", d: lipPath(18, 62,  3,  4) },  // relaxed thin oval
  { phoneme: "PP",   d: lipPath(14, 66,  1,  1) },  // bilabial, lips firmly pressed
  { phoneme: "FF",   d: lipPath(16, 64,  6,  5) },  // labiodental, slight opening
  { phoneme: "TH",   d: lipPath(16, 64,  6,  6) },  // dental, similar to FF
  { phoneme: "DD",   d: lipPath(14, 66,  9,  9) },  // alveolar, moderately open
  { phoneme: "kk",   d: lipPath(14, 66, 12, 12) },  // velar, wide open
  { phoneme: "CH",   d: lipPath(16, 64,  7,  7) },  // palatal, medium open
  { phoneme: "SS",   d: lipPath(18, 62,  3,  3) },  // sibilant, narrow slit
  { phoneme: "nn",   d: lipPath(16, 64,  4,  4) },  // nasal, near-closed
  { phoneme: "RR",   d: lipPath(22, 58,  8,  8) },  // rhotic, rounded-narrow
  { phoneme: "aa",   d: lipPath(12, 68, 14, 16) },  // open vowel, widest
  { phoneme: "E",    d: lipPath(12, 68,  8, 10) },  // mid vowel EH — spread wide, half open
  { phoneme: "I",    d: lipPath( 8, 72,  6,  8) },  // spread-smile EE
  { phoneme: "O",    d: lipPath(24, 56, 12, 14) },  // round vowel OH
  { phoneme: "U",    d: lipPath(26, 54, 10, 12) },  // high-back OO, small round
];

// The standard pose for a phoneme, moved into THIS mouth's coordinates.
//
// The poses are authored in one 80×40 space; a mouth drawn somewhere else (or
// at another size) needs them where its own artwork is, or the seed would land
// off-canvas.  The whole set is transformed as one rigid family — a single
// uniform scale taken from the mouth's WIDTH, about the rest pose's centre —
// so the poses stay comparable with each other and with the shape the author
// already has.  Width, because a mouth's width is the stable dimension: fitting
// height too would squash the open vowels flat against a closed rest pose.
export function visemeSeedD(phoneme, baseD) {
  const std = STANDARD_VISEMES.find(v => v.phoneme === phoneme)
           ?? STANDARD_VISEMES.find(v => v.phoneme.toLowerCase() === String(phoneme).toLowerCase());
  if (!std) return null;
  const restBox = pathBBox(STANDARD_VISEMES[0].d);
  const baseBox = pathBBox(baseD);
  if (!restBox || !baseBox || !baseBox.w) return std.d;
  const s = baseBox.w / restBox.w;
  // Scale about the rest pose's centre and land on the mouth's own centre.
  const cx0 = restBox.x + restBox.w / 2, cy0 = restBox.y + restBox.h / 2;
  const cx1 = baseBox.x + baseBox.w / 2, cy1 = baseBox.y + baseBox.h / 2;
  return scalePathD(std.d, s, s, cx1 - cx0 * s, cy1 - cy0 * s);
}
