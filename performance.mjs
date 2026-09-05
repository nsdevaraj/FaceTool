import { buildFaceHeadSvg, buildMouthKeyframes } from "./lib/facegeom.js";
import { STANDARD_VISEMES } from "./lib/mouthshapes.js";
import { scalePathD, translatePathD } from "./lib/pathdata.js";
import { ARTWORK_TARGETS, validateArtwork } from "./artwork-model.mjs";

export const VISEMES = STANDARD_VISEMES;
export const EXPRESSIONS = ["Warm", "Bright", "Curious", "Focused", "Surprised", "Custom"];
export const CAMERA_SHOTS = ["close-up", "medium shot", "wide shot"];
export const GESTURES = [
  { name: "Idle", icon: "\u{1f9cd}" },
  { name: "Wave", icon: "\u{1f44b}" },
  { name: "Explain", icon: "\u{1f932}" },
  { name: "Point", icon: "\u{1f449}" },
  { name: "Nod", icon: "\u2195" },
  { name: "Shake", icon: "\u2194" },
  { name: "Shrug", icon: "\u{1f937}" },
  { name: "Cheer", icon: "\u{1f64c}" },
  { name: "Clap", icon: "\u{1f44f}" },
  { name: "Think", icon: "\u{1f914}" },
];
const FPS = 30;
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rate = project => Math.max(0.01, finite(project.pace, 100) / 100);
const duration = scene => Math.max(1 / FPS, finite(scene.duration, 4));
const xml = value => String(value).replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
})[c]);
const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
const pose = phoneme => VISEMES.find(v => v.phoneme.toLowerCase() === String(phoneme).toLowerCase()) ?? VISEMES[0];

export function analyzeAudio(buffer, fps = FPS) {
  if (!buffer || !buffer.getChannelData?.(0)?.length) return [{ frame: 0, phoneme: "rest" }];
  if (!(buffer.sampleRate >= 10) || !(fps > 0)) throw new RangeError("Invalid audio sample rate or fps");
  const keys = new Map();
  for (const match of buildMouthKeyframes(buffer, fps).matchAll(/frame="(\d+)" d="([^"]+)"/g)) {
    keys.set(Number(match[1]), VISEMES.find(v => v.d === match[2])?.phoneme ?? "rest");
  }
  return [...keys].map(([frame, phoneme]) => ({ frame, phoneme }));
}

export function shapePath(phoneme, settings = {}) {
  const sx = clamp(finite(settings.width, 100), 0, 300) / 100;
  const sy = clamp(finite(settings.opening, 100), 0, 300) / 100;
  return scalePathD(pose(phoneme).d, sx, sy, 40 * (1 - sx), 20 * (1 - sy));
}

export function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  if (!Number.isInteger(channels) || channels < 1 || channels > 32 ||
      !Number.isInteger(length) || length < 0 || !(sampleRate > 0)) {
    throw new RangeError("Invalid AudioBuffer");
  }
  const result = new ArrayBuffer(44 + length * channels * 2);
  const view = new DataView(result);
  const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, result.byteLength - 8, true);
  text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, length * channels * 2, true);
  const data = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  for (let frame = 0; frame < length; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = clamp(finite(data[channel][frame], 0), -1, 1);
      view.setInt16(44 + (frame * channels + channel) * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
  }
  return result;
}

export function totalDuration(project) {
  return (project.scenes ?? []).reduce((sum, scene) => sum + duration(scene), 0) / rate(project);
}

export function exportFramePlan(project) {
  let elapsed = 0, start = 0;
  return (project.scenes ?? []).map(scene => {
    elapsed += duration(scene) / rate(project);
    const end = Math.max(start + 1, Math.round(elapsed * FPS));
    const part = { scene, start, end };
    start = end;
    return part;
  });
}

function characterFor(project, scene) {
  return project.characters?.[scene.characterIndex ?? project.selectedCharacter ?? 0] ?? project.characters?.[0] ?? {};
}

