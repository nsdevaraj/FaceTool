// pathdata.js — SVG path-data primitives shared by Character Studio, the drawing canvas and the
// mouth-shape editor.
//
// One tokenizer, one command table, one idea of what a "point" in a `d` is.
// The canvas needs it to put a draggable handle on every node of an imported
// path; the mouth editor needs it to measure a viseme, move it between
// coordinate spaces, and tell whether two shapes can morph.  Both had grown
// their own half of it, and two path parsers that disagree is a bug waiting
// for an arc.
//
// Pure string arithmetic: no DOM, no document, no editor state.

const rn = (n, dp = 2) => +n.toFixed(dp);

// What each parameter of a path command means: "x"/"y" are coordinates (moved
// and measured), "n" is carried through untouched (an arc's radii, x-axis
// rotation and flags).  Mirrors la_svg::path_params, so the editor reads a
// path the same way the compiler scales one.
const CMD_PARAMS = {
  M: ["x", "y"], L: ["x", "y"], T: ["x", "y"],
  H: ["x"], V: ["y"],
  C: ["x", "y", "x", "y", "x", "y"],
  S: ["x", "y", "x", "y"], Q: ["x", "y", "x", "y"],
  A: ["n", "n", "n", "n", "n", "x", "y"],
  Z: [],
};

// The command letters and numbers of `d`, in order.
export function pathTokens(d) {
  return String(d || "").match(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
}

const isCmd = t => /^[A-Za-z]$/.test(t);

// Walk `d` command by command, handing each parameter group to `visit` with
// the command letter, the group's numbers, and the token index each number sat
// at.  Every other function here is this walk plus a decision.
function walk(d, visit) {
  const toks = pathTokens(d);
  let cmd = "", i = 0, first = true;
  while (i < toks.length) {
    if (isCmd(toks[i])) { cmd = toks[i++]; first = i === 1; }
    const up = cmd.toUpperCase();
    const spec = CMD_PARAMS[up];
    if (!spec) { i++; continue; }
    if (up === "Z") {
      visit(cmd, up, [], [], first);
      // A closepath takes no parameters, so a number after one belongs to no
      // command at all.  Skipping the run keeps the walk moving: a loop that
      // consumed nothing would hang the editor on a single mistyped `d`.
      while (i < toks.length && !isCmd(toks[i])) i++;
      continue;
    }
    const nums = [], at = [];
    while (nums.length < spec.length && i < toks.length && !isCmd(toks[i])) {
      at.push(i); nums.push(parseFloat(toks[i++]));
    }
    if (nums.length < spec.length) break;
    visit(cmd, up, nums, at, first);
    // A repeated group re-uses the command; after a moveto the repeats are
    // linetos, and only the first group of a leading `m` is the absolute one.
    if (up === "M") { cmd = cmd === "M" ? "L" : "l"; first = false; }
  }
}

// Absolute points named by `d`, including the control points that bound its
// curves.  `anchor` marks the points the curve actually passes through.
// `xi`/`yi` are token indices (-1 when the command names only one of the two),
// which is what makes a point writable again. `command`/`parameter` retain the
// segment role needed to connect Bézier controls to the correct anchor.
export function pathPoints(d) {
  const out = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  walk(d, (cmd, up, nums, at, first) => {
    const rel = cmd !== up && !(first && up === "M");
    if (up === "Z") { cx = sx; cy = sy; return; }
    const spec = CMD_PARAMS[up];
    let px = cx, py = cy, xi = -1;
    for (let k = 0; k < spec.length; k++) {
      const kind = spec[k];
      if (kind === "n") continue;
      if (kind === "x") {
        px = rel ? cx + nums[k] : nums[k];
        xi = at[k];
        if (up !== "H") continue;              // wait for the paired y
        out.push({ x: px, y: cy, anchor: true, xi, yi: -1, rel, command: up, parameter: k });
        py = cy;
      } else {
        py = rel ? cy + nums[k] : nums[k];
        // Only a cubic's or quadratic's last pair is on the curve.
        const anchor = !(up === "C" && k < 5) && !((up === "Q" || up === "S") && k < 3);
        out.push({ x: px, y: py, anchor, xi, yi: at[k], rel, command: up, parameter: k });
        xi = -1;
      }
    }
    cx = px; cy = py;
    if (up === "M") { sx = cx; sy = cy; }
  });
  return out;
}

// Whether every point of `d` can be dragged independently.  A relative segment
// is a delta: moving one of its points would drag everything after it too, so
// such a path is moved as a whole rather than reshaped.
export function isEditablePath(d) {
  const pts = pathPoints(d);
  return pts.length > 0 && !pts.some(p => p.rel);
}

// `d` with its points replaced by `points` (as returned by `pathPoints`, with
// x/y changed).  Every command, its order and its untouched parameters survive
// verbatim — a viseme that keeps its command signature keeps morphing.
export function withPathPoints(d, points) {
  const toks = pathTokens(d);
  for (const p of points) {
    if (p.xi >= 0) toks[p.xi] = String(rn(p.x));
    if (p.yi >= 0) toks[p.yi] = String(rn(p.y));
  }
  return joinTokens(toks);
}

// Tokens back to a `d`, with each command letter leading its own numbers.
function joinTokens(toks) {
  return toks.join(" ").trim();
}

// Bounding box of everything `d` names, or null when it names nothing.
// Control points are included, which is conservative in the one direction that
// matters: a box built from this can never be too small for the curve.
function arcExtrema(x1, y1, x2, y2, values) {
  let [rx, ry, rotation, large, sweep] = values;
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry || (x1 === x2 && y1 === y2)) return [];
  const phi = rotation * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const x = (cos * (x1 - x2) + sin * (y1 - y2)) / 2;
  const y = (-sin * (x1 - x2) + cos * (y1 - y2)) / 2;
  const stretch = Math.hypot(x / rx, y / ry);
  if (stretch > 1) { rx *= stretch; ry *= stretch; }
  // SVG endpoint-to-center conversion, including radii correction.
  const denominator = rx * rx * y * y + ry * ry * x * x;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0,
    (rx * rx * ry * ry - denominator) / denominator));
  const localX = factor * rx * y / ry, localY = -factor * ry * x / rx;
  const cx = cos * localX - sin * localY + (x1 + x2) / 2;
  const cy = sin * localX + cos * localY + (y1 + y2) / 2;
  const start = Math.atan2((y - localY) / ry, (x - localX) / rx);
  const end = Math.atan2((-y - localY) / ry, (-x - localX) / rx);
  const tau = 2 * Math.PI, positive = angle => (angle % tau + tau) % tau;
  const span = sweep ? positive(end - start) : positive(start - end);
  const ax = Math.atan2(-ry * sin, rx * cos);
  const ay = Math.atan2(ry * cos, rx * sin);
  return [ax, ax + Math.PI, ay, ay + Math.PI]
    .filter(angle => (sweep ? positive(angle - start) : positive(start - angle)) <= span + 1e-10)
    .map(angle => ({
      x: cx + rx * cos * Math.cos(angle) - ry * sin * Math.sin(angle),
      y: cy + rx * sin * Math.cos(angle) + ry * cos * Math.sin(angle),
    }));
}

