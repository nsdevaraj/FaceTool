// svgeditor.js — the SVG drawing canvas.
//
// createSvgEditor(containerEl, opts) — factory: mounts toolbar + canvas + shape list
//   inside any container element.  Each call returns a separate editor instance with
//   its own closure state.  Public API:
//     destroy()
//     exportSvg(w, h)           → SVG string scaled to target w×h
//     exportPath(w, h)          → { d, fill, stroke, sw } — the canvas as ONE path
//     loadFromLayer()           → load active layer's Path nodes from MXML
//     loadFromSvgStr(str,w,h)   → add shapes from an SVG string
//     replaceWithSvg(str,w,h)   → clear + load shapes from an SVG string
//     getShapes() / setShapes(arr) → the canvas as data, for a caller that has
//       to remount the editor without losing what is on it
//     selectShapeAt(i)          → select a loaded shape, so its nodes are draggable
//     getShapeCount()           → number of shapes in canvas
//     clearShapes()
//
// The canvas is a component, not a screen: the dialogs that host it own what
// the drawing MEANS.  ./facetool.js mounts it for both face artwork and the
// mouth shapes of a <mx:Face>.
//
// Options: canvasWidth/canvasHeight (height alias), getLayerSource() → { source, activeLayer },
// simplePaths (portable geometry and solid paint only), onError(Error).
// In simplePaths mode invalid imports leave the drawing/history untouched.

import {
  absoluteStart, isEditablePath, pathBBox, pathPoints, pathTokens, scalePathD, withPathPoints,
} from "./pathdata.js";

// ─────────────────── Pure module-level utilities ──────────────────────────────

export const rn = (n, d = 1) => +n.toFixed(d);
export const xmlAttr = value => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

export function deepCloneShapes(arr) {
  return arr.map(s => ({
    ...s,
    pts: s.pts ? s.pts.map(p => ({ ...p })) : undefined,
    ...(s.gradient ? { gradient: {
      ...s.gradient,
      from: { ...s.gradient.from },
      to: { ...s.gradient.to },
      stops: s.gradient.stops.map(stop => ({ ...stop })),
    } } : {}),
  }));
}

export function buildPathD(pts, closed, smooth = true) {
  if (!pts.length) return "";
  if (pts.length === 1) return `M ${rn(pts[0].x)},${rn(pts[0].y)}`;
  if (!smooth || pts.length < 3) {
    let d = `M ${rn(pts[0].x)},${rn(pts[0].y)}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${rn(pts[i].x)},${rn(pts[i].y)}`;
    if (closed) d += " Z";
    return d;
  }

  const n = pts.length;
  const get = i => closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n-1, i))];
  let d = `M ${rn(pts[0].x)},${rn(pts[0].y)}`;
  const limit = closed ? n : n - 1;
  for (let i = 0; i < limit; i++) {
    const p0 = get(i-1), p1 = get(i), p2 = get(i+1), p3 = get(i+2);
    d += ` C ${rn(p1.x+(p2.x-p0.x)/6)},${rn(p1.y+(p2.y-p0.y)/6)}`
       + ` ${rn(p2.x-(p3.x-p1.x)/6)},${rn(p2.y-(p3.y-p1.y)/6)}`
       + ` ${rn(p2.x)},${rn(p2.y)}`;
  }
  if (closed) d += " Z";
  return d;
}

export function regularPolygonPoints(cx, cy, rx, ry, sides = 5, rotation = -Math.PI / 2) {
  const count = Math.max(3, Math.round(sides));
  return Array.from({ length: count }, (_, i) => {
    const angle = rotation + i * Math.PI * 2 / count;
    return { x: rn(cx + Math.cos(angle) * rx), y: rn(cy + Math.sin(angle) * ry) };
  });
}

export function starPoints(cx, cy, rx, ry, points = 5, innerRatio = 0.45, rotation = -Math.PI / 2) {
  const count = Math.max(3, Math.round(points));
  const ratio = Math.max(0.05, Math.min(0.95, innerRatio));
  return Array.from({ length: count * 2 }, (_, i) => {
    const outer = i % 2 === 0;
    const angle = rotation + i * Math.PI / count;
    return {
      x: rn(cx + Math.cos(angle) * rx * (outer ? 1 : ratio)),
      y: rn(cy + Math.sin(angle) * ry * (outer ? 1 : ratio)),
    };
  });
}

export function arrowPoints(x1, y1, x2, y2, width = 16) {
  const dx = x2 - x1, dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length, uy = dy / length;
  const px = -uy, py = ux;
  const half = Math.min(width / 2, length / 5);
  const head = Math.min(Math.max(width * 1.4, 18), length * 0.45);
  const neckX = x2 - ux * head, neckY = y2 - uy * head;
  return [
    { x: rn(x1 + px * half), y: rn(y1 + py * half) },
    { x: rn(neckX + px * half), y: rn(neckY + py * half) },
    { x: rn(neckX + px * width), y: rn(neckY + py * width) },
    { x: rn(x2), y: rn(y2) },
    { x: rn(neckX - px * width), y: rn(neckY - py * width) },
    { x: rn(neckX - px * half), y: rn(neckY - py * half) },
    { x: rn(x1 - px * half), y: rn(y1 - py * half) },
  ];
}

export function spiralPoints(cx, cy, rx, ry, turns = 3, samples = 72) {
  const count = Math.max(12, Math.round(samples));
  const total = Math.max(0.5, turns) * Math.PI * 2;
  return Array.from({ length: count }, (_, i) => {
    const progress = i / (count - 1);
    const angle = progress * total - Math.PI / 2;
    return {
      x: rn(cx + Math.cos(angle) * rx * progress),
      y: rn(cy + Math.sin(angle) * ry * progress),
    };
  });
}

export function gridPathD(x, y, w, h, columns = 4, rows = 4) {
  const cols = Math.max(1, Math.round(columns));
  const rowCount = Math.max(1, Math.round(rows));
  const lines = [];
  for (let i = 0; i <= cols; i++) {
    const px = rn(x + w * i / cols);
    lines.push(`M ${px},${rn(y)} L ${px},${rn(y + h)}`);
  }
  for (let i = 0; i <= rowCount; i++) {
    const py = rn(y + h * i / rowCount);
    lines.push(`M ${rn(x)},${py} L ${rn(x + w)},${py}`);
  }
  return lines.join(" ");
}

// An ellipse as four cubic segments rather than an `A` arc: `A` is not in the
// command set the lip shapes morph through, so an ellipse that left the editor
// as an arc could never tween into the visemes beside it.
export function ellipsePathD(cx, cy, rx, ry) {
  const k = 0.5522847498307936, ox = rx * k, oy = ry * k;
  return `M ${rn(cx-rx)},${rn(cy)}`
       + ` C ${rn(cx-rx)},${rn(cy-oy)} ${rn(cx-ox)},${rn(cy-ry)} ${rn(cx)},${rn(cy-ry)}`
       + ` C ${rn(cx+ox)},${rn(cy-ry)} ${rn(cx+rx)},${rn(cy-oy)} ${rn(cx+rx)},${rn(cy)}`
       + ` C ${rn(cx+rx)},${rn(cy+oy)} ${rn(cx+ox)},${rn(cy+ry)} ${rn(cx)},${rn(cy+ry)}`
       + ` C ${rn(cx-ox)},${rn(cy+ry)} ${rn(cx-rx)},${rn(cy+oy)} ${rn(cx-rx)},${rn(cy)} Z`;
}

export function normHex6(hex) {
  const c = hex.replace("#", "");
  return c.length === 3
    ? "#" + c.split("").map(x => x+x).join("")
    : "#" + c.padStart(6, "0");
}

export function normColor(c) {
  if (!c || c === "none") return c || "none";
  if (c.length === 9 && c[0] === "#") return c.slice(0, 7);
  return c;
}

export function normalizeDasharray(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite).map(n => Math.max(0, n));
  return String(value || "").split(/[,\s]+/).map(Number).filter(Number.isFinite).map(n => Math.max(0, n));
}

export function strokeAttributes(shape) {
  const attrs = {
    "stroke-linecap": ["butt", "round", "square"].includes(shape.linecap) ? shape.linecap : "round",
    "stroke-linejoin": ["miter", "round", "bevel"].includes(shape.linejoin) ? shape.linejoin : "round",
  };
  const miter = Number(shape.miterlimit);
  if (attrs["stroke-linejoin"] === "miter" && Number.isFinite(miter) && miter >= 1) {
    attrs["stroke-miterlimit"] = rn(miter);
  }
  const dash = normalizeDasharray(shape.dasharray);
  if (dash.length) attrs["stroke-dasharray"] = dash.map(n => rn(n)).join(" ");
  const offset = Number(shape.dashoffset);
  if (Number.isFinite(offset) && offset) attrs["stroke-dashoffset"] = rn(offset);
  return attrs;
}

function strokeAttributeString(shape) {
  return Object.entries(strokeAttributes(shape)).map(([name, value]) => `${name}="${xmlAttr(value)}"`).join(" ");
}

export function bboxShape(s) {
  if (s.type === "ellipse") return { x: s.cx-s.rx, y: s.cy-s.ry, w: s.rx*2, h: s.ry*2 };
  if (s.type === "rect")    return { x: s.x, y: s.y, w: s.w, h: s.h };
  if (s.type === "path") {
    const xs = s.pts.map(p => p.x), ys = s.pts.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs)-x||1, h: Math.max(...ys)-y||1 };
  }
  if (s.type === "rawpath") {
    const bb = pathBBox(s.d);
    if (!bb) return { x:0, y:0, w:1, h:1 };
    return { x: bb.x+s.tx, y: bb.y+s.ty, w: bb.w||1, h: bb.h||1 };
  }
  if (s.type === "text") {
    const size = s.fontSize || 24;
    return { x: s.x, y: s.y - size, w: Math.max(1, String(s.text || "").length * size * 0.62), h: size * 1.2 };
  }
  return { x:0, y:0, w:1, h:1 };
}

