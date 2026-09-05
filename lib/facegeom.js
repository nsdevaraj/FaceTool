// Face tool geometry & markup — the parts of ./facetool.js that are pure
// arithmetic and string-building, kept apart from the dialog wiring (which
// needs `document`) so they can be unit-tested in Node.
//
// Nothing here touches the DOM: `buildFaceHeadSvg` and `buildMouthXml` are
// string templates over numbers, and `buildMouthKeyframes` is an amplitude
// analysis over a plain `{ getChannelData, sampleRate }` shape — real
// AudioBuffers satisfy it, and so does a small fake in a test.

import { esc } from "./xml.js";
import { STANDARD_VISEMES } from "./mouthshapes.js";

// Mouth sprite local dimensions (stage units). Also used by facetool.js's
// SVG-based mouth placement fallback, so it is exported rather than
// duplicated.
export const MOUTH_W = 80;

// The 15 phoneme poses live in ./mouthshapes.js, next to the viseme table they
// belong to — the face editor seeds an unkeyed viseme from the same list this
// tool keys, so an inserted mouth and an edited one cannot drift apart.
export const MOUTH_PATHS = STANDARD_VISEMES.map(v => v.d);

// Round a number to at most `dp` decimal places for clean SVG output.
const r = (n, dp = 1) => +n.toFixed(dp);

// Default face style options — used when inserting without customisation.
export const DEFAULT_FACE_OPTS = {
  skinColor:   "#fce4d6",  // head fill
  eyeColor:    "#333333",  // iris fill
  browColor:   "#5c3a2e",  // eyebrow stroke
  browExpr:    0,          // eyebrow expression: -1 = furrowed, 0 = neutral, +1 = raised
  eyeScale:    1.0,        // eye size multiplier (0.6 – 1.6)
};

// Lighten or darken a #rrggbb hex color. factor > 0 darkens, < 0 lightens.
export function darkenHex(hex, factor) {
  const n = parseInt(hex.replace("#",""), 16);
  const r8 = (n >> 16) & 0xff;
  const g8 = (n >>  8) & 0xff;
  const b8 = (n      ) & 0xff;
  const d = (c) => Math.max(0, Math.min(255, Math.round(c * (1 - factor))));
  return `#${[d(r8),d(g8),d(b8)].map(v=>v.toString(16).padStart(2,"0")).join("")}`;
}