export function pathBBox(d) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const points = pathPoints(d);
  let x = 0, y = 0, startX = 0, startY = 0;
  walk(d, (cmd, up, values, _at, first) => {
    if (up === "Z") { x = startX; y = startY; return; }
    const relative = cmd !== up && !(first && up === "M");
    const nextX = up === "V" ? x : (relative ? x : 0) + values[up === "H" ? 0 : values.length - 2];
    const nextY = up === "H" ? y : (relative ? y : 0) + values.at(-1);
    if (up === "A") points.push(...arcExtrema(x, y, nextX, nextY, values));
    x = nextX; y = nextY;
    if (up === "M") { startX = x; startY = y; }
  });
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX > maxX) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Shift a path by (dx, dy).  Absolute coordinates move; relative ones are
// already deltas and must not, save the leading `m` that SVG itself defines as
// absolute.
export function translatePathD(d, dx, dy) {
  if (!dx && !dy) return String(d || "");
  const moved = [];
  walk(d, (cmd, up, nums, at, first) => {
    if (!(cmd === up || (first && up === "M"))) return;
    const spec = CMD_PARAMS[up];
    for (let k = 0; k < spec.length; k++) {
      if (spec[k] === "x") moved.push([at[k], rn(nums[k] + dx)]);
      else if (spec[k] === "y") moved.push([at[k], rn(nums[k] + dy)]);
    }
  });
  const toks = pathTokens(d);
  for (const [i, n] of moved) toks[i] = String(n);
  return joinTokens(toks);
}

// A path's leading `m` is absolute — SVG's own rule, because there is no point
// for it to be relative to.  That stops being true the moment the path is
// joined behind another as a subpath, where the same `m` becomes a delta from
// wherever the previous one ended, so it is spelled out before joining.
//
// Only the moveto itself is absolute: the pairs that follow it are implicit
// linetos that inherit its case, so they are given the explicit relative
// lineto they always meant rather than being promoted along with it.
export function absoluteStart(d) {
  const s = String(d || "").trimStart();
  if (!s.startsWith("m")) return s;
  const toks = pathTokens(s);
  let n = 1;
  while (n < toks.length && !isCmd(toks[n])) n++;
  if (n <= 3) return "M" + s.slice(1);   // one pair: the letter is the whole edit
  return ["M", toks[1], toks[2], "l", ...toks.slice(3)].join(" ");
}

// The command letters of a path, uppercased — "MCCZ" for the standard lip
// shape.  Two shapes only morph cleanly when their signatures match.
export function pathCommandSig(d) {
  return pathTokens(d).filter(isCmd).join("").toUpperCase();
}

// Scale a path's geometry, optionally offsetting it: `(x*sx + ox, y*sy + oy)`.
// A relative segment is a delta — it scales, but it is never offset, or every
// repeat would re-apply the shift and smear the shape across the canvas.
export function scalePathD(d, sx, sy, ox = 0, oy = 0) {
  const edits = [];
  walk(d, (cmd, up, nums, at, first) => {
    const abs = cmd === up || (first && up === "M");
    const spec = CMD_PARAMS[up];
    for (let k = 0; k < spec.length; k++) {
      const kind = spec[k];
      if (kind === "n") {
        // An arc's radii scale with the shape; its rotation and flags do not.
        if (up === "A" && k < 2) edits.push([at[k], rn(nums[k] * (k === 0 ? sx : sy))]);
        continue;
      }
      edits.push([at[k], kind === "x" ? rn(nums[k] * sx + (abs ? ox : 0))
                                      : rn(nums[k] * sy + (abs ? oy : 0))]);
    }
  });
  const toks = pathTokens(d);
  for (const [i, n] of edits) toks[i] = String(n);
  return joinTokens(toks);
}