function phonemeAt(project, scene, time) {
  if (project.toggles?.lipSync === false) return "rest";
  let selected = "rest", latest = -1;
  for (const cue of scene.cues ?? []) {
    const frame = finite(cue.frame, -1);
    if (frame >= latest && frame >= 0 && frame <= time * FPS + 1e-7) {
      latest = frame;
      selected = pose(cue.phoneme).phoneme;
    }
  }
  return selected;
}

export function performanceAt(project, scene, time) {
  const active = (cues, fallback) => {
    let value = fallback, frame = 0;
    for (const cue of cues ?? []) {
      if (cue.frame >= frame && cue.frame <= time * FPS + 1e-7) {
        value = cue.value;
        frame = cue.frame;
      }
    }
    return { value, frame };
  };
  const expression = active(scene.expressionCues, project.expression ?? "Warm");
  const gesture = active(scene.gestureCues, project.gesture ?? "Idle");
  const camera = active(scene.cameraCues, scene.detail ?? "close-up");
  return { expression: expression.value, gesture: gesture.value, camera: camera.value, gestureTime: Math.max(0, time - gesture.frame / FPS) };
}

// Read the pure Face Tool SVG primitives, rather than maintaining a second head rig.
function headPaths(options) {
  return [...buildFaceHeadSvg(640, 440, options).matchAll(/<(ellipse|path)\s+([^>]+)\/>/g)].map(([, tag, text]) => {
    const a = Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    let d = a.d;
    if (tag === "ellipse") {
      const [cx, cy, rx, ry] = ["cx", "cy", "rx", "ry"].map(k => Number(a[k]));
      d = `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
    }
    return { d, fill: a.fill ?? "none", stroke: a.stroke ?? "none", strokeWidth: Number(a["stroke-width"] ?? 0) };
  });
}

function gesturePose(gesture, time, energy) {
  const movement = Math.sin(time * 2.4) * energy;
  const pose = { leftX: 197, leftY: 445, leftElbowX: 184, leftElbowY: 395,
    rightX: 443, rightY: 445, rightElbowX: 476, rightElbowY: 375, headX: 0, headY: 0 };
  switch (gesture) {
    case "Wave":
      Object.assign(pose, { rightX: 490, rightY: 190 + movement * 24 });
      break;
    case "Explain":
      Object.assign(pose, { leftX: 150, leftY: 330 - movement * 16, rightX: 490, rightY: 330 + movement * 16 });
      break;
    case "Point":
      Object.assign(pose, { rightX: 550, rightY: 280 });
      break;
    case "Nod":
      pose.headY = Math.cos(time * 5) * 12 * energy;
      break;
    case "Shake":
      pose.headX = Math.cos(time * 5) * 18 * energy;
      break;
    case "Shrug":
      Object.assign(pose, { leftX: 155, leftY: 305 - movement * 18, rightX: 485, rightY: 305 - movement * 18,
        leftElbowY: 370, rightElbowY: 370, headY: -movement * 5 });
      break;
    case "Cheer":
      Object.assign(pose, { leftX: 150, leftY: 150 - movement * 24, rightX: 490, rightY: 150 - movement * 24,
        leftElbowX: 150, leftElbowY: 280, rightElbowX: 490, rightElbowY: 280 });
      break;
    case "Clap": {
      const spread = (1 + Math.cos(time * 8)) * 32 * energy;
      Object.assign(pose, { leftX: 308 - spread, leftY: 345, rightX: 332 + spread, rightY: 345,
        leftElbowX: 245, leftElbowY: 405, rightElbowX: 395, rightElbowY: 405 });
      break;
    }
    case "Think":
      Object.assign(pose, { rightX: 355 + movement * 3, rightY: 330 - movement * 3,
        rightElbowX: 455, rightElbowY: 420, headX: movement * 4 });
      break;
  }
  return pose;
}

const canvasSeed = () => [{ d: "M 0 0 H 640 V 480 H 0 Z", fill: "#edf4ef" }];
const bodySeed = skin => [
  { d: "M 282 292 H 358 V 356 H 282 Z", fill: skin },
  { d: "M 218 356 Q 320 304 422 356 L 446 480 H 194 Z", fill: "#47786d" },
];
const browExpression = (expression, strength) =>
  (({ Warm: 0.1, Bright: 0.6, Curious: 0.8, Focused: -0.5, Surprised: 1, Custom: 0 })[expression] ?? 0) * strength;

function validateSceneArtwork(project, scene) {
  validateArtwork(characterFor(project, scene).artwork, "character");
  validateArtwork(scene.artwork, "scene");
}

export function getArtworkForEditing(project, scene, target) {
  const definition = ARTWORK_TARGETS.find(item => item.id === target);
  if (!definition) throw new TypeError(`Unknown artwork target "${target}"`);
  validateSceneArtwork(project, scene);
  const character = characterFor(project, scene);
  const current = (definition.scope === "scene" ? scene : character).artwork?.[target];
  const skin = color(character.skinColor, "#fce4d6");
  const strength = clamp(finite(project.strength, 72), 0, 100) / 100;
  const seed = current ?? (target === "canvas" ? canvasSeed() : target === "foreground" ? [] :
    target === "body" ? bodySeed(skin) : target === "face" ?
      headPaths({ skinColor: skin, browExpr: browExpression(performanceAt(project, scene, 0).expression, strength), eyeScale: 1 }) :
      [{ d: "M 67 80 A 13 13 0 1 0 93 80 A 13 13 0 1 0 67 80 Z", fill: skin }]);
  return seed.map(part => ({ d: part.d, fill: part.fill, stroke: part.stroke ?? "none", strokeWidth: part.strokeWidth ?? 0 }));
}

function artwork(project, scene, time, validated = false, transparentBackground = false) {
  if (!validated) validateSceneArtwork(project, scene);
  const character = characterFor(project, scene);
  const custom = character.artwork ?? {};
  const skin = color(character.skinColor, "#fce4d6");
  const energy = clamp(finite(project.energy, 64), 0, 100) / 100;
  const strength = clamp(finite(project.strength, 72), 0, 100) / 100;
  const movement = Math.sin(time * 2.4) * energy;
  const performance = performanceAt(project, scene, time);
  const gesture = gesturePose(performance.gesture, performance.gestureTime, energy);
  const dx = gesture.headX + (project.toggles?.follow === false ? 0 : movement * 4);
  const dy = gesture.headY + (project.toggles?.follow === false ? 0 : Math.sin(time * 3) * energy * 2);
  const blink = project.toggles?.blink !== false && time % 3.6 >= 3.35 && time % 3.6 < 3.5;
  const head = (custom.face ?? headPaths({ skinColor: skin,
    browExpr: browExpression(performance.expression, strength), eyeScale: blink ? 0.08 : 1 }))
    .map(item => ({ ...item, d: translatePathD(item.d, dx, dy) }));
  const phoneme = phonemeAt(project, scene, time);
  const mouth = shapePath(phoneme, character.mouthSettings?.[phoneme] ?? {});
  const canvas = transparentBackground ? [] : scene.artwork?.canvas ?? canvasSeed();
  const parts = [
    ...(custom.body ?? bodySeed(skin)),
    { d: `M 222 365 Q ${gesture.leftElbowX} ${gesture.leftElbowY} ${gesture.leftX} ${gesture.leftY}`, fill: "none", stroke: skin, strokeWidth: 26 },
    { d: `M 418 365 Q ${gesture.rightElbowX} ${gesture.rightElbowY} ${gesture.rightX} ${gesture.rightY}`, fill: "none", stroke: skin, strokeWidth: 26 },
    ...head,
    ...(custom.leftHand ?? []).map(item => ({ ...item, d: translatePathD(item.d, gesture.leftX - 80, gesture.leftY - 80) })),
    ...(custom.rightHand ?? []).map(item => ({ ...item, d: translatePathD(item.d, gesture.rightX - 80, gesture.rightY - 80) })),
    { d: translatePathD(mouth, 280 + dx, 244 + dy), fill: color(character.lipColor, "#8b3a3a"), stroke: "#c97b63", strokeWidth: 2 },
  ];
  const zoom = ({ "close-up": 1, "medium shot": 0.85, "wide shot": 0.7 })[performance.camera] ?? 1;
  const characterParts = parts.map(part => ({
    ...part,
    d: scalePathD(part.d, zoom, zoom, 320 * (1 - zoom), 480 * (1 - zoom)),
    strokeWidth: (part.strokeWidth ?? 0) * zoom,
  }));
  return { parts: [...canvas, ...characterParts, ...(scene.artwork?.foreground ?? [])],
    mouthIndex: canvas.length + characterParts.length - 1 };
}

const sourceFrameTime = (project, scene, time) =>
  Math.floor(clamp(finite(time, 0), 0, duration(scene)) / rate(project) * FPS + 1e-7) * rate(project) / FPS;

export function drawFrame(canvas, project, scene, time = 0, { transparentBackground = false } = {}) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("A 2D canvas context is required to render the character.");
  const { parts } = artwork(project, scene, sourceFrameTime(project, scene, time), false, transparentBackground);
  ctx.save();
  ctx.setTransform(canvas.width / 640, 0, 0, canvas.height / 480, 0, 0);
  ctx.clearRect(0, 0, 640, 480);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const item of parts) {
    const path = new Path2D(item.d);
    if (item.fill !== "none") { ctx.fillStyle = item.fill; ctx.fill(path); }
    if (item.stroke && item.stroke !== "none" && item.strokeWidth > 0) {
      ctx.strokeStyle = item.stroke; ctx.lineWidth = item.strokeWidth; ctx.stroke(path);
    }
  }
  ctx.restore();
}

export function buildSvg(project, scene, time = 0) {
  const { parts } = artwork(project, scene, sourceFrameTime(project, scene, time));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">\n` +
    parts.map(item => `  <path d="${xml(item.d)}" fill="${xml(item.fill)}" stroke="${xml(item.stroke ?? "none")}" stroke-width="${item.strokeWidth ?? 0}" stroke-linecap="round" stroke-linejoin="round"/>`).join("\n") +
    "\n</svg>";
}

function embeddedAudio(src, pace, seconds) {
  if (!/^data:audio\/(?:wav|wave|x-wav);base64,/i.test(src)) {
    throw new TypeError("Scene audio must be an embedded PCM16 WAV data URL");
  }
  const binary = atob(src.slice(src.indexOf(",") + 1));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new TypeError("Invalid WAV audio");
  let format, dataOffset, dataLength;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true);
    if (at + 8 + size > bytes.length) throw new TypeError("Truncated WAV audio");
    if (tag(at) === "fmt " && size >= 16) format = at + 8;
    if (tag(at) === "data") { dataOffset = at + 8; dataLength = size; break; }
    at += 8 + size + size % 2;
  }
  if (format === undefined || dataOffset === undefined ||
      view.getUint16(format, true) !== 1 || view.getUint16(format + 14, true) !== 16) {
    throw new TypeError("Scene audio must be PCM16 WAV");
  }
  const sampleRate = view.getUint32(format + 4, true);
  const block = view.getUint16(format + 12, true);
  if (!sampleRate || !block) throw new TypeError("Invalid WAV format");
  // Cue IR has no rate/stop fields: bake playback speed and the scene cutoff into PCM metadata.
  const newRate = Math.max(1, Math.round(sampleRate * pace));
  view.setUint32(format + 4, newRate, true);
  view.setUint32(format + 8, newRate * block, true);
  const size = Math.min(dataLength, Math.floor(seconds * newRate) * block);
  const trimmed = bytes.subarray(0, dataOffset + size);
  view.setUint32(dataOffset - 4, size, true);
  view.setUint32(4, trimmed.length - 8, true);
  let encoded = "";
  for (let i = 0; i < trimmed.length; i += 8192) encoded += String.fromCharCode(...trimmed.subarray(i, i + 8192));
  return `data:audio/wav;base64,${btoa(encoded)}`;
}

export function buildLax(project) {
  const lines = [`<mx:Scene xmlns:mx="http://littlea.dev/2026/mxml" width="640" height="480" fps="30">`];
  lines.push(`  <mx:Layer name="${xml(project.title || "Character Studio")}">`);
  const faces = [];
  const plan = exportFramePlan(project);
  for (const [index, { scene, start, end }] of plan.entries()) {
    validateSceneArtwork(project, scene);
    const { parts: first, mouthIndex } = artwork(project, scene, 0, true);
    const tracks = first.map(() => []);
    const visemes = new Map();
    let previous = [];
    for (let frame = start; frame < end; frame++) {
      const time = (frame - start) * rate(project) / FPS;
      const phoneme = phonemeAt(project, scene, time);
      if (!visemes.has(phoneme)) visemes.set(phoneme, frame);
      const { parts: snapshot } = artwork(project, scene, time, true);
      snapshot.forEach((item, i) => {
        if (item.d !== previous[i]?.d || item.strokeWidth !== previous[i]?.strokeWidth) {
          const stroke = item.stroke && item.stroke !== "none" ? ` strokeWidth="${item.strokeWidth}"` : "";
          tracks[i].push(`<mx:Keyframe frame="${frame}" d="${xml(item.d)}"${stroke} ease="hold"/>`);
        }
        previous[i] = item;
      });
    }
    lines.push(`    <mx:Sprite id="scene-${index}" visible="${start === 0}">`);
    const visibility = new Map([[0, start === 0 ? 1 : 0], [start, 1], [end, 0]]);
    lines.push(`      <mx:Timeline loop="false">${[...visibility].map(([frame, visible]) => `<mx:Keyframe frame="${frame}" visible="${visible}" ease="hold"/>`).join("")}</mx:Timeline>`);
    first.forEach((item, i) => {
      lines.push(`      <mx:Path id="scene-${index}-part-${i}" d="${xml(item.d)}" fill="${xml(laxPaint(item.fill))}" stroke="${xml(laxPaint(item.stroke))}" strokeWidth="${item.strokeWidth ?? 0}" strokeLinecap="round" strokeLinejoin="round">`);
      if (tracks[i].length > 1 || i === mouthIndex) lines.push(`        <mx:Timeline loop="false">${tracks[i].join("")}</mx:Timeline>`);
      lines.push("      </mx:Path>");
    });
    lines.push("    </mx:Sprite>");
    faces.push({ mouth: `scene-${index}-part-${mouthIndex}`, visemes });
  }
  lines.push("  </mx:Layer>");
  for (const [index, { scene, start, end }] of plan.entries()) {
    if (scene.audio?.src) {
      const src = embeddedAudio(scene.audio.src, rate(project), (end - start) / FPS);
      lines.push(`  <mx:Sound id="voice-${index}" src="${xml(src)}"/>`, `  <mx:Cue sound="voice-${index}" frame="${start}" loop="false"/>`);
      // Point authoring tools at real keyed poses, without a second rig or hidden playback.
      const face = faces[index];
      lines.push(`  <mx:Face id="face-${index}" sound="voice-${index}" mouth="${face.mouth}">`);
      for (const [phoneme, frame] of face.visemes) lines.push(`    <mx:Viseme phoneme="${phoneme}" frame="${frame}"/>`);
      lines.push("  </mx:Face>");
    }
  }
  lines.push("</mx:Scene>");
  lines.unshift(`<!-- Rename scene.lax below to this file's name. Render with: la export scene.lax --format mp4 --frames ${plan.at(-1)?.end ?? 0} -o scene.mp4 -->`);
  return lines.join("\n");
}

function laxPaint(value) {
  if (!value || value === "none") return "#00000000";
  return /^#[\da-f]{3,4}$/i.test(value) ? "#" + [...value.slice(1)].map(c => c + c).join("") : value;
}