// Build an SVG document for the static face head (head oval, eyes with
// highlight, eyebrows, nose). Sized to the full stage so import_svg places
// it correctly. The mouth is deliberately omitted — the animated sprite sits
// on top. Accepts an optional `opts` overriding DEFAULT_FACE_OPTS fields.
export function buildFaceHeadSvg(w, h, opts = {}) {
  const o = { ...DEFAULT_FACE_OPTS, ...opts };

  // Derive a slightly-darker border and nose fill from the skin tone.
  const skinStroke = darkenHex(o.skinColor, 0.25);
  const noseFill   = darkenHex(o.skinColor, 0.10);

  const cx  = r(w / 2);
  const cy  = r(h * 0.44);
  const rx  = r(w * 0.19);
  const ry  = r(h * 0.30);
  // Eye centres
  const eOx  = r(rx * 0.40);
  const eOy  = r(ry * 0.22);
  const lEx  = r(cx - eOx), rEx = r(cx + eOx), eyeY = r(cy - eOy);
  const erx  = r(rx * 0.12 * o.eyeScale), ery = r(ry * 0.08 * o.eyeScale);
  const hrx  = r(rx * 0.04 * o.eyeScale), hry = r(ry * 0.03 * o.eyeScale);
  const hlx  = r(lEx + rx * 0.03), hrxPos = r(rEx + rx * 0.03);
  const hly  = r(eyeY - ery * 0.35);
  // Eyebrows — browExpr shifts peak up (raised > 0) or down (furrowed < 0)
  const bOy     = r(ry * 0.32);
  const bW      = r(eOx * 0.50);
  const browY   = r(eyeY - bOy);
  const peakShift = r(bOy * 0.65 * (1 + o.browExpr));
  const browPeak  = r(eyeY - bOy - peakShift);
  // Nose
  const nBot = r(cy + ry * 0.25);
  const nW   = r(rx * 0.09);
  const nTip = r(nBot + ry * 0.08);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <g id="face-head">
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${o.skinColor}" stroke="${skinStroke}" stroke-width="2.5"/>
    <ellipse cx="${lEx}" cy="${eyeY}" rx="${erx}" ry="${ery}" fill="${o.eyeColor}"/>
    <ellipse cx="${rEx}" cy="${eyeY}" rx="${erx}" ry="${ery}" fill="${o.eyeColor}"/>
    <ellipse cx="${hlx}" cy="${hly}" rx="${hrx}" ry="${hry}" fill="#ffffff"/>
    <ellipse cx="${hrxPos}" cy="${hly}" rx="${hrx}" ry="${hry}" fill="#ffffff"/>
    <path d="M${r(lEx - bW)},${browY} Q${lEx},${browPeak} ${r(lEx + bW)},${browY}" fill="none" stroke="${o.browColor}" stroke-width="2" stroke-linecap="round"/>
    <path d="M${r(rEx - bW)},${browY} Q${rEx},${browPeak} ${r(rEx + bW)},${browY}" fill="none" stroke="${o.browColor}" stroke-width="2" stroke-linecap="round"/>
    <path d="M${cx},${cy} L${r(cx - nW)},${nBot} Q${cx},${nTip} ${r(cx + nW)},${nBot} Z" fill="${noseFill}"/>
  </g>
</svg>`;
}

// Analyze audio amplitude in 100ms windows and emit MXML keyframe strings.
//
// The mouth shape is driven by the amplitude envelope of the audio:
//   - Silence (RMS ≤ threshold) → REST (mouth closed)
//   - Speech   (RMS > threshold) → one of 6 openness tiers, from barely-open
//     (whisper) to fully-open (very loud), selected by normalised RMS so the
//     full tier range is always used regardless of the file's overall loudness.
//
// Crucially a keyframe is only emitted when the TIER changes, not on every
// window. Staying in the same tier holds the current shape — this prevents
// the rapid per-100ms jitter that makes dense-speech files (where almost every
// window is above the silence threshold) look like random flickering.
//
// Falls back to 15 evenly-spaced shapes over 112 frames when no audio is
// available (e.g. the test harness).
export function buildMouthKeyframes(audioBuffer, fps) {
  const REST = MOUTH_PATHS[0];

  if (!audioBuffer || typeof audioBuffer.getChannelData !== "function") {
    return MOUTH_PATHS.map((d, i) =>
      `    <mx:Keyframe frame="${i * 8}" d="${d}"/>`
    ).join("\n");
  }

  const data      = audioBuffer.getChannelData(0);
  const sr        = audioBuffer.sampleRate;
  const winSec    = 0.10;                               // 100 ms analysis window
  const winSamp   = Math.floor(sr * winSec);
  const winFr     = Math.max(1, Math.round(fps * winSec));
  const silenceRms = 0.012;

  // Six mouth-openness tiers, each with 2-3 viseme shape variants.
  // Ordered small→large jaw drop; cycling within a tier adds natural variation.
  const TIERS = [
    [7, 8],        // tier 0: whisper   (SS, nn)    — barely open
    [2, 3],        // tier 1: soft      (FF, TH)    — slight opening
    [9, 6],        // tier 2: medium    (RR, CH)    — mid open
    [4, 11],       // tier 3: clear     (DD, E)     — comfortably open
    [5, 13],       // tier 4: loud      (kk, O)     — wide open
    [10, 12, 14],  // tier 5: very loud (aa, I, U)  — fully open
  ];

  // Pass 1 — compute per-window RMS.
  const numWin = Math.ceil(data.length / winSamp);
  const rmsArr = new Float32Array(numWin);
  for (let w = 0; w < numWin; w++) {
    const off = w * winSamp;
    const n   = Math.min(winSamp, data.length - off);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += data[off + i] * data[off + i];
    rmsArr[w] = Math.sqrt(sum / n);
  }

  // Pass 2 — find the speech amplitude range (p5 … p95) so the tier spread
  // adapts to the file's own loudness. A globally loud recording still uses
  // all 6 tiers because we normalise to its own dynamic range.
  const speechRms = Array.from(rmsArr)
    .filter(r => r > silenceRms)
    .sort((a, b) => a - b);
  const rmsLo = speechRms.length > 1
    ? speechRms[Math.floor(speechRms.length * 0.05)]
    : silenceRms;
  const rmsHi = speechRms.length > 1
    ? speechRms[Math.floor(speechRms.length * 0.95)]
    : 0.1;
  const rmsRange = Math.max(rmsHi - rmsLo, 1e-6);

  // Pass 3 — emit keyframes only on tier transitions.
  // Holding the same shape within a tier produces correlated mouth movement
  // (louder ↔ more-open) without the noisy per-window cycling that makes
  // dense-speech audio look uncorrelated.
  const lines      = [];
  const tierCycles = new Int32Array(TIERS.length); // per-tier advance counters
  let prevTier = null;  // tracks last tier to detect transitions
  let prevD    = null;

  for (let w = 0; w < numWin; w++) {
    const rms = rmsArr[w];

    let currTier;
    if (rms <= silenceRms) {
      currTier = -1; // silence
    } else {
      const t = Math.max(0, Math.min(1, (rms - rmsLo) / rmsRange));
      currTier = Math.min(TIERS.length - 1, Math.floor(t * TIERS.length));
    }

    if (currTier !== prevTier) {
      // Tier changed — advance to next shape variant in the new tier.
      const d = currTier === -1
        ? REST
        : MOUTH_PATHS[TIERS[currTier][tierCycles[currTier]++ % TIERS[currTier].length]];

      if (d !== prevD) {
        lines.push(`    <mx:Keyframe frame="${w * winFr}" d="${d}"/>`);
        prevD = d;
      }
      prevTier = currTier;
    }
    // Same tier: hold current shape — no keyframe emitted.
  }

  // Ensure the mouth is closed at the end.
  if (prevD !== REST) {
    lines.push(`    <mx:Keyframe frame="${(numWin - 1) * winFr}" d="${REST}"/>`);
  }

  return lines.join("\n");
}

// Build the MXML fragment for the mouth sprite. When an AudioBuffer is
// supplied (decoded from the chosen audio file), keyframes follow the
// amplitude envelope so playback shows correlated lip movement.
export function buildMouthXml(id, x, y, audioBuffer = null, fps = 60) {
  const lipId = `${id}-lip`;

  return [
    `<mx:Sprite id="${esc(id)}" x="${Math.round(x)}" y="${Math.round(y)}">`,
    `    <mx:Path id="${esc(lipId)}" d="${MOUTH_PATHS[0]}" fill="#8b3a3a" stroke="#c97b63" strokeWidth="2">`,
    `      <mx:Timeline loop="false">`,
    buildMouthKeyframes(audioBuffer, fps),
    `      </mx:Timeline>`,
    `    </mx:Path>`,
    `</mx:Sprite>`,
  ].join("\n");
}