export function unionBBoxes(boxes) {
  const valid = boxes.filter(Boolean);
  if (!valid.length) return null;
  const x = Math.min(...valid.map(b => b.x));
  const y = Math.min(...valid.map(b => b.y));
  const right = Math.max(...valid.map(b => b.x + b.w));
  const bottom = Math.max(...valid.map(b => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}

export function alignBBoxes(boxes, mode) {
  const bounds = unionBBoxes(boxes);
  if (!bounds) return [];
  return boxes.map(box => {
    if (mode === "left") return { dx: bounds.x - box.x, dy: 0 };
    if (mode === "center") return { dx: bounds.x + (bounds.w - box.w) / 2 - box.x, dy: 0 };
    if (mode === "right") return { dx: bounds.x + bounds.w - box.w - box.x, dy: 0 };
    if (mode === "top") return { dx: 0, dy: bounds.y - box.y };
    if (mode === "middle") return { dx: 0, dy: bounds.y + (bounds.h - box.h) / 2 - box.y };
    if (mode === "bottom") return { dx: 0, dy: bounds.y + bounds.h - box.h - box.y };
    return { dx: 0, dy: 0 };
  });
}

export function distributeBBoxes(boxes, axis) {
  if (boxes.length < 3) return boxes.map(() => ({ dx: 0, dy: 0 }));
  const keyed = boxes.map((box, index) => ({ box, index }))
    .sort((a, b) => axis === "x" ? a.box.x - b.box.x : a.box.y - b.box.y);
  const first = keyed[0].box;
  const last = keyed.at(-1).box;
  const span = axis === "x"
    ? last.x + last.w - first.x
    : last.y + last.h - first.y;
  const occupied = keyed.reduce((sum, item) => sum + (axis === "x" ? item.box.w : item.box.h), 0);
  const gap = (span - occupied) / (keyed.length - 1);
  const result = boxes.map(() => ({ dx: 0, dy: 0 }));
  let cursor = axis === "x" ? first.x : first.y;
  keyed.forEach(({ box, index }) => {
    const value = axis === "x" ? box.x : box.y;
    result[index][axis === "x" ? "dx" : "dy"] = cursor - value;
    cursor += (axis === "x" ? box.w : box.h) + gap;
  });
  return result;
}

const SIMPLE_COLOR = /^(?:none|#[\da-fA-F]{3}|#[\da-fA-F]{6})$/;
const SVG_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;

// Rotated arcs cannot be faithfully resized by this editor. Axis-aligned arcs
// (including built-in face/hand artwork) retain their authored geometry.
export function validateSimplePath(d) {
  if (typeof d !== "string" || !/^\s*[Mm]/.test(d)) throw new Error("SVG paths must start with M.");
  const tokens = pathTokens(d);
  if (/^\s*,|,\s*(?:,|[A-Za-z]|$)|[A-Za-z]\s*,/.test(d)) throw new Error("Malformed SVG path separators.");
  const remainder = d.replace(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g, "");
  if (/[^\s,]/.test(remainder)) throw new Error("Unsupported SVG path command.");
  const sizes = { M:2, L:2, H:1, V:1, C:6, S:4, Q:4, T:2, A:7, Z:0 };
  let i = 0;
  while (i < tokens.length) {
    const command = tokens[i++].toUpperCase();
    const size = sizes[command];
    if (size == null) throw new Error("Malformed SVG path command.");
    let count = 0;
    const numbers = [];
    while (i < tokens.length && !/^[a-z]$/i.test(tokens[i])) {
      const value = Number(tokens[i++]);
      if (!Number.isFinite(value)) throw new Error("SVG path coordinates must be finite.");
      numbers.push(value);
      count++;
    }
    if (size ? !count || count % size : count) throw new Error("Malformed SVG path coordinates.");
    if (command === "A") {
      for (let at = 0; at < numbers.length; at += 7) {
        if (numbers[at] < 0 || numbers[at + 1] < 0 || numbers[at + 2] !== 0 ||
            ![0, 1].includes(numbers[at + 3]) || ![0, 1].includes(numbers[at + 4])) {
          throw new Error("SVG arcs require non-negative radii, zero rotation and 0/1 flags.");
        }
      }
    }
  }
  return d;
}

export function validateSimpleShapes(arr) {
  if (!Array.isArray(arr)) throw new Error("Shapes must be an array.");
  for (const s of arr) {
    if (!s || !["rawpath", "path", "ellipse", "rect"].includes(s.type)) throw new Error("Only paths, ellipses and rectangles are supported.");
    if (s.gradient || (s.rotation != null && Number(s.rotation) !== 0)) throw new Error("Gradients and rotation are not supported.");
    if ((s.linecap && s.linecap !== "round") || (s.linejoin && s.linejoin !== "round") ||
        (s.miterlimit != null && Number(s.miterlimit) !== 4) ||
        (s.dasharray != null && !(Array.isArray(s.dasharray) && s.dasharray.length === 0)) ||
        (s.dashoffset != null && Number(s.dashoffset) !== 0)) {
      throw new Error("Only solid strokes with round caps and joins are supported.");
    }
    if (!SIMPLE_COLOR.test(s.fill) || !SIMPLE_COLOR.test(s.stroke)) throw new Error("Use solid #RGB/#RRGGBB colours or none; alpha colours are not supported.");
    if (!Number.isFinite(s.sw) || s.sw < 0) throw new Error("Stroke width must be a non-negative number.");
    const keys = s.type === "ellipse" ? ["cx", "cy", "rx", "ry"] : s.type === "rect" ? ["x", "y", "w", "h"] : s.type === "rawpath" ? ["tx", "ty"] : [];
    if (keys.some(key => !Number.isFinite(s[key]))) throw new Error("Shape coordinates must be finite numbers.");
    if (["rx", "ry", "w", "h"].some(key => s[key] != null && s[key] < 0)) throw new Error("Shape dimensions cannot be negative.");
    if (s.type === "rawpath") validateSimplePath(s.d);
    if (s.type === "path" && (!Array.isArray(s.pts) || s.pts.length < 2 || s.pts.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y)))) {
      throw new Error("Paths need at least two finite points.");
    }
  }
  return arr;
}

// No CSS, references, foreign content or lossy transforms. Viewboxes must start
// at zero; translations must be a single translate(x,y), including on groups.
export function validateSimpleSvg(svgStr) {
  const xml = new DOMParser().parseFromString(svgStr, "image/svg+xml");
  const root = xml.documentElement;
  if (!root || root.localName !== "svg" || xml.querySelector("parsererror") || xml.doctype) {
    throw new Error("Malformed SVG: expected an SVG document without a DOCTYPE.");
  }
  const geometry = {
    svg:["width", "height", "viewBox", "version"],
    g:[], path:["d"], rect:["x", "y", "width", "height"],
    circle:["cx", "cy", "r"], ellipse:["cx", "cy", "rx", "ry"],
    line:["x1", "y1", "x2", "y2"], polygon:["points"], polyline:["points"],
  };
  const common = ["id", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "transform"];
  const number = (value, label, nonnegative = false) => {
    if (!SVG_NUMBER.test(value) || !Number.isFinite(Number(value)) || (nonnegative && Number(value) < 0)) throw new Error(`Invalid SVG ${label}: use finite unitless numbers.`);
  };
  for (const node of [xml, root, ...root.querySelectorAll("*")]) {
    for (const child of node.childNodes) {
      if (child.nodeType === 7 || ((child.nodeType === 3 || child.nodeType === 4) && child.textContent.trim())) throw new Error("Unsupported SVG text or processing instruction.");
    }
    if (node === xml) continue;
    const tag = node.localName;
    if (!Object.hasOwn(geometry, tag) || (tag === "svg" && node !== root) ||
        (node.namespaceURI && node.namespaceURI !== "http://www.w3.org/2000/svg")) throw new Error(`Unsupported SVG element: ${node.nodeName}.`);
    for (const attr of node.attributes) {
      const name = attr.name, value = attr.value.trim();
      if (name === "xmlns" && value === "http://www.w3.org/2000/svg") continue;
      if (![...common, ...geometry[tag]].includes(name)) throw new Error(`Unsupported SVG attribute: ${name}. Use plain geometry and presentation attributes, not styles or references.`);
      if (name === "fill" || name === "stroke") {
        if (!SIMPLE_COLOR.test(value)) throw new Error("SVG paint must be solid #RGB/#RRGGBB or none; alpha colours, gradients and named colours are unsupported.");
      } else if (name === "stroke-linecap" || name === "stroke-linejoin") {
        if (value !== "round") throw new Error("SVG strokes support only round caps and joins.");
      } else if (name === "transform") {
        const match = value.match(/^translate\(\s*(-?(?:\d+\.?\d*|\.\d+))[,\s]\s*(-?(?:\d+\.?\d*|\.\d+))\s*\)$/);
        if (node === root || !match || !match.slice(1).every(v => Number.isFinite(Number(v)))) throw new Error("Only a single translate(x,y) on a shape or group is supported.");
      } else if (name === "viewBox") {
        const parts = value.split(/[\s,]+/);
        if (parts.length !== 4) throw new Error("SVG viewBox must contain four numbers.");
        parts.forEach(v => number(v, name));
        if (Number(parts[0]) || Number(parts[1]) || Number(parts[2]) <= 0 || Number(parts[3]) <= 0) throw new Error("SVG viewBox must start at 0 0 and have positive dimensions.");
      } else if (name === "d") {
        validateSimplePath(value);
      } else if (name === "points") {
        const parts = value.split(/[\s,]+/);
        if (parts.length < (tag === "polygon" ? 6 : 4) || parts.length % 2) throw new Error("SVG points must contain complete coordinate pairs.");
        parts.forEach(v => number(v, name));
      } else if (name !== "id" && name !== "version") {
        number(value, name, ["width", "height", "r", "rx", "ry", "stroke-width"].includes(name));
      }
    }
    const required = { path:["d"], polygon:["points"], polyline:["points"], rect:["width", "height"], circle:["r"], ellipse:["rx", "ry"] }[tag] || [];
    if (required.some(name => !node.hasAttribute(name))) throw new Error(`SVG ${tag} is missing required geometry.`);
    if (node !== root && tag !== "g" && node.children.length) throw new Error("Only SVG groups may contain shapes.");
  }
  return root;
}

const TOOL_STATUS = {
  select:  "Select: click · drag to move · arrows nudge · vertex dots drag · Delete removes",
  navigate:"Navigate: drag to pan · wheel to zoom · double-click to reset view",
  eyedropper:"Eyedropper: click a shape to sample its fill and stroke",
  fill:    "Fill: click a shape to apply the current fill",
  gradient:"Gradient: drag across a shape to apply a linear gradient",
  pen:     "Pen: click to add anchors · dbl-click or click start to close · Backspace removes last",
  freehand:"Freehand: drag to draw a smooth path",
  spline:  "Spline: click anchors · double-click to finish a smooth open curve",
  line:    "Line: drag to draw · Shift snaps to 45°",
  ellipse: "Ellipse: drag to draw · Shift = circle",
  rect:    "Rect: drag to draw · Shift = square",
  polygon: "Polygon: drag to draw · sides are set in tool options",
  star:    "Star: drag to draw · points are set in tool options",
  arrow:   "Arrow: drag from tail to tip",
  spiral:  "Spiral: drag to draw · turns are set in tool options",
  grid:    "Grid: drag to draw · rows and columns are set in tool options",
  text:    "Text: click to insert editable vector text",
};

// ─────────────────── Focus tracking (one active editor at a time) ─────────────

let _focusedUid = null;   // uid of the editor that most recently received a mousedown

// ─────────────────── Factory ──────────────────────────────────────────────────

let _instCounter = 0;

export function createSvgEditor(containerEl, opts = {}) {
  const uid = `se${++_instCounter}`;
  const CW  = opts.canvasWidth  ?? 540;
  const CH  = opts.canvasHeight ?? opts.height ?? 405;
  const simplePaths = opts.simplePaths === true;
  const reportError = error => {
    if (opts.onError) opts.onError(error);
    else if (q("status")) q("status").textContent = error.message;
    return false;
  };

  // ── Instance state ─────────────────────────────────────────────────────────
  let svgEl = null;
  let shapes = [], sel = null, selectedIds = new Set(), undoStack = [];
  let _idSeq = 0;
  const localId = () => `${uid}_s${++_idSeq}`;
  let activeTool = "select";
  let fillColor = "#fce4d6", strokeColor = "#5c3a2e", strokeW = 2;
  let fillNone = false, strokeNone = false;
  let draft = null, penPts = [], penHover = null, drag = null;
  let redoStack = [], clipboardShape = null;
  let shapeSides = 5, spiralTurns = 3, gridSize = 4;
  let view = { x: 0, y: 0, zoom: 1 };

  // ── DOM helper: query by data-ed role within this instance's container ──────
  const q = role => containerEl.querySelector(`[data-ed="${uid}:${role}"]`);

  // ── Undo ───────────────────────────────────────────────────────────────────
  function pushUndo() {
    undoStack.push(deepCloneShapes(shapes));
    if (undoStack.length > 60) undoStack.shift();
    redoStack = [];
  }
  function doUndo() {
    if (!undoStack.length) return;
    redoStack.push(deepCloneShapes(shapes));
    shapes = undoStack.pop(); setSelection([]); render();
  }
  function doRedo() {
    if (!redoStack.length) return;
    undoStack.push(deepCloneShapes(shapes));
    shapes = redoStack.pop(); setSelection([]); render();
  }

  // ── SVG coord mapping ──────────────────────────────────────────────────────
  function svgCoords(ev) {
    const pt = svgEl.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const canvas = pt.matrixTransform(svgEl.getScreenCTM().inverse());
    return { x: (canvas.x - view.x) / view.zoom, y: (canvas.y - view.y) / view.zoom };
  }

  // ── Hit test ───────────────────────────────────────────────────────────────
  function hitTest(x, y) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.type === "ellipse") {
        const dx = (x-s.cx)/(s.rx+4), dy = (y-s.cy)/(s.ry+4);
        if (dx*dx+dy*dy <= 1) return s.id;
      } else if (s.type === "rect") {
        if (x >= s.x-4 && x <= s.x+s.w+4 && y >= s.y-4 && y <= s.y+s.h+4) return s.id;
      } else if (s.type === "path" || s.type === "rawpath" || s.type === "text") {
        const bb = bboxShape(s), pad = Math.max(8, (s.sw||2)*2);
        if (x >= bb.x-pad && x <= bb.x+bb.w+pad && y >= bb.y-pad && y <= bb.y+bb.h+pad) return s.id;
      }
    }
    return null;
  }

  // ── SVG markup builders ────────────────────────────────────────────────────
  function gradientMarkup(s) {
    if (!s.gradient) return "";
    const id = `${uid}_gradient_${s.id}`;
    const { from, to, stops } = s.gradient;
    return `<linearGradient id="${xmlAttr(id)}" gradientUnits="userSpaceOnUse" x1="${rn(from.x)}" y1="${rn(from.y)}" x2="${rn(to.x)}" y2="${rn(to.y)}">${stops.map(stop =>
      `<stop offset="${rn(stop.offset * 100)}%" stop-color="${xmlAttr(stop.color)}"/>`
    ).join("")}</linearGradient>`;
  }

  function shapeFill(s) {
    return s.gradient ? `url(#${uid}_gradient_${s.id})` : s.fill;
  }

  function shapeMarkup(s, selected, showHandles = selected) {
    const f = xmlAttr(shapeFill(s)), sk = xmlAttr(s.stroke);
    const sw = `stroke-width="${rn(s.sw)}" ${strokeAttributeString(s)}`;
    const bb = bboxShape(s);
    const rotation = Number(s.rotation || 0);
    const rotationTransform = rotation
      ? ` rotate(${rn(rotation)} ${rn(bb.x + bb.w / 2)} ${rn(bb.y + bb.h / 2)})`
      : "";
    let el;
    if (s.type === "ellipse") {
      el = `<ellipse cx="${rn(s.cx)}" cy="${rn(s.cy)}" rx="${rn(s.rx)}" ry="${rn(s.ry)}" fill="${f}" stroke="${sk}" ${sw}${rotation ? ` transform="rotate(${rn(rotation)} ${rn(bb.x + bb.w / 2)} ${rn(bb.y + bb.h / 2)})"` : ""}/>`;
    } else if (s.type === "rect") {
      el = `<rect x="${rn(s.x)}" y="${rn(s.y)}" width="${rn(s.w)}" height="${rn(s.h)}" fill="${f}" stroke="${sk}" ${sw}${rotation ? ` transform="rotate(${rn(rotation)} ${rn(bb.x + bb.w / 2)} ${rn(bb.y + bb.h / 2)})"` : ""}/>`;
    } else if (s.type === "rawpath") {
      el = `<path d="${xmlAttr(s.d)}" fill="${f}" stroke="${sk}" ${sw} transform="translate(${rn(s.tx)},${rn(s.ty)})${rotationTransform}"/>`;
    } else if (s.type === "text") {
      el = `<text x="${rn(s.x)}" y="${rn(s.y)}" fill="${f}" stroke="${sk}" ${sw} font-family="${xmlAttr(s.fontFamily || "sans-serif")}" font-size="${rn(s.fontSize || 24)}" font-weight="${xmlAttr(s.fontWeight || "400")}"${rotation ? ` transform="rotate(${rn(rotation)} ${rn(bb.x + bb.w / 2)} ${rn(bb.y + bb.h / 2)})"` : ""}>${xmlAttr(s.text || "")}</text>`;
    } else {
      const d = buildPathD(s.pts, s.closed, s.smooth !== false);
      el = `<path d="${d}" fill="${f}" stroke="${sk}" ${sw} stroke-linejoin="round" stroke-linecap="round"${rotation ? ` transform="rotate(${rn(rotation)} ${rn(bb.x + bb.w / 2)} ${rn(bb.y + bb.h / 2)})"` : ""}/>`;
    }
    el = el.replace('stroke-linejoin="round" stroke-linecap="round"', strokeAttributeString(s));
    if (!selected) return el;
    const pad = 5;
    const selBox = `<rect x="${rn(bb.x-pad)}" y="${rn(bb.y-pad)}" width="${rn(bb.w+pad*2)}" height="${rn(bb.h+pad*2)}" fill="none" stroke="#0099FF" stroke-width="1" stroke-dasharray="5 2" rx="2" pointer-events="none"/>`;
    let handles = "";
    if (!showHandles) return el + selBox;
    if (s.type === "path") {
      handles = s.pts.map((p, vi) =>
        `<circle class="vtxHdl" data-sid="${xmlAttr(s.id)}" data-vi="${vi}" cx="${rn(p.x)}" cy="${rn(p.y)}" r="5" fill="#0099FF" stroke="#fff" stroke-width="1.5" style="cursor:move" pointer-events="all"/>`
      ).join("");
    } else if (s.type === "rawpath") {
      // An imported path (a mouth viseme, or layer artwork) is edited on its
      // OWN nodes: the curve keeps the exact commands it arrived with, which is
      // what lets a reshaped viseme still morph into its neighbours.
      const pts = rawPoints(s);
      handles = pts.map((p, vi) => {
        const cx = rn(p.x + s.tx), cy = rn(p.y + s.ty);
        if (p.anchor) {
          return `<circle class="vtxHdl" data-sid="${xmlAttr(s.id)}" data-vi="${vi}" data-raw="1" cx="${cx}" cy="${cy}" r="5" fill="#0099FF" stroke="#fff" stroke-width="1.5" style="cursor:move" pointer-events="all"/>`;
        }
        // A control point is drawn tethered to the anchor it bends, so the two
        // read as one handle rather than a loose dot.
        const host = pts[vi+1]?.anchor ? pts[vi+1] : pts[vi-1]?.anchor ? pts[vi-1] : null;
        const leash = host
          ? `<line x1="${cx}" y1="${cy}" x2="${rn(host.x + s.tx)}" y2="${rn(host.y + s.ty)}" stroke="#F59E0B" stroke-width="1" stroke-dasharray="2 2" opacity="0.7" pointer-events="none"/>`
          : "";
        return leash + `<circle class="vtxHdl" data-sid="${xmlAttr(s.id)}" data-vi="${vi}" data-raw="1" cx="${cx}" cy="${cy}" r="3.5" fill="#F59E0B" stroke="#fff" stroke-width="1" style="cursor:move" pointer-events="all"/>`;
      }).join("");
    }
    const corners = [
      ["nw", bb.x-pad, bb.y-pad], ["ne", bb.x+bb.w+pad, bb.y-pad],
      ["se", bb.x+bb.w+pad, bb.y+bb.h+pad], ["sw", bb.x-pad, bb.y+bb.h+pad],
    ];
    handles += corners.map(([corner, x, y]) =>
      `<rect class="resizeHdl" data-sid="${xmlAttr(s.id)}" data-corner="${corner}" x="${rn(x-4)}" y="${rn(y-4)}" width="8" height="8" fill="#fff" stroke="#0099FF" stroke-width="1.5" style="cursor:${corner}-resize" pointer-events="all"/>`
    ).join("");
    if (!simplePaths) {
      handles += `<circle class="rotateHdl" data-sid="${xmlAttr(s.id)}" cx="${rn(bb.x + bb.w / 2)}" cy="${rn(bb.y - pad - 22)}" r="6" fill="#fff" stroke="#0099FF" stroke-width="1.5" style="cursor:grab" pointer-events="all"/>`;
      handles += `<line x1="${rn(bb.x + bb.w / 2)}" y1="${rn(bb.y - pad)}" x2="${rn(bb.x + bb.w / 2)}" y2="${rn(bb.y - pad - 22)}" stroke="#0099FF" stroke-width="1" pointer-events="none"/>`;
    }
    return el + selBox + handles;
  }

  // The editable nodes of a raw path, cached per `d` so a drag that re-renders
  // on every mousemove re-parses nothing.
  let _rawCache = { d: null, pts: [] };
  function rawPoints(s) {
    if (!isEditablePath(s.d)) return [];
    if (_rawCache.d !== s.d) _rawCache = { d: s.d, pts: pathPoints(s.d) };
    return _rawCache.pts;
  }

  // Which nodes a drag on node `vi` takes with it.  A control point moves
  // alone; an anchor carries the controls that bend the curve into it, and any
  // twin anchor sitting on the same spot — a closed path repeats its start
  // point, and moving only one of the pair would tear the shape open.
  function linkedRawPoints(pts, vi) {
    const p = pts[vi];
    const idx = new Set([vi]);
    if (!p?.anchor) return idx;
    pts.forEach((q, j) => {
      if (!q.anchor || Math.hypot(q.x - p.x, q.y - p.y) > 0.01) return;
      idx.add(j);
      if (pts[j-1] && !pts[j-1].anchor) idx.add(j-1);
      if (pts[j+1] && !pts[j+1].anchor) idx.add(j+1);
    });
    return idx;
  }

  function draftMarkup() {
    if (!draft) return "";
    if (draft.type === "ellipse") {
      return `<ellipse cx="${rn(draft.cx)}" cy="${rn(draft.cy)}" rx="${rn(draft.rx)}" ry="${rn(draft.ry)}" fill="${draft.fill}" stroke="${draft.stroke}" stroke-width="${strokeW}" opacity="0.65"/>`;
    }
    if (draft.type === "rect") {
      return `<rect x="${rn(draft.x)}" y="${rn(draft.y)}" width="${rn(draft.w)}" height="${rn(draft.h)}" fill="${draft.fill}" stroke="${draft.stroke}" stroke-width="${strokeW}" opacity="0.65"/>`;
    }
    if (draft.type === "rawpath") {
      return `<path d="${xmlAttr(draft.d)}" fill="${xmlAttr(draft.fill)}" stroke="${xmlAttr(draft.stroke)}" stroke-width="${strokeW}" stroke-linejoin="round" stroke-linecap="round" opacity="0.65"/>`;
    }
    if (draft.type === "path") {
      return `<path d="${buildPathD(draft.pts, draft.closed, draft.smooth !== false)}" fill="${xmlAttr(draft.fill)}" stroke="${xmlAttr(draft.stroke)}" stroke-width="${strokeW}" stroke-linejoin="round" stroke-linecap="round" opacity="0.65"/>`;
    }
    return "";
  }

  function penMarkup() {
    if (!penPts.length) return "";
    const pts = penHover ? [...penPts, penHover] : penPts;
    const pathStr = pts.length >= 2
      ? `<path d="${buildPathD(pts, false, pts.length >= 3)}" fill="none" stroke="${strokeColor}" stroke-width="${strokeW}" stroke-dasharray="6 3" stroke-linecap="round" opacity="0.8"/>`
      : "";
    const dots = pts.map((p, i) =>
      `<circle cx="${rn(p.x)}" cy="${rn(p.y)}" r="${i===0?5:3}" fill="${i<penPts.length?"#0099FF":"#999"}" stroke="${i===0?"#0099FF":"#fff"}" stroke-width="${i===0?1.5:1}" pointer-events="none"/>`
    ).join("");
    const ring = penPts.length >= 3
      ? `<circle cx="${rn(penPts[0].x)}" cy="${rn(penPts[0].y)}" r="9" fill="none" stroke="#0099FF" stroke-width="1" opacity="0.5" pointer-events="none"/>`
      : "";
    return pathStr + ring + dots;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    if (!svgEl) return;
    const viewportTransform = `translate(${rn(view.x)},${rn(view.y)}) scale(${rn(view.zoom, 3)})`;
    svgEl.innerHTML = `
      <rect width="${CW}" height="${CH}" fill="#ffffff"/>
      <rect width="${CW}" height="${CH}" fill="none" stroke="#e5e7eb" stroke-width="1"/>
      <defs>${shapes.map(gradientMarkup).join("")}</defs>
      <g data-svg-editor-viewport transform="${viewportTransform}">
        ${shapes.map(s => shapeMarkup(s, selectedIds.has(s.id), s.id === sel)).join("\n")}
        ${draftMarkup()}
        ${penMarkup()}
      </g>
    `;
    svgEl.querySelectorAll(".vtxHdl").forEach(el => el.addEventListener("mousedown", onVtxDown));
    svgEl.querySelectorAll(".resizeHdl").forEach(el => el.addEventListener("mousedown", onResizeDown));
    svgEl.querySelectorAll(".rotateHdl").forEach(el => el.addEventListener("mousedown", onRotateDown));
    syncColorPickersToSel();
    renderShapeList();
  }

  function syncColorPickersToSel() {
    const s = shapes.find(sh => sh.id === sel);
    const fi = q("fill"), si = q("stroke"), wi = q("sw");
    if (!fi) return;
    const transparent = s ? s.fill === "none" && !s.gradient : fillNone;
    const color = s ? s.gradient?.stops[0]?.color || s.fill : fillColor;
    if (/^#[\da-f]{1,8}$/i.test(color)) fi.value = normHex6(color);
    fi.style.opacity = transparent ? "0.35" : "1";
    const noFill = q("fillNone");
    noFill.setAttribute("aria-pressed", String(transparent));
    noFill.classList.toggle("bg-primary/20", transparent);
    noFill.classList.toggle("text-primary", transparent);
    if (!s) return;
    if (s.stroke !== "none") { if (/^#[\da-f]{1,8}$/i.test(s.stroke)) si.value = normHex6(s.stroke); si.style.opacity = "1"; }
    else                       si.style.opacity = "0.35";
    if (wi) wi.value = s.sw;
    const cap = q("linecap"), join = q("linejoin"), dash = q("dash");
    const miter = q("miter"), offset = q("dashoffset");
    if (cap) cap.value = s.linecap || "round";
    if (join) join.value = s.linejoin || "round";
    if (dash) dash.value = normalizeDasharray(s.dasharray).join(" ");
    if (miter) miter.value = s.miterlimit ?? 4;
    if (offset) offset.value = s.dashoffset ?? 0;
  }

  function renderShapeList() {
    const listEl = q("shapeList");
    if (!listEl) return;
    listEl.replaceChildren();
    if (!shapes.length) {
      const empty = document.createElement("div");
      empty.className = "text-[10px] text-text-secondary px-2 py-2 leading-relaxed";
      empty.append("Draw shapes", document.createElement("br"), "on the canvas.");
      listEl.append(empty);
      return;
    }
    shapes.forEach((s, idx) => {
      const isSel = selectedIds.has(s.id);
      const row = document.createElement("div");
      row.className = `flex items-center gap-1 px-2 py-0.5 rounded cursor-pointer text-[11px] select-none ${isSel ? "bg-primary/20 text-primary font-medium" : "text-text-secondary hover:bg-surface-container"}`;
      row.dataset.sid = s.id;
      const chip = document.createElement("span");
      if (s.type === "ellipse" || s.type === "rect") {
        Object.assign(chip.style, {
          display: "inline-block",
          width: s.type === "ellipse" ? "12px" : "11px",
          height: s.type === "ellipse" ? "8px" : "9px",
          borderRadius: s.type === "ellipse" ? "50%" : "1px",
          background: s.fill === "none" ? "transparent" : s.fill,
          border: `1.5px solid ${s.stroke === "none" ? "#888" : s.stroke}`,
        });
      } else {
        chip.className = "material-symbols-outlined text-[12px]";
        chip.textContent = "gesture";
      }
      const label = document.createElement("span");
      label.className = "truncate flex-1";
      label.textContent = `${s.kind || s.type} ${idx + 1}`;
      row.append(chip, label);
      row.addEventListener("click", () => {
        sel = row.dataset.sid;
        selectedIds = new Set([sel]);
        setEditorTool("select");
        render();
      });
      listEl.append(row);
    });
  }

  // ── Tool switcher ──────────────────────────────────────────────────────────
  function setEditorTool(t) {
    if (simplePaths && ["text", "gradient"].includes(t)) return;
    activeTool = t;
    [
      "select","navigate","eyedropper","fill","gradient","pen","freehand","spline",
      "line","ellipse","rect","polygon","star","arrow","spiral","grid","text",
    ].forEach(id => {
      const btn = q(`tool-${id}`);
      if (!btn) return;
      btn.classList.toggle("bg-primary/20", id === t);
      btn.classList.toggle("text-primary",  id === t);
      btn.classList.toggle("text-text-secondary", id !== t);
    });
    if (svgEl) svgEl.style.cursor = t === "select" ? "default" : t === "navigate" ? "grab" : "crosshair";
    const st = q("status");
    if (st) st.textContent = TOOL_STATUS[t] ?? "";
    if (!["pen", "spline"].includes(t) && penPts.length) { penPts = []; penHover = null; render(); }
  }

  function currentPaint() {
    return {
      fill: fillNone ? "none" : fillColor,
      stroke: strokeNone ? "none" : strokeColor,
      sw: strokeW,
      linecap: "round",
      linejoin: "round",
      miterlimit: 4,
      dasharray: [],
      dashoffset: 0,
    };
  }

  function selectedShapes() {
    return shapes.filter(s => selectedIds.has(s.id));
  }

  function setSelection(ids, primary = ids.at(-1) || null) {
    selectedIds = new Set(ids);
    sel = selectedIds.has(primary) ? primary : selectedIds.values().next().value || null;
  }

  function moveSelected(dx, dy) {
    selectedShapes().forEach(s => moveShape(s, dx, dy));
  }

  function applySelectionLayout(mode) {
    const items = selectedShapes();
    if (items.length < 2) return;
    const boxes = items.map(bboxShape);
    const offsets = mode === "distribute-x" ? distributeBBoxes(boxes, "x")
      : mode === "distribute-y" ? distributeBBoxes(boxes, "y")
      : alignBBoxes(boxes, mode);
    pushUndo();
    items.forEach((shape, index) => moveShape(shape, offsets[index].dx, offsets[index].dy));
    render();
  }

  function pathDraft(kind, pts, closed, smooth = false) {
    return { type: "path", kind, pts, closed, smooth, ...currentPaint() };
  }

  function updateDragDraft(x, y, shift) {
    const x0 = draft.x0, y0 = draft.y0;
    let dx = x - x0, dy = y - y0;
    if (shift && draft.kind === "line") {
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
      const length = Math.hypot(dx, dy);
      dx = Math.cos(angle) * length; dy = Math.sin(angle) * length;
      x = x0 + dx; y = y0 + dy;
    }
    const left = Math.min(x0, x), top = Math.min(y0, y);
    let w = Math.abs(dx), h = Math.abs(dy);
    if (shift && ["ellipse", "rect", "polygon", "star"].includes(draft.kind)) {
      const size = Math.max(w, h);
      w = h = size;
      x = x0 + Math.sign(dx || 1) * size;
      y = y0 + Math.sign(dy || 1) * size;
    }
    const cx = (x0 + x) / 2, cy = (y0 + y) / 2;
    if (draft.kind === "ellipse") {
      Object.assign(draft, { type:"ellipse", cx, cy, rx:w/2, ry:h/2 });
    } else if (draft.kind === "rect") {
      Object.assign(draft, { type:"rect", x:Math.min(x0,x), y:Math.min(y0,y), w, h });
    } else if (draft.kind === "line") {
      Object.assign(draft, pathDraft("line", [{x:x0,y:y0},{x,y}], false, false));
      draft.x0=x0; draft.y0=y0;
      draft.fill = "none";
    } else if (draft.kind === "polygon") {
      Object.assign(draft, pathDraft("polygon", regularPolygonPoints(cx,cy,w/2,h/2,shapeSides), true, false));
      draft.x0=x0; draft.y0=y0;
    } else if (draft.kind === "star") {
      Object.assign(draft, pathDraft("star", starPoints(cx,cy,w/2,h/2,shapeSides), true, false));
      draft.x0=x0; draft.y0=y0;
    } else if (draft.kind === "arrow") {
      Object.assign(draft, pathDraft("arrow", arrowPoints(x0,y0,x,y,Math.max(10,Math.min(28,Math.hypot(dx,dy)/6))), true, false));
      draft.x0=x0; draft.y0=y0;
    } else if (draft.kind === "spiral") {
      Object.assign(draft, pathDraft("spiral", spiralPoints(cx,cy,w/2,h/2,spiralTurns), false, false));
      draft.x0=x0; draft.y0=y0; draft.fill="none";
    } else if (draft.kind === "grid") {
      Object.assign(draft, { type:"rawpath", kind:"grid", d:gridPathD(left,top,w,h,gridSize,gridSize), tx:0, ty:0, ...currentPaint(), fill:"none", x0, y0 });
    }
  }

  function resizeShape(shape, original, anchor, sx, sy) {
    if (simplePaths && original.type === "rawpath" && /[Aa]/.test(original.d)) {
      // Crossing the resize anchor would require reflecting arc sweep flags.
      sx = Math.max(0.01, sx); sy = Math.max(0.01, sy);
    }
    const tx = x => rn(anchor.x + (x - anchor.x) * sx);
    const ty = y => rn(anchor.y + (y - anchor.y) * sy);
    if (original.type === "ellipse") {
      const x1=tx(original.cx-original.rx), x2=tx(original.cx+original.rx);
      const y1=ty(original.cy-original.ry), y2=ty(original.cy+original.ry);
      shape.cx=rn((x1+x2)/2); shape.cy=rn((y1+y2)/2);
      shape.rx=rn(Math.abs(x2-x1)/2); shape.ry=rn(Math.abs(y2-y1)/2);
    } else if (original.type === "rect") {
      const x1=tx(original.x), x2=tx(original.x+original.w);
      const y1=ty(original.y), y2=ty(original.y+original.h);
      shape.x=Math.min(x1,x2); shape.y=Math.min(y1,y2);
      shape.w=rn(Math.abs(x2-x1)); shape.h=rn(Math.abs(y2-y1));
    } else if (original.type === "path") {
      shape.pts=original.pts.map(p=>({x:tx(p.x),y:ty(p.y)}));
    } else if (original.type === "rawpath") {
      shape.d=scalePathD(original.d,sx,sy,anchor.x*(1-sx)+original.tx*sx,anchor.y*(1-sy)+original.ty*sy);
      shape.tx=0; shape.ty=0;
    } else if (original.type === "text") {
      shape.x=tx(original.x); shape.y=ty(original.y);
      shape.fontSize=rn((original.fontSize||24)*Math.max(0.05,(Math.abs(sx)+Math.abs(sy))/2));
    }
    if (original.gradient) {
      shape.gradient = {
        ...original.gradient,
        from:{x:tx(original.gradient.from.x),y:ty(original.gradient.from.y)},
        to:{x:tx(original.gradient.to.x),y:ty(original.gradient.to.y)},
        stops:original.gradient.stops.map(stop=>({...stop})),
      };
    }
  }

  // ── Mouse handlers ─────────────────────────────────────────────────────────
  function onMouseDown(ev) {
    _focusedUid = uid;
    if (ev.target.classList.contains("vtxHdl") || ev.target.classList.contains("resizeHdl")) return;
    if (ev.button !== 0) return;
    ev.preventDefault();
    const { x, y } = svgCoords(ev);

    if (activeTool === "navigate") {
      drag = { mode:"pan", clientX:ev.clientX, clientY:ev.clientY, x0:view.x, y0:view.y };
      svgEl.style.cursor = "grabbing";
      return;
    }

    if (["eyedropper", "fill"].includes(activeTool)) {
      const id = hitTest(x, y);
      const s = shapes.find(shape => shape.id === id);
      if (!s) return;
      setSelection([id], id);
      if (activeTool === "eyedropper") {
        fillColor = s.gradient?.stops[0]?.color || s.fill;
        strokeColor = s.stroke;
        strokeW = s.sw;
        fillNone = fillColor === "none";
        strokeNone = strokeColor === "none";
      } else {
        pushUndo();
        s.fill = fillNone ? "none" : fillColor;
        delete s.gradient;
      }
      render(); return;
    }
    if (activeTool === "gradient") {
      const id = hitTest(x, y);
      if (!id) return;
      setSelection([id], id);
      drag = { mode:"gradient", id, x0:x, y0:y };
      return;
    }

    if (activeTool === "select") {
      const id = hitTest(x, y);
      if (id) {
        if (ev.shiftKey) {
          const next = new Set(selectedIds);
          if (next.has(id)) next.delete(id); else next.add(id);
          setSelection([...next], id);
        } else {
          setSelection([id], id);
        }
        const s = shapes.find(sh => sh.id === id);
        drag = { mode:"move", id, ids:[...selectedIds], ox:x, oy:y };
        drag.originals = selectedShapes().map(shape => deepCloneShapes([shape])[0]);
        if (s.gradient) drag.gradient=deepCloneShapes([s])[0].gradient;
        if (s.type === "ellipse")    { drag.cx0=s.cx; drag.cy0=s.cy; }
        else if (s.type === "rect")  { drag.x0=s.x; drag.y0=s.y; }
        else if (s.type === "path")  { drag.pts0=s.pts.map(p=>({...p})); }
        else if (s.type === "rawpath") { drag.tx0=s.tx; drag.ty0=s.ty; }
        else if (s.type === "text") { drag.x0=s.x; drag.y0=s.y; }
      } else {
        if (!ev.shiftKey) setSelection([]);
      }
      render(); return;
    }

    if (["ellipse","rect","line","polygon","star","arrow","spiral","grid"].includes(activeTool)) {
      draft = {
        type: activeTool, kind: activeTool, x0:x, y0:y,
        ...currentPaint(),
        cx:x, cy:y, rx:0, ry:0, x, y, w:0, h:0,
      };
      return;
    }

    if (activeTool === "pen" || activeTool === "spline") {
      if (penPts.length >= 3) {
        const fp = penPts[0];
        if (Math.hypot(x-fp.x, y-fp.y) < 10) { commitPen(true); return; }
      }
      penPts = [...penPts, {x, y}]; penHover = null; render();
      return;
    }

    if (activeTool === "freehand") {
      draft = pathDraft("freehand", [{x,y}], false, true);
      draft.x0=x; draft.y0=y;
      return;
    }

    if (activeTool === "text") {
      const text = prompt("Text");
      if (!text) return;
      pushUndo();
      shapes.push({ id:localId(), type:"text", text, x:rn(x), y:rn(y), fontSize:32, fontFamily:"sans-serif", fontWeight:"400", ...currentPaint(), stroke:"none", sw:0 });
      setSelection([shapes.at(-1).id], shapes.at(-1).id);
      render();
    }
  }

  function onMouseMove(ev) {
    const { x, y } = svgCoords(ev);
    const shift = ev.shiftKey;

    if (drag && drag.mode === "pan") {
      view.x = drag.x0 + ev.clientX - drag.clientX;
      view.y = drag.y0 + ev.clientY - drag.clientY;
      render(); return;
    }
    if (drag && drag.mode === "gradient") {
      const s = shapes.find(sh => sh.id === drag.id);
      if (!s) return;
      if (!drag.pushed) { pushUndo(); drag.pushed = true; }
      s.gradient = {
        type: "linear",
        from: { x: drag.x0, y: drag.y0 },
        to: { x, y },
        stops: [
          { offset: 0, color: fillNone ? "#ffffff" : fillColor },
          { offset: 1, color: strokeNone ? "#000000" : strokeColor },
        ],
      };
      render(); return;
    }
    if (drag && drag.mode === "resize") {
      const s = shapes.find(sh => sh.id === drag.id);
      if (!s) return;
      if (!drag.pushed) { pushUndo(); drag.pushed = true; }
      const sx = (drag.handle.x + x - drag.pointer.x - drag.anchor.x) / (drag.handle.x - drag.anchor.x || 1);
      const sy = (drag.handle.y + y - drag.pointer.y - drag.anchor.y) / (drag.handle.y - drag.anchor.y || 1);
      resizeShape(s, drag.original, drag.anchor, shift ? Math.sign(sx || 1) * Math.max(Math.abs(sx), Math.abs(sy)) : sx,
        shift ? Math.sign(sy || 1) * Math.max(Math.abs(sx), Math.abs(sy)) : sy);
      render(); return;
    }
    if (drag && drag.mode === "rotate") {
      const s = shapes.find(sh => sh.id === drag.id);
      if (!s) return;
      if (!drag.pushed) { pushUndo(); drag.pushed = true; }
      let rotation = drag.rotation0
        + (Math.atan2(y - drag.cy, x - drag.cx) - drag.startAngle) * 180 / Math.PI;
      if (shift) rotation = Math.round(rotation / 15) * 15;
      s.rotation = rn(rotation % 360);
      render(); return;
    }
    if (drag && drag.mode === "vertex") {
      const dx = x-drag.ox, dy = y-drag.oy;
      const s = shapes.find(sh => sh.id === drag.id);
      if (s && s.type === "path") {
        if (!drag.pushed) { pushUndo(); drag.pushed = true; }
        s.pts[drag.vi]={x:rn(drag.px0+dx),y:rn(drag.py0+dy)}; render();
      }
      return;
    }
    if (drag && drag.mode === "rawvtx") {
      const dx = x-drag.ox, dy = y-drag.oy;
      const s = shapes.find(sh => sh.id === drag.id);
      if (!s || s.type !== "rawpath") return;
      // Snapshot on the first pixel of movement, not on mousedown: a click
      // that selects a node should not fill the undo stack, and the snapshot
      // must still predate the edit.
      if (!drag.pushed) { pushUndo(); drag.pushed = true; }
      const next = drag.pts0.map((p, j) =>
        drag.moving.has(j) ? { ...p, x: p.x + dx, y: p.y + dy } : p);
      s.d = withPathPoints(s.d, next);
      render(); return;
    }
    if (drag && drag.mode === "move") {
      const dx = x-drag.ox, dy = y-drag.oy;
      const moving = shapes.filter(sh => drag.ids.includes(sh.id));
      if (!moving.length) return;
      if (!drag.pushed) { pushUndo(); drag.pushed = true; }
      moving.forEach((s, index) => {
        const original = drag.originals[index];
        Object.assign(s, deepCloneShapes([original])[0]);
        moveShape(s, dx, dy);
      });
      render(); return;
    }
    if (draft) {
      if (draft.kind === "freehand") {
        const last = draft.pts.at(-1);
        if (!last || Math.hypot(x-last.x,y-last.y) >= 2) draft.pts.push({x:rn(x),y:rn(y)});
      } else {
        updateDragDraft(x, y, shift);
      }
      render(); return;
    }
    if (["pen", "spline"].includes(activeTool) && penPts.length) { penHover={x,y}; render(); }
  }

  function onMouseUp(ev) {
    if (drag) {
      if (drag.mode === "pan" && svgEl) svgEl.style.cursor = "grab";
      drag = null; return;
    }
    if (draft) {
      const minPx = 3;
      if (draft.type==="ellipse" && draft.rx>=minPx && draft.ry>=minPx) {
        pushUndo();
        shapes.push({id:localId(),type:"ellipse",cx:rn(draft.cx),cy:rn(draft.cy),rx:rn(draft.rx),ry:rn(draft.ry),fill:draft.fill,stroke:draft.stroke,sw:draft.sw});
        setSelection([shapes[shapes.length-1].id], shapes[shapes.length-1].id);
      } else if (draft.type==="rect" && draft.w>=minPx && draft.h>=minPx) {
        pushUndo();
        shapes.push({id:localId(),type:"rect",x:rn(draft.x),y:rn(draft.y),w:rn(draft.w),h:rn(draft.h),fill:draft.fill,stroke:draft.stroke,sw:draft.sw});
        setSelection([shapes[shapes.length-1].id], shapes[shapes.length-1].id);
      } else if (draft.type==="path" && draft.pts.length >= 2) {
        pushUndo();
        shapes.push({...draft,id:localId(),pts:draft.pts.map(({x,y})=>({x:rn(x),y:rn(y)}))});
        delete shapes.at(-1).x0;
        delete shapes.at(-1).y0;
        setSelection([shapes[shapes.length-1].id], shapes[shapes.length-1].id);
      } else if (draft.type==="rawpath" && draft.d) {
        pushUndo();
        shapes.push({...draft,id:localId()});
        delete shapes.at(-1).x0;
        delete shapes.at(-1).y0;
        setSelection([shapes[shapes.length-1].id], shapes[shapes.length-1].id);
      }
      draft=null; render();
    }
  }

  function onVtxDown(ev) {
    ev.preventDefault(); ev.stopPropagation();
    const { x, y } = svgCoords(ev);
    const sid = ev.currentTarget.dataset.sid;
    const vi  = parseInt(ev.currentTarget.dataset.vi, 10);
    const s = shapes.find(sh => sh.id === sid);
    if (!s) return;
    if (ev.currentTarget.dataset.raw) {
      const pts = rawPoints(s);
      if (!pts.length) return;
      drag = { mode:"rawvtx", id:sid, ox:x, oy:y, pushed:false,
               pts0: pts.map(p => ({ ...p })), moving: linkedRawPoints(pts, vi) };
      return;
    }
    drag = {mode:"vertex",id:sid,vi,ox:x,oy:y,px0:s.pts[vi].x,py0:s.pts[vi].y,pushed:false};
  }

  function onResizeDown(ev) {
    ev.preventDefault(); ev.stopPropagation();
    const sid = ev.currentTarget.dataset.sid;
    const s = shapes.find(sh => sh.id === sid);
    if (!s) return;
    const bb = bboxShape(s);
    const corner = ev.currentTarget.dataset.corner;
    const east = corner.includes("e"), south = corner.includes("s");
    const pointer = svgCoords(ev);
    drag = {
      mode:"resize", id:sid, pushed:false, original:deepCloneShapes([s])[0],
      handle:{x:east?bb.x+bb.w:bb.x,y:south?bb.y+bb.h:bb.y},
      anchor:{x:east?bb.x:bb.x+bb.w,y:south?bb.y:bb.y+bb.h},
      pointer,
    };
  }

  function onRotateDown(ev) {
    ev.preventDefault(); ev.stopPropagation();
    if (simplePaths) return;
    const id = ev.currentTarget.dataset.sid;
    const s = shapes.find(sh => sh.id === id);
    if (!s) return;
    const { x, y } = svgCoords(ev);
    const bb = bboxShape(s);
    drag = {
      mode: "rotate",
      id,
      cx: bb.x + bb.w / 2,
      cy: bb.y + bb.h / 2,
      startAngle: Math.atan2(y - (bb.y + bb.h / 2), x - (bb.x + bb.w / 2)),
      rotation0: Number(s.rotation || 0),
      pushed: false,
    };
  }

  function onDblClick(ev) {
    if (["pen", "spline"].includes(activeTool) && penPts.length >= 2) {
      penPts = penPts.slice(0,-1); commitPen(false);
    } else if (activeTool === "navigate") {
      view = { x:0, y:0, zoom:1 };
      render();
    } else if (activeTool === "select") {
      const { x, y } = svgCoords(ev);
      const s = shapes.find(shape => shape.id === hitTest(x,y));
      if (s?.type === "text") {
        const text = prompt("Text", s.text);
        if (text !== null && text !== s.text) { pushUndo(); s.text=text; render(); }
      }
    }
  }

  function commitPen(closed) {
    if (penPts.length < 2) { penPts=[]; penHover=null; render(); return; }
    pushUndo();
    shapes.push({id:localId(),type:"path",kind:activeTool,pts:[...penPts],closed,smooth:activeTool==="spline",...currentPaint()});
    setSelection([shapes[shapes.length-1].id], shapes[shapes.length-1].id);
    penPts=[]; penHover=null; render();
  }

  // ── Keyboard handler ───────────────────────────────────────────────────────
  function onKeyDown(ev) {
    if (_focusedUid !== uid) return;  // only active editor handles keys
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") return;

    if (ev.key === "Escape") {
      if (penPts.length)   { penPts=[]; penHover=null; render(); }
      else if (draft)      { draft=null; render(); }
      else                 { setSelection([]); render(); }
      return;
    }
    if (ev.key === "Backspace" || ev.key === "Delete") {
      ev.preventDefault();
      if (activeTool==="pen" && penPts.length) { penPts=penPts.slice(0,-1); render(); }
      else if (selectedIds.size) {
        pushUndo();
        shapes=shapes.filter(s=>!selectedIds.has(s.id));
        setSelection([]);
        render();
      }
      return;
    }
    if ((ev.key==="z"||ev.key==="Z") && (ev.ctrlKey||ev.metaKey)) {
      ev.preventDefault();
      if (ev.shiftKey) doRedo(); else doUndo();
      return;
    }
    if ((ev.key==="y"||ev.key==="Y") && (ev.ctrlKey||ev.metaKey)) { ev.preventDefault(); doRedo(); return; }
    if ((ev.key==="c"||ev.key==="C") && (ev.ctrlKey||ev.metaKey) && selectedIds.size) {
      const selected = selectedShapes();
      if (selected.length === 1) clipboardShape=deepCloneShapes(selected)[0];
      return;
    }
    if ((ev.key==="v"||ev.key==="V") && (ev.ctrlKey||ev.metaKey) && clipboardShape) {
      ev.preventDefault(); pushUndo();
      const clone=deepCloneShapes([clipboardShape])[0];
      clone.id=localId();
      moveShape(clone,12,12);
      shapes.push(clone); setSelection([clone.id], clone.id); clipboardShape=deepCloneShapes([clone])[0]; render(); return;
    }
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (ev.key.toLowerCase()==="v") { setEditorTool("select"); return; }
      if (ev.key.toLowerCase()==="p") { setEditorTool("pen");    return; }
      if (ev.key.toLowerCase()==="e") { setEditorTool("ellipse");return; }
      if (ev.key.toLowerCase()==="r") { setEditorTool("rect");   return; }
      if (ev.key.toLowerCase()==="f") { setEditorTool("freehand");return; }
      if (ev.key.toLowerCase()==="l") { setEditorTool("line");return; }
      if (ev.key.toLowerCase()==="t") { setEditorTool("text");return; }
      if (ev.key.toLowerCase()==="g") { setEditorTool("gradient");return; }
      if (ev.key.toLowerCase()==="i") { setEditorTool("eyedropper");return; }
    }
    if (selectedIds.size && ["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(ev.key)) {
      ev.preventDefault();
      const dx = ev.key==="ArrowLeft"?-1:ev.key==="ArrowRight"?1:0;
      const dy = ev.key==="ArrowUp"  ?-1:ev.key==="ArrowDown" ?1:0;
      pushUndo();
      moveSelected(dx*(ev.shiftKey?10:1), dy*(ev.shiftKey?10:1));
      render();
    }
  }

  function moveShape(s, dx, dy) {
    if (s.type==="ellipse")   { s.cx+=dx; s.cy+=dy; }
    else if (s.type==="rect") { s.x+=dx;  s.y+=dy; }
    else if (s.type==="path") { s.pts=s.pts.map(p=>({x:p.x+dx,y:p.y+dy})); }
    else if (s.type==="rawpath") { s.tx+=dx; s.ty+=dy; }
    else if (s.type==="text") { s.x+=dx; s.y+=dy; }
    if (s.gradient) {
      s.gradient.from.x+=dx; s.gradient.from.y+=dy;
      s.gradient.to.x+=dx; s.gradient.to.y+=dy;
    }
  }

  function onGlobalMove(ev) { if (drag||draft) onMouseMove(ev); }
  function onGlobalUp(ev)   {
    if (drag)  { onMouseUp(ev); drag=null; }
    if (draft) { onMouseUp(ev); }
  }

  // ── SVG export ─────────────────────────────────────────────────────────────
  function exportToSvg(w, h) {
    const sx = w/CW, sy = h/CH;
    const scaled = shapes.map(s => {
      let next = s;
      if (s.type==="ellipse")  next={...s,cx:rn(s.cx*sx),cy:rn(s.cy*sy),rx:rn(s.rx*sx),ry:rn(s.ry*sy)};
      else if (s.type==="rect") next={...s,x:rn(s.x*sx),y:rn(s.y*sy),w:rn(s.w*sx),h:rn(s.h*sy)};
      else if (s.type==="path") next={...s,pts:s.pts.map(p=>({x:rn(p.x*sx),y:rn(p.y*sy)}))};
      else if (s.type==="rawpath") next={...s,d:scalePathD(s.d,sx,sy,rn(s.tx*sx),rn(s.ty*sy)),tx:0,ty:0};
      else if (s.type==="text") next={...s,x:rn(s.x*sx),y:rn(s.y*sy),fontSize:rn((s.fontSize||24)*(sx+sy)/2)};
      if (s.gradient) next={...next,gradient:{...s.gradient,
        from:{x:rn(s.gradient.from.x*sx),y:rn(s.gradient.from.y*sy)},
        to:{x:rn(s.gradient.to.x*sx),y:rn(s.gradient.to.y*sy)},
        stops:s.gradient.stops.map(stop=>({...stop})),
      }};
      return next;
    });
    const defs = scaled.filter(s=>s.gradient).map(s => {
      const g=s.gradient;
      return `<linearGradient id="${uid}_gradient_${xmlAttr(s.id)}" gradientUnits="userSpaceOnUse" x1="${g.from.x}" y1="${g.from.y}" x2="${g.to.x}" y2="${g.to.y}">${g.stops.map(stop=>`<stop offset="${rn(stop.offset*100)}%" stop-color="${xmlAttr(stop.color)}"/>`).join("")}</linearGradient>`;
    }).join("");
    const els = scaled.map(s => {
      const f=s.gradient?`url(#${uid}_gradient_${s.id})`:s.fill, sk=s.stroke;
      const sw=`stroke-width="${s.sw}" ${strokeAttributeString(s)}`;
      const bb = bboxShape(s), rotation = Number(s.rotation || 0);
      const transform = rotation ? ` transform="rotate(${rn(rotation)} ${rn(bb.x + bb.w / 2)} ${rn(bb.y + bb.h / 2)})"` : "";
      if (s.type==="ellipse")  return `  <ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}" fill="${f}" stroke="${sk}" ${sw}${transform}/>`;
      if (s.type==="rect")     return `  <rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${f}" stroke="${sk}" ${sw}${transform}/>`;
      if (s.type==="rawpath")  return `  <path d="${s.d}" fill="${f}" stroke="${sk}" ${sw}${transform}/>`;
      if (s.type==="text")     return `  <text x="${s.x}" y="${s.y}" fill="${f}" stroke="${sk}" ${sw} font-family="${xmlAttr(s.fontFamily||"sans-serif")}" font-size="${s.fontSize}" font-weight="${xmlAttr(s.fontWeight||"400")}"${transform}>${xmlAttr(s.text||"")}</text>`;
      const d = buildPathD(s.pts, s.closed, s.smooth !== false);
      return `  <path d="${d}" fill="${f}" stroke="${sk}" ${sw}${transform}/>`;
    }).join("\n");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n${defs?`  <defs>${defs}</defs>\n`:""}${els}\n</svg>`;
  }

  // ── Export as ONE path ─────────────────────────────────────────────────────
  // A <mx:Path> carries a single `d`, so everything on the canvas becomes one
  // path made of subpaths — that is what a mouth viseme is written back as.
  // The style is the first shape's: one path has one fill and one stroke.
  function exportToPath(w, h) {
    const sx = w/CW, sy = h/CH;
    const subs = shapes.filter(s=>s.type!=="text").map(s => {
      if (s.type === "ellipse") return ellipsePathD(s.cx*sx, s.cy*sy, s.rx*sx, s.ry*sy);
      if (s.type === "rect") {
        const x=s.x*sx, y=s.y*sy, ww=s.w*sx, hh=s.h*sy;
        return `M ${rn(x)},${rn(y)} L ${rn(x+ww)},${rn(y)} L ${rn(x+ww)},${rn(y+hh)} L ${rn(x)},${rn(y+hh)} Z`;
      }
      if (s.type === "rawpath") return scalePathD(s.d, sx, sy, rn(s.tx*sx), rn(s.ty*sy));
      return buildPathD(s.pts.map(p => ({ x: p.x*sx, y: p.y*sy })), s.closed, s.smooth !== false);
    }).filter(Boolean)
      // Only a subpath that follows another needs its start spelled out — the
      // first one is already where SVG reads it, and leaving it exactly as
      // authored keeps an untouched shape byte-identical through the save.
      .map((sub, i) => i === 0 ? sub : absoluteStart(sub));
    const top = shapes[0];
    return {
      d: subs.join(" "),
      fill:   top ? (top.gradient?.stops[0]?.color || top.fill) : fillColor,
      stroke: top ? top.stroke : strokeColor,
      sw:     top ? top.sw     : strokeW,
    };
  }

  // ── Load from MXML active layer ────────────────────────────────────────────
  function loadFromLayerInternal() {
    try {
      const source = opts.getLayerSource?.();
      if (!source) return;
      const src = source.source;
      const parser = new DOMParser();
      const xml = parser.parseFromString(src, "text/xml");
      const scene = xml.querySelector("Scene");
      if (!scene) return;
      const stageW = parseFloat(scene.getAttribute("width")  || "400");
      const stageH = parseFloat(scene.getAttribute("height") || "300");
      const sx = CW/stageW, sy = CH/stageH;
      let layerEl = null;
      for (const l of xml.querySelectorAll("Layer")) {
        if (l.getAttribute("name") === source.activeLayer) { layerEl=l; break; }
      }
      if (!layerEl) return;
      const imported = simplePaths ? [] : shapes;
      for (const node of layerEl.querySelectorAll(":scope > Path")) {
        const d = node.getAttribute("d");
        if (!d) continue;
        const fill   = simplePaths ? node.getAttribute("fill") || "#cccccc" : normColor(node.getAttribute("fill") || "#cccccc");
        const stroke = simplePaths ? node.getAttribute("stroke") || "none" : normColor(node.getAttribute("stroke") || "none");
        const sw     = parseFloat(node.getAttribute("strokeWidth")||node.getAttribute("stroke-width")||"1");
        imported.push({id:localId(),type:"rawpath",d:scalePathD(d,sx,sy),tx:0,ty:0,fill,stroke,sw});
      }
      if (simplePaths) { validateSimpleShapes(imported); shapes.push(...imported); }
    } catch (e) { if (simplePaths) reportError(e); }
  }

  // ── Load shapes from an SVG string ─────────────────────────────────────────
  // Parses <ellipse> and <path> elements.  srcW/srcH are the SVG's declared
  // dimensions; they default to CW/CH (1:1, no scaling).
  function loadFromSvgStrInternal(svgStr, srcW, srcH) {
    if (simplePaths) validateSimpleSvg(svgStr);
    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(svgStr, "image/svg+xml");
    const svgRoot = svgDoc.querySelector("svg");
    if (!svgRoot) return;
    if (simplePaths && [srcW, srcH].some(value => value != null && (!Number.isFinite(value) || value <= 0))) throw new Error("SVG dimensions must be positive finite numbers.");
    const sourceW = srcW || CW;
    const sourceH = srcH || CH;
    const sx = CW / sourceW;
    const sy = CH / sourceH;
    if (simplePaths && (![sourceW, sourceH, sx, sy].every(Number.isFinite) || sourceW <= 0 || sourceH <= 0)) throw new Error("SVG dimensions must be positive finite numbers.");
    const imported = simplePaths ? [] : shapes;

    // Accumulate translate() offsets from parent <g> elements so shapes
    // inside a <g transform="translate(x,y)"> land at their true positions.
    function parentOffset(el) {
      let tx = 0, ty = 0, node = el;
      while (node && node !== svgRoot) {
        const t = node.getAttribute && node.getAttribute("transform");
        if (t) {
          const m = t.match(/translate\(\s*([-\d.]+)[,\s]\s*([-\d.]+)\s*\)/);
          if (m) { tx += parseFloat(m[1]); ty += parseFloat(m[2]); }
        }
        node = node.parentElement;
      }
      return { tx, ty };
    }
    function parentRotation(el) {
      let rotation = 0, node = el;
      while (node && node !== svgRoot) {
        const t = node.getAttribute && node.getAttribute("transform");
        if (t) {
          for (const match of t.matchAll(/rotate\(\s*([-\d.]+)/g)) rotation += parseFloat(match[1]) || 0;
        }
        node = node.parentElement;
      }
      return rotation;
    }

    function inheritedAttr(el, name, fallback) {
      let element=el;
      while (element && element!==svgRoot.parentElement) {
        const value=element.getAttribute?.(name) || element.style?.getPropertyValue?.(name);
        if (value) return value;
        element=element.parentElement;
      }
      return fallback;
    }
    function paint(el, fallbackFill="none") {
      const dash = inheritedAttr(el,"stroke-dasharray","");
      return {
        fill:simplePaths ? inheritedAttr(el,"fill","#000000").trim() : normColor(inheritedAttr(el,"fill",fallbackFill)),
        stroke:simplePaths ? inheritedAttr(el,"stroke","none").trim() : normColor(inheritedAttr(el,"stroke","none")),
        sw:simplePaths ? Number(inheritedAttr(el,"stroke-width","1")) : parseFloat(inheritedAttr(el,"stroke-width","1")) || 1,
        linecap:inheritedAttr(el,"stroke-linecap","round"),
        linejoin:inheritedAttr(el,"stroke-linejoin","round"),
        miterlimit:parseFloat(inheritedAttr(el,"stroke-miterlimit","4")) || 4,
        dasharray:simplePaths ? [] : normalizeDasharray(dash),
        dashoffset:parseFloat(inheritedAttr(el,"stroke-dashoffset","0")) || 0,
      };
    }
    function gradient(el, tx, ty, bounds) {
      const value=inheritedAttr(el,"fill","");
      const match=value.match(/^url\(\s*#([^)]+)\s*\)$/);
      if (!match) return undefined;
      const source=svgDoc.getElementById(match[1]);
      if (!source || source.localName!=="linearGradient") return undefined;
      const userSpace=source.getAttribute("gradientUnits")==="userSpaceOnUse";
      const parseCoord=(name,fallback,axis,offset)=>{
        const raw=source.getAttribute(name);
        const value=raw ?? fallback;
        if (!userSpace) {
          const ratio=parseFloat(value)/(value.endsWith("%")?100:1);
          return axis==="x" ? bounds.x+ratio*bounds.w : bounds.y+ratio*bounds.h;
        }
        const scale=axis==="x"?sx:sy;
        const viewport=axis==="x"?sourceW:sourceH;
        const coordinate=value.endsWith("%")?parseFloat(value)/100*viewport:parseFloat(value);
        return (coordinate+offset)*scale;
      };
      return {
        type:"linear",
        from:{x:rn(parseCoord("x1","0%","x",tx)),y:rn(parseCoord("y1","0%","y",ty))},
        to:{x:rn(parseCoord("x2","100%","x",tx)),y:rn(parseCoord("y2","0%","y",ty))},
        stops:[...source.querySelectorAll("stop")].map(stop=>({
          offset:Math.max(0,Math.min(1,parseFloat(stop.getAttribute("offset")||"0")/(stop.getAttribute("offset")?.includes("%")?100:1))),
          color:normColor(stop.getAttribute("stop-color") || stop.style?.stopColor || "#000000"),
        })),
      };
    }
    const parsePointList=value=>{
      const numbers=simplePaths ? value.trim().split(/[\s,]+/).map(Number)
        : (value||"").match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number) || [];
      const points=[];
      for (let i=0;i+1<numbers.length;i+=2) points.push({x:rn(numbers[i]*sx),y:rn(numbers[i+1]*sy)});
      return points;
    };

    for (const el of svgRoot.querySelectorAll("ellipse,circle,rect,line,polygon,polyline,path,text")) {
      const shapeCount=imported.length;
      const { tx, ty } = parentOffset(el);
      const id=localId(), style=paint(el,el.localName==="path"?"none":"#cccccc");
      const common={id,...style,rotation:rn(parentRotation(el))};
      if (el.localName==="ellipse" || el.localName==="circle") {
        const radius=parseFloat(el.getAttribute("r")||0);
        imported.push({...common,type:"ellipse",
          cx:rn((parseFloat(el.getAttribute("cx")||0)+tx)*sx),
          cy:rn((parseFloat(el.getAttribute("cy")||0)+ty)*sy),
          rx:rn(parseFloat(el.getAttribute("rx")||radius)*sx),
          ry:rn(parseFloat(el.getAttribute("ry")||radius)*sy)});
      } else if (el.localName==="rect") {
        imported.push({...common,type:"rect",
          x:rn((parseFloat(el.getAttribute("x")||0)+tx)*sx),
          y:rn((parseFloat(el.getAttribute("y")||0)+ty)*sy),
          w:rn(parseFloat(el.getAttribute("width")||0)*sx),
          h:rn(parseFloat(el.getAttribute("height")||0)*sy)});
      } else if (el.localName==="line") {
        imported.push({...common,type:"path",kind:"line",closed:false,smooth:false,fill:"none",pts:[
          {x:rn((parseFloat(el.getAttribute("x1")||0)+tx)*sx),y:rn((parseFloat(el.getAttribute("y1")||0)+ty)*sy)},
          {x:rn((parseFloat(el.getAttribute("x2")||0)+tx)*sx),y:rn((parseFloat(el.getAttribute("y2")||0)+ty)*sy)},
        ]});
      } else if (el.localName==="polygon" || el.localName==="polyline") {
        const pts=parsePointList(el.getAttribute("points")).map(p=>({x:rn(p.x+tx*sx),y:rn(p.y+ty*sy)}));
        if (pts.length) imported.push({...common,type:"path",kind:el.localName,pts,closed:el.localName==="polygon",smooth:false});
      } else if (el.localName==="path") {
        const d=el.getAttribute("d");
        if (d) imported.push({...common,type:"rawpath",d:scalePathD(d,sx,sy,tx*sx,ty*sy),tx:0,ty:0});
      } else if (el.localName==="text") {
        imported.push({...common,type:"text",text:el.textContent||"",
          x:rn((parseFloat(el.getAttribute("x")||0)+tx)*sx),
          y:rn((parseFloat(el.getAttribute("y")||0)+ty)*sy),
          fontSize:rn(parseFloat(inheritedAttr(el,"font-size","24"))*(sx+sy)/2),
          fontFamily:inheritedAttr(el,"font-family","sans-serif"),
          fontWeight:inheritedAttr(el,"font-weight","400")});
      }
      if (imported.length>shapeCount) {
        const shape=imported.at(-1);
        shape.gradient=gradient(el,tx,ty,bboxShape(shape));
      }
    }
    if (simplePaths) validateSimpleShapes(imported);
    return imported;
  }

  function importSimpleSvg(svgStr, sw, sh, replace, recordUndo = false) {
    let imported;
    try { imported = loadFromSvgStrInternal(svgStr, sw, sh); }
    catch (error) { return reportError(error); }
    if (recordUndo) pushUndo();
    else if (replace) { undoStack = []; redoStack = []; }
    shapes = replace ? imported : [...shapes, ...imported];
    setSelection([]);
    draft = null; penPts = []; penHover = null; drag = null;
    render();
    return true;
  }

  // ── HTML template ──────────────────────────────────────────────────────────
  const dr = role => `data-ed="${uid}:${role}"`;
  const toolBtn = (role, icon, title, active=false) =>
    `<button ${dr(`tool-${role}`)} class="p-1 flex justify-center items-center rounded transition-colors ${active?"bg-primary/20 text-primary":"text-text-secondary hover:text-on-surface hover:bg-surface-container"}" title="${title}" style="width:28px;height:28px">
      <span class="material-symbols-outlined text-[15px]">${icon}</span>
    </button>`;

  containerEl.innerHTML = `
    <div class="flex flex-col h-full">

      <!-- Toolbar -->
      <div class="flex items-center gap-2 px-2 shrink-0 border-b border-border-muted bg-surface-panel flex-wrap" style="min-height:38px;padding-top:3px;padding-bottom:3px">
        <div class="flex gap-0.5">
          ${toolBtn("select",  "near_me",               "Select/Move (V)", true)}
          ${toolBtn("navigate","pan_tool",              "Navigate/Pan")}
          ${toolBtn("eyedropper","colorize",            "Eyedropper (I)")}
          ${toolBtn("fill",    "format_color_fill",      "Fill")}
          ${toolBtn("gradient","gradient",               "Gradient (G)")}
        </div>
        <div class="w-px h-4 bg-border-muted shrink-0"></div>
        <div class="flex gap-0.5">
          ${toolBtn("pen",     "edit",                   "Pen (P)")}
          ${toolBtn("freehand","gesture",                "Freehand (F)")}
          ${toolBtn("spline",  "timeline",               "Spline")}
          ${toolBtn("line",    "diagonal_line",          "Line (L)")}
          ${toolBtn("ellipse", "radio_button_unchecked", "Ellipse (E)")}
          ${toolBtn("rect",    "rectangle",              "Rect (R)")}
          ${toolBtn("polygon", "pentagon",                "Polygon")}
          ${toolBtn("star",    "star",                    "Star")}
          ${toolBtn("arrow",   "arrow_right_alt",         "Arrow")}
          ${toolBtn("spiral",  "all_inclusive",           "Spiral")}
          ${toolBtn("grid",    "grid_on",                 "Grid")}
          ${toolBtn("text",    "title",                   "Text (T)")}
        </div>
        <div class="w-px h-4 bg-border-muted shrink-0"></div>

        <div class="flex items-center gap-1 text-[11px] text-text-secondary">
          <span>Fill</span>
          <input ${dr("fill")} type="color" value="#fce4d6"
            class="h-5 w-7 rounded cursor-pointer border border-border-muted" title="Fill colour"/>
          <button ${dr("fillNone")} type="button" title="Transparent fill" aria-label="Transparent fill" aria-pressed="false"
            class="text-[10px] px-1 rounded border border-border-muted hover:bg-surface-container leading-4">Transparent</button>
        </div>

        <div class="flex items-center gap-1 text-[11px] text-text-secondary">
          <span>Stroke</span>
          <input ${dr("stroke")} type="color" value="#5c3a2e"
            class="h-5 w-7 rounded cursor-pointer border border-border-muted" title="Stroke colour"/>
          <button ${dr("strokeNone")} title="No stroke"
            class="text-[10px] px-1 rounded border border-border-muted hover:bg-surface-container leading-4">∅</button>
          <input ${dr("sw")} type="number" value="2" min="0.5" max="20" step="0.5" title="Stroke width"
            class="w-10 text-[10px] text-center bg-surface-container border border-border-muted rounded px-1 h-5"/>
          <select ${dr("linecap")} title="Stroke cap" class="text-[10px] bg-surface-container border border-border-muted rounded h-5">
            <option value="round">Round cap</option><option value="butt">Butt cap</option><option value="square">Square cap</option>
          </select>
          <select ${dr("linejoin")} title="Stroke join" class="text-[10px] bg-surface-container border border-border-muted rounded h-5">
            <option value="round">Round join</option><option value="miter">Miter join</option><option value="bevel">Bevel join</option>
          </select>
          <input ${dr("miter")} type="number" value="4" min="1" max="20" step="0.5" title="Miter limit"
            class="w-10 text-[10px] text-center bg-surface-container border border-border-muted rounded px-1 h-5"/>
          <input ${dr("dash")} type="text" placeholder="Dash" title="Dash pattern, e.g. 6 3"
            class="w-16 text-[10px] text-center bg-surface-container border border-border-muted rounded px-1 h-5"/>
          <input ${dr("dashoffset")} type="number" value="0" step="0.5" title="Dash offset"
            class="w-10 text-[10px] text-center bg-surface-container border border-border-muted rounded px-1 h-5"/>
        </div>

        <div class="w-px h-4 bg-border-muted shrink-0"></div>

        <div class="flex items-center gap-1 text-[10px] text-text-secondary" title="Polygon/star points, spiral turns, or grid divisions">
          <span>Detail</span>
          <input ${dr("detail")} type="number" value="5" min="3" max="24" step="1"
            class="w-10 text-center bg-surface-container border border-border-muted rounded px-1 h-5"/>
        </div>

        <div class="w-px h-4 bg-border-muted shrink-0"></div>

        <div class="flex items-center gap-0.5">
          <button ${dr("dup")}   title="Duplicate selected"
            class="p-1 rounded text-text-secondary hover:text-on-surface hover:bg-surface-container">
            <span class="material-symbols-outlined text-[14px]">content_copy</span></button>
          <button ${dr("del")}   title="Delete selected (Del)"
            class="p-1 rounded text-text-secondary hover:text-on-surface hover:bg-surface-container">
            <span class="material-symbols-outlined text-[14px]">delete</span></button>
          <button ${dr("undo")}  title="Undo (Ctrl+Z)"
            class="p-1 rounded text-text-secondary hover:text-on-surface hover:bg-surface-container">
            <span class="material-symbols-outlined text-[14px]">autorenew</span></button>
          <button ${dr("redo")}  title="Redo (Ctrl+Shift+Z)"
            class="p-1 rounded text-text-secondary hover:text-on-surface hover:bg-surface-container">
            <span class="material-symbols-outlined text-[14px]">redo</span></button>
          <button ${dr("clear")} title="Clear all shapes"
            class="p-1 rounded text-text-secondary hover:text-on-surface hover:bg-surface-container">
            <span class="material-symbols-outlined text-[14px]">delete_outline</span></button>
        </div>

        <div class="w-px h-4 bg-border-muted shrink-0"></div>

        <div class="flex items-center gap-0.5">
          <button ${dr("align-left")} title="Align left" class="p-1 rounded text-text-secondary hover:bg-surface-container">L</button>
          <button ${dr("align-center")} title="Align horizontal center" class="p-1 rounded text-text-secondary hover:bg-surface-container">C</button>
          <button ${dr("align-right")} title="Align right" class="p-1 rounded text-text-secondary hover:bg-surface-container">R</button>
          <button ${dr("align-top")} title="Align top" class="p-1 rounded text-text-secondary hover:bg-surface-container">T</button>
          <button ${dr("align-middle")} title="Align vertical middle" class="p-1 rounded text-text-secondary hover:bg-surface-container">M</button>
          <button ${dr("align-bottom")} title="Align bottom" class="p-1 rounded text-text-secondary hover:bg-surface-container">B</button>
          <button ${dr("distribute-x")} title="Distribute horizontally" class="p-1 rounded text-text-secondary hover:bg-surface-container">↔</button>
          <button ${dr("distribute-y")} title="Distribute vertically" class="p-1 rounded text-text-secondary hover:bg-surface-container">↕</button>
        </div>

        <div class="w-px h-4 bg-border-muted shrink-0"></div>

        <div class="flex items-center gap-0.5">
          <button ${dr("importSvg")} title="Import SVG file (replaces current shapes)"
            class="p-1 rounded text-text-secondary hover:text-on-surface hover:bg-surface-container flex items-center gap-0.5 text-[10px]">
            <span class="material-symbols-outlined text-[14px]">folder_open</span>
            <span>SVG</span>
          </button>
          <input ${dr("importSvgFile")} type="file" accept=".svg,image/svg+xml" class="hidden" />
        </div>
      </div>

      <!-- Canvas + shape list -->
      <div class="flex flex-1 overflow-hidden">

        <div class="flex-1 overflow-auto bg-surface-container-lowest flex items-center justify-center p-2">
          <div class="shadow-sm">
            <svg ${dr("canvas")} width="${CW}" height="${CH}"
                 xmlns="http://www.w3.org/2000/svg"
                 style="display:block;cursor:default;user-select:none">
            </svg>
          </div>
        </div>

        <div class="flex flex-col border-l border-border-muted shrink-0" style="width:110px">
          <div class="text-[9px] text-text-secondary px-2 py-1 border-b border-border-muted uppercase tracking-wider shrink-0">Shapes</div>
          <div ${dr("shapeList")} class="flex-1 overflow-y-auto py-0.5"></div>
          <div class="border-t border-border-muted px-1 py-1 flex gap-1 text-text-secondary text-[11px] shrink-0">
            <button ${dr("raise")} title="Move forward"  class="flex-1 text-center hover:text-on-surface rounded hover:bg-surface-container">↑</button>
            <button ${dr("lower")} title="Move backward" class="flex-1 text-center hover:text-on-surface rounded hover:bg-surface-container">↓</button>
          </div>
        </div>

      </div>

      <!-- Status bar -->
      <div class="shrink-0 border-t border-border-muted bg-surface-panel px-2"
           style="height:22px;display:flex;align-items:center">
        <span ${dr("status")} class="text-[10px] text-text-secondary truncate">${TOOL_STATUS["select"]}</span>
      </div>
    </div>
  `;

  svgEl = q("canvas");

  // ── Wire all controls ──────────────────────────────────────────────────────

  [
    "select","navigate","eyedropper","fill","gradient","pen","freehand","spline",
    "line","ellipse","rect","polygon","star","arrow","spiral","grid","text",
  ].forEach(t =>
    q(`tool-${t}`)?.addEventListener("click", () => setEditorTool(t))
  );

  const fillInp   = q("fill");
  const strokeInp = q("stroke");
  const swInp     = q("sw");
  const linecapInp = q("linecap");
  const linejoinInp = q("linejoin");
  const miterInp = q("miter");
  const dashInp = q("dash");
  const dashoffsetInp = q("dashoffset");
  const detailInp = q("detail");
  const updateSelectedStroke = (key, value) => {
    if (simplePaths) return;
    if (!sel) return;
    const s = shapes.find(sh => sh.id === sel);
    if (!s) return;
    pushUndo();
    if (value === "" || value == null) delete s[key];
    else s[key] = value;
    render();
  };

  fillInp.addEventListener("input", () => {
    fillColor=fillInp.value; fillNone=false;
    if (sel) { const s=shapes.find(sh=>sh.id===sel); if(s){pushUndo();s.fill=fillColor;delete s.gradient;} }
    render();
  });
  strokeInp.addEventListener("input", () => {
    strokeColor=strokeInp.value; strokeNone=false; strokeInp.style.opacity="1";
    if (sel) { const s=shapes.find(sh=>sh.id===sel); if(s){pushUndo();s.stroke=strokeColor;render();} }
  });
  swInp.addEventListener("input", () => {
    if (simplePaths) {
      const value = Number(swInp.value);
      if (!Number.isFinite(value) || value < 0) return;
      strokeW = value;
    } else strokeW=parseFloat(swInp.value)||1;
    if (sel) { const s=shapes.find(sh=>sh.id===sel); if(s){pushUndo();s.sw=strokeW;render();} }
  });
  linecapInp.addEventListener("change", () => updateSelectedStroke("linecap", linecapInp.value));
  linejoinInp.addEventListener("change", () => updateSelectedStroke("linejoin", linejoinInp.value));
  miterInp.addEventListener("change", () => {
    const value = Math.max(1, parseFloat(miterInp.value) || 4);
    miterInp.value = String(value);
    updateSelectedStroke("miterlimit", value);
  });
  dashInp.addEventListener("change", () => updateSelectedStroke("dasharray", normalizeDasharray(dashInp.value)));
  dashoffsetInp.addEventListener("change", () => {
    const value = parseFloat(dashoffsetInp.value) || 0;
    dashoffsetInp.value = String(value);
    updateSelectedStroke("dashoffset", value);
  });
  detailInp.addEventListener("input", () => {
    const value=Math.max(3,Math.min(24,Math.round(parseFloat(detailInp.value)||5)));
    detailInp.value=String(value);
    shapeSides=value; spiralTurns=Math.max(1,Math.min(12,value)); gridSize=Math.max(1,Math.min(12,value));
  });
  q("fillNone").addEventListener("click", () => {
    const s = shapes.find(sh => sh.id === sel);
    fillColor = fillInp.value;
    fillNone = s ? s.fill !== "none" || Boolean(s.gradient) : !fillNone;
    if (s) {
      pushUndo();
      s.fill = fillNone ? "none" : fillColor;
      delete s.gradient;
    }
    render();
  });
  q("strokeNone").addEventListener("click", () => {
    strokeNone=true; strokeColor="none"; strokeInp.style.opacity="0.35";
    if (sel) { const s=shapes.find(sh=>sh.id===sel); if(s){pushUndo();s.stroke="none";render();} }
  });
  q("del").addEventListener("click", () => {
    if (!selectedIds.size) return;
    pushUndo(); shapes=shapes.filter(s=>!selectedIds.has(s.id)); setSelection([]); render();
  });
  q("dup").addEventListener("click", () => {
    const selected = selectedShapes();
    if (!selected.length) return;
    pushUndo();
    const clones = deepCloneShapes(selected).map(clone => {
      clone.id=localId();
      moveShape(clone,12,12);
      return clone;
    });
    shapes.push(...clones);
    setSelection(clones.map(clone => clone.id), clones.at(-1).id);
    render();
  });
  q("undo").addEventListener("click", doUndo);
  q("redo").addEventListener("click", doRedo);
  q("clear").addEventListener("click", () => {
    if (!shapes.length) return;
    if (!confirm("Clear all shapes?")) return;
    pushUndo(); shapes=[]; setSelection([]); render();
  });
  q("raise").addEventListener("click", () => {
    const i=shapes.findIndex(s=>s.id===sel);
    if (simplePaths && i < 0) return;
    if (i<shapes.length-1) { pushUndo();[shapes[i],shapes[i+1]]=[shapes[i+1],shapes[i]];render(); }
  });
  q("lower").addEventListener("click", () => {
    const i=shapes.findIndex(s=>s.id===sel);
    if (i>0) { pushUndo();[shapes[i],shapes[i-1]]=[shapes[i-1],shapes[i]];render(); }
  });
  [
    ["align-left", "left"], ["align-center", "center"], ["align-right", "right"],
    ["align-top", "top"], ["align-middle", "middle"], ["align-bottom", "bottom"],
    ["distribute-x", "distribute-x"], ["distribute-y", "distribute-y"],
  ].forEach(([role, mode]) => q(role).addEventListener("click", () => applySelectionLayout(mode)));

  // Import SVG file
  const importFileEl = q("importSvgFile");
  q("importSvg").addEventListener("click", () => { importFileEl.value=""; importFileEl.click(); });
  importFileEl.addEventListener("change", () => {
    const file = importFileEl.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      if (!svgEl) return;
      const svgStr = e.target.result;
      if (simplePaths) {
        try {
          const root = validateSimpleSvg(svgStr);
          const vb = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
          const sw = vb ? vb[2] : Number(root.getAttribute("width") || CW);
          const sh = vb ? vb[3] : Number(root.getAttribute("height") || CH);
          importSimpleSvg(svgStr, sw, sh, true, true);
        } catch (error) { reportError(error); }
        return;
      }
      // Parse SVG viewport to scale correctly
      const tmp = new DOMParser().parseFromString(svgStr, "image/svg+xml");
      const root = tmp.querySelector("svg");
      let srcW = CW, srcH = CH;
      if (root) {
        const vb = root.getAttribute("viewBox");
        if (vb) { const p=vb.trim().split(/\s+|,/); srcW=parseFloat(p[2])||CW; srcH=parseFloat(p[3])||CH; }
        else {
          srcW = parseFloat(root.getAttribute("width"))  || CW;
          srcH = parseFloat(root.getAttribute("height")) || CH;
        }
      }
      pushUndo();
      shapes = [];
      setSelection([]);
      loadFromSvgStrInternal(svgStr, srcW, srcH);
      render();
    };
    if (simplePaths) {
      reader.onerror = () => { if (svgEl) reportError(new Error("Could not read SVG file.")); };
      reader.onabort = () => { if (svgEl) reportError(new Error("SVG file reading was cancelled.")); };
      try { reader.readAsText(file); } catch (error) { reportError(error); }
    } else reader.readAsText(file);
  });

  if (simplePaths) {
    ["tool-text", "tool-gradient", "linecap", "linejoin", "miter", "dash", "dashoffset"].forEach(role => {
      const control = q(role);
      control.disabled = true;
      control.hidden = true;
      control.style.display = "none";
    });
    swInp.min = "0";
  }

  svgEl.addEventListener("mousedown",  onMouseDown);
  svgEl.addEventListener("mousemove",  onMouseMove);
  svgEl.addEventListener("mouseup",    onMouseUp);
  svgEl.addEventListener("dblclick",   onDblClick);
  svgEl.addEventListener("wheel", ev => {
    if (!(activeTool==="navigate" || ev.ctrlKey || ev.metaKey)) return;
    ev.preventDefault();
    const before=svgCoords(ev);
    const next=Math.max(0.2,Math.min(8,view.zoom*Math.exp(-ev.deltaY*0.001)));
    view.x+=before.x*(view.zoom-next);
    view.y+=before.y*(view.zoom-next);
    view.zoom=next;
    render();
  }, {passive:false});
  svgEl.addEventListener("mouseleave", () => { if(activeTool==="pen"&&penHover){penHover=null;render();} });

  document.addEventListener("mousemove", onGlobalMove);
  document.addEventListener("mouseup",   onGlobalUp);
  document.addEventListener("keydown",   onKeyDown);

  // This instance takes keyboard focus when opened
  _focusedUid = uid;
  render();

  // ── Destroy ────────────────────────────────────────────────────────────────
  function destroy() {
    document.removeEventListener("mousemove", onGlobalMove);
    document.removeEventListener("mouseup",   onGlobalUp);
    document.removeEventListener("keydown",   onKeyDown);
    if (_focusedUid === uid) _focusedUid = null;
    svgEl = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    destroy,
    exportSvg:      (w, h)             => exportToSvg(w, h),
    exportPath:     (w, h)             => exportToPath(w, h),
    loadFromLayer:  ()                 => { loadFromLayerInternal(); render(); },
    loadFromSvgStr: (svgStr, sw, sh)   => {
      if (simplePaths) return importSimpleSvg(svgStr, sw, sh, false);
      loadFromSvgStrInternal(svgStr, sw, sh); render();
    },
    replaceWithSvg: (svgStr, sw, sh)   => {
      if (simplePaths) return importSimpleSvg(svgStr, sw, sh, true);
      shapes=[]; setSelection([]); undoStack=[]; redoStack=[]; loadFromSvgStrInternal(svgStr, sw, sh); render();
    },
    // The canvas as data, not as a picture.  Handing the shapes themselves to
    // a caller that has to remount the editor keeps every shape type, its
    // exact paint order and its authored colour — an SVG round trip through
    // export/import keeps none of those reliably.
    getShapes:      ()                 => deepCloneShapes(shapes),
    setShapes:      (arr)              => {
      if (simplePaths) {
        try { validateSimpleShapes(arr || []); } catch (error) { return reportError(error); }
      }
      shapes = deepCloneShapes(arr || []);
      if (simplePaths) shapes.forEach(s => { s.id = localId(); });
      setSelection([]); undoStack=[]; redoStack=[]; render();
    },
    // Hand the caller's shape back ready to edit: a mouth viseme is opened to
    // be reshaped, and a shape with no selection shows no nodes to drag.
    selectShapeAt: (i) => {
      const s = shapes[i];
      if (!s) return false;
      setSelection([s.id], s.id); setEditorTool("select"); render();
      return true;
    },
    getShapeCount:  ()                 => shapes.length,
    clearShapes:    ()                 => { pushUndo(); shapes=[]; setSelection([]); render(); },
  };
}
