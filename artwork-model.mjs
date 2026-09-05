import { buildPathD, ellipsePathD } from "./lib/svgeditor.js";
import { pathPoints, translatePathD } from "./lib/pathdata.js";

export const ARTWORK_TARGETS = Object.freeze([
  { id: "face", label: "Face", scope: "character", width: 640, height: 480 },
  { id: "body", label: "Body", scope: "character", width: 640, height: 480 },
  { id: "leftHand", label: "Left hand", scope: "character", width: 160, height: 160 },
  { id: "rightHand", label: "Right hand", scope: "character", width: 160, height: 160 },
  { id: "canvas", label: "Canvas", scope: "scene", width: 640, height: 480 },
  { id: "foreground", label: "Foreground", scope: "scene", width: 640, height: 480 },
].map(Object.freeze));

const MAX_PATHS = 200;
const MAX_PATH_LENGTH = 20000;
const MAX_COORDINATE = 1000000;
const PARAMS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => { throw new TypeError(`Invalid artwork: ${message}`); };

function number(value, name, min = -MAX_COORDINATE, max = MAX_COORDINATE) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${name} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function paint(value, name) {
  if (typeof value !== "string" || (value !== "none" && !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value))) {
    fail(`${name} must be "none", #RGB or #RRGGBB; alpha colors, gradients and other paint styles are not supported`);
  }
}

function validatePath(d) {
  if (typeof d !== "string" || !d.trim() || d.length > MAX_PATH_LENGTH) {
    fail(`path d must be nonempty and at most ${MAX_PATH_LENGTH} characters`);
  }
  const tokens = [];
  const token = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
  let at = 0, previous = "";
  while (at < d.length) {
    const separator = /^[\s,]+/.exec(d.slice(at))?.[0] ?? "";
    if (separator.includes(",") && (!previous || /^[a-z]$/i.test(previous) ||
        (separator.match(/,/g) ?? []).length > 1)) fail("malformed path separator");
    at += separator.length;
    if (at === d.length) {
      if (separator.includes(",")) fail("trailing path comma");
      break;
    }
    token.lastIndex = at;
    const match = token.exec(d);
    if (!match) fail("path contains invalid commands or non-finite coordinates");
    if (separator.includes(",") && /^[a-z]$/i.test(match[0])) fail("comma before path command");
    tokens.push(match[0]);
    previous = match[0];
    at = token.lastIndex;
  }
  if (!/^[Mm]$/.test(tokens[0])) fail("path must begin with moveto");
  let command, i = 0;
  while (i < tokens.length) {
    if (/^[a-z]$/i.test(tokens[i])) {
      command = tokens[i++].toUpperCase();
      if (command === "Z") { command = undefined; continue; }
    }
    if (!command) fail("path coordinates require a command");
    const count = PARAMS[command];
    const values = tokens.slice(i, i + count);
    if (values.length !== count || values.some(v => /^[a-z]$/i.test(v))) fail("incomplete path command");
    const nums = values.map(v => number(Number(v), "path coordinate"));
    if (command === "A" && (nums[0] < 0 || nums[1] < 0 ||
        !["0", "1"].includes(values[3]) || !["0", "1"].includes(values[4]))) {
      fail("arc radii must be nonnegative and arc flags must be 0 or 1");
    }
    if (command === "A" && nums[2] !== 0) fail("rotated arcs are not supported; use axis-aligned arcs or curves");
    i += count;
    if (command === "M") command = "L";
  }
  for (const point of pathPoints(d)) {
    number(point.x, "absolute path x");
    number(point.y, "absolute path y");
  }
}

function validateParts(parts) {
  if (!Array.isArray(parts) || parts.length > MAX_PATHS) fail(`each target must contain an array of at most ${MAX_PATHS} paths`);
  for (const part of parts) {
    if (!record(part) || Object.keys(part).some(key => !["d", "fill", "stroke", "strokeWidth"].includes(key))) {
      fail("each path must contain only d, fill, stroke and strokeWidth");
    }
    validatePath(part.d);
    paint(part.fill, "fill");
    paint(part.stroke, "stroke");
    number(part.strokeWidth, "strokeWidth", 0, 1000);
  }
}

export function validateArtwork(value, scope) {
  if (!["character", "scene"].includes(scope)) fail(`unknown scope "${scope}"`);
  if (value === undefined) return;
  if (!record(value)) fail(`${scope}.artwork must be an object`);
  const allowed = ARTWORK_TARGETS.filter(target => target.scope === scope).map(target => target.id);
  for (const [target, parts] of Object.entries(value)) {
    if (!allowed.includes(target)) fail(`unknown ${scope} target "${target}"`);
    validateParts(parts);
  }
}

export function partsToShapes(parts) {
  validateParts(parts);
  return parts.map((part, index) => ({
    id: `artwork-${index + 1}`, type: "rawpath", d: part.d, fill: part.fill, stroke: part.stroke,
    sw: part.strokeWidth, tx: 0, ty: 0,
  }));
}

function simpleStyle(shape) {
  if (shape.rotation !== undefined && shape.rotation !== 0) fail("rotation is not supported; use unrotated paths");
  for (const key of ["linecap", "linejoin"]) {
    if (shape[key] !== undefined && shape[key] !== "round") fail(`${key}: only round strokes are supported`);
  }
  if (shape.miterlimit !== undefined && shape.miterlimit !== 4) fail("advanced miterlimit is not supported");
  if (shape.dasharray !== undefined && !(Array.isArray(shape.dasharray) && shape.dasharray.length === 0) &&
      shape.dasharray !== "" && shape.dasharray !== "none") fail("dashed strokes are not supported");
  if (shape.dashoffset !== undefined && shape.dashoffset !== 0) fail("stroke dashoffset is not supported");
  for (const key of ["opacity", "fillOpacity", "strokeOpacity"]) {
    if (shape[key] !== undefined && shape[key] !== 1) fail(`${key} is not supported; use solid hex colors`);
  }
  for (const key of ["transform", "gradient", "fillGradient", "strokeGradient", "filter", "clipPath", "mask",
    "fillRule", "fill-rule", "vectorEffect", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset"]) {
    if (shape[key] !== undefined) fail(`${key} is not supported`);
  }
  if (shape.type !== "rawpath" && ((shape.tx ?? 0) !== 0 || (shape.ty ?? 0) !== 0)) {
    fail("translation is only supported for raw paths; move shape coordinates instead");
  }
}

export function shapesToParts(shapes) {
  if (!Array.isArray(shapes) || shapes.length > MAX_PATHS) fail(`drawing must contain at most ${MAX_PATHS} shapes`);
  const parts = shapes.map(shape => {
    if (!record(shape)) fail("shape must be an object");
    simpleStyle(shape);
    let d;
    if (shape.type === "rawpath") {
      validatePath(shape.d);
      d = translatePathD(shape.d, number(shape.tx ?? 0, "translation x"), number(shape.ty ?? 0, "translation y"));
    } else if (shape.type === "path") {
      if (!Array.isArray(shape.pts) || !shape.pts.length || shape.pts.length > 2000) fail("path requires 1–2000 points");
      for (const point of shape.pts) {
        if (!record(point)) fail("path point must be an object");
        number(point.x, "point x"); number(point.y, "point y");
      }
      if (shape.closed !== undefined && typeof shape.closed !== "boolean") fail("closed must be boolean");
      if (shape.smooth !== undefined && typeof shape.smooth !== "boolean") fail("smooth must be boolean");
      d = buildPathD(shape.pts, shape.closed ?? false, shape.smooth !== false);
    } else if (shape.type === "ellipse") {
      d = ellipsePathD(number(shape.cx, "ellipse cx"), number(shape.cy, "ellipse cy"),
        number(shape.rx, "ellipse rx", 0), number(shape.ry, "ellipse ry", 0));
    } else if (shape.type === "rect") {
      const x = number(shape.x, "rect x"), y = number(shape.y, "rect y");
      const w = number(shape.w, "rect width", 0), h = number(shape.h, "rect height", 0);
      if ((shape.rx ?? 0) !== 0 || (shape.ry ?? 0) !== 0) fail("rounded rectangles are not supported");
      d = `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
    } else {
      fail(`shape type "${shape.type}" is not supported; use paths, ellipses or rectangles (not text)`);
    }
    return { d, fill: shape.fill, stroke: shape.stroke, strokeWidth: shape.sw };
  });
  validateParts(parts);
  return parts;
}
