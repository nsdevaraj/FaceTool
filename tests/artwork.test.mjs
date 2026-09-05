import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ARTWORK_TARGETS, validateArtwork, partsToShapes, shapesToParts } from "../artwork-model.mjs";
import { buildSvg, buildLax, drawFrame, getArtworkForEditing, encodeWav } from "../performance.mjs";
import { buildPathD, ellipsePathD, validateSimpleShapes } from "../lib/svgeditor.js";
import { scalePathD, translatePathD, pathPoints, pathBBox } from "../lib/pathdata.js";

const part = (fill = "#123456") => ({ d: "M 10 20 L 30 40 L 50 20 Z", fill, stroke: "#abcdef", strokeWidth: 3 });
const project = () => ({
  pace: 150, energy: 70, strength: 72, gesture: "Wave",
  toggles: { follow: false, blink: true, lipSync: true },
  characters: [{ skinColor: "#fce4d6", lipColor: "#812345" }],
  scenes: [{ duration: 0.6, cues: [{ frame: 0, phoneme: "rest" }, { frame: 3, phoneme: "aa" }] }],
});
const svgParts = svg => [...svg.matchAll(/<path d="([^"]+)" fill="([^"]+)" stroke="([^"]+)" stroke-width="([^"]+)"/g)]
  .map(([, d, fill, stroke, width]) => ({ d, fill, stroke, strokeWidth: Number(width) }));
const snapshot = (p, time = 0, scene = p.scenes[0]) => svgParts(buildSvg(p, scene, time));

function capture(p, scene, time, options) {
  const painted = [];
  const ctx = {
    save() {}, restore() {}, setTransform() {}, clearRect() {},
    fill(path) { painted.push({ d: path.d, fill: this.fillStyle }); },
    stroke(path) { painted.push({ d: path.d, stroke: this.strokeStyle, strokeWidth: this.lineWidth }); },
  };
  const old = globalThis.Path2D;
  globalThis.Path2D = class { constructor(d) { this.d = d; } };
  try { drawFrame({ width: 640, height: 480, getContext: () => ctx }, p, scene, time, options); }
  finally { if (old === undefined) delete globalThis.Path2D; else globalThis.Path2D = old; }
  return painted;
}

function customProject() {
  const p = project();
  p.characters[0].artwork = { face: [part("#111111")], body: [part("#222222")],
    leftHand: [part("#333333")], rightHand: [part("#444444")] };
  p.scenes[0].artwork = { canvas: [part("#555555"), part("#666666")], foreground: [part("#777777")] };
  p.scenes[0].cameraCues = [{ frame: 6, value: "wide shot" }];
  return p;
}

test("transparent video omits only the canvas layer without mutating other exports", () => {
  const p = customProject(), scene = p.scenes[0], before = JSON.stringify(p);
  const opaque = capture(p, scene, 0.3);
  const transparent = capture(p, scene, 0.3, { transparentBackground: true });
  assert.deepEqual(transparent, opaque.slice(4), "two filled/stroked background paths are omitted");
  assert.ok(transparent.some(item => item.fill === "#777777"), "foreground is retained");
  assert.ok(transparent.some(item => item.fill === "#333333"), "animated hand is retained");
  assert.ok(buildSvg(p, scene).includes("#555555"), "SVG still includes the background");
  assert.ok(buildLax(p).includes("#555555"), "LAX still includes the background");
  assert.equal(JSON.stringify(p), before);
});

test("arc bounds cover face and hand artwork instead of only their endpoints", () => {
  const p = project();
  const face = pathBBox(getArtworkForEditing(p, p.scenes[0], "face")[0].d);
  assert.ok(face.h > 260 && face.w > 240);
  assert.deepEqual(pathBBox(getArtworkForEditing(p, p.scenes[0], "leftHand")[0].d), { x: 67, y: 67, w: 26, h: 26 });
  const half = pathBBox("M -10 0 A 10 10 0 0 0 10 0");
  assert.ok(Math.abs(half.x + 10) < 1e-8 && Math.abs(half.y) < 1e-8 && Math.abs(half.w - 20) < 1e-8 && Math.abs(half.h - 10) < 1e-8);
  const corrected = pathBBox("M -20 0 A 10 10 0 0 1 20 0");
  assert.ok(Math.abs(corrected.y + 20) < 1e-8 && Math.abs(corrected.h - 20) < 1e-8);
  const rotated = pathBBox("M 0 -20 A 20 10 90 1 0 0 20 A 20 10 90 1 0 0 -20 Z");
  assert.ok(Math.abs(rotated.w - 20) < 1e-8 && Math.abs(rotated.h - 40) < 1e-8);
  assert.deepEqual(pathBBox("M 100 100 a 13 13 0 1 0 26 0 a 13 13 0 1 0 -26 0 Z"), { x: 100, y: 87, w: 26, h: 26 });
});

test("editing targets provide canonical isolated seeds without changing default fourteen paths", () => {
  const p = project(), scene = p.scenes[0];
  assert.deepEqual(ARTWORK_TARGETS.map(t => [t.id, t.scope, t.width, t.height]), [
    ["face", "character", 640, 480], ["body", "character", 640, 480],
    ["leftHand", "character", 160, 160], ["rightHand", "character", 160, 160],
    ["canvas", "scene", 640, 480], ["foreground", "scene", 640, 480],
  ]);
  const before = JSON.stringify(p);
  assert.equal(snapshot(p).length, 14);
  const counts = [8, 2, 1, 1, 1, 0];
  ARTWORK_TARGETS.forEach((target, i) => {
    const parts = getArtworkForEditing(p, scene, target.id);
    assert.equal(parts.length, counts[i]);
    validateArtwork({ [target.id]: parts }, target.scope);
    assert.doesNotThrow(() => validateSimpleShapes(partsToShapes(parts)), `${target.id} seed opens in the drawing editor`);
    assert.deepEqual(shapesToParts(partsToShapes(parts)), parts);
    if (parts.length) parts[0].fill = "#000000";
  });
  assert.equal(JSON.stringify(p), before);
  assert.throws(() => getArtworkForEditing(p, scene, "mouth"), /Unknown artwork target/);
  const face = getArtworkForEditing(p, scene, "face");
  assert.ok(face.every(item => item.fill !== "#812345"), "lips are not baked into editable head");
  const hand = getArtworkForEditing(p, scene, "rightHand")[0];
  assert.equal(pathPoints(hand.d)[0].x, 67);
  assert.equal(pathPoints(hand.d)[0].y, 80);
});

test("all custom layers share preview, snapshot and paced LAX geometry and paints", () => {
  const p = customProject(), scene = p.scenes[0], before = JSON.stringify(p);
  const lax = buildLax(p);
  for (const time of [0, 0.1, 0.2, 0.35]) {
    const parts = snapshot(p, time);
    assert.deepEqual(parts.map(item => item.fill),
      ["#555555", "#666666", "#222222", "none", "none", "#111111", "#333333", "#444444", "#812345", "#777777"]);
    const expected = parts.flatMap(item => [
      ...(item.fill === "none" ? [] : [{ d: item.d, fill: item.fill }]),
      ...(item.stroke === "none" ? [] : [{ d: item.d, stroke: item.stroke, strokeWidth: item.strokeWidth }]),
    ]);
    assert.deepEqual(capture(p, scene, time), expected);
    for (const item of parts) assert.ok(lax.includes(`d="${item.d}"`), `LAX contains ${item.fill} at ${time}`);
  }
  assert.equal(JSON.stringify(p), before, "rendering and exporting do not mutate authored data");
  const at0 = snapshot(p, 0), wide = snapshot(p, 0.2);
  assert.deepEqual(wide.slice(0, 2), at0.slice(0, 2), "all canvas paths stay outside camera");
  assert.deepEqual(wide.at(-1), at0.at(-1), "foreground stays outside camera");
  for (const index of [2, 5, 6]) {
    assert.equal(wide[index].d, scalePathD(at0[index].d, 0.7, 0.7, 96, 144));
    assert.equal(wide[index].strokeWidth, 2.0999999999999996);
  }
  assert.notEqual(at0[7].d, snapshot(p, 0.1)[7].d, "right hand follows animated wave");
  assert.equal(at0[7].d, scalePathD(translatePathD(part().d, 410, 110), 1, 1));
  assert.equal(at0[6].d, scalePathD(translatePathD(part().d, 117, 365), 1, 1));
  assert.notEqual(at0[8].d, snapshot(p, 0.1)[8].d, "custom face retains live lips");
  assert.ok(lax.includes(`<mx:Keyframe frame="4" d="${wide[2].d}"`), "camera source frame6 is output frame4");
});

test("custom face follows head motion but bypasses automatic expressions and blinking", () => {
  const p = customProject();
  p.pace = 100;
  p.scenes[0].duration = 4;
  p.scenes[0].cameraCues = [];
  p.scenes[0].expressionCues = [{ frame: 3, value: "Surprised" }];
  assert.equal(snapshot(p, 0)[5].d, snapshot(p, 3.4)[5].d);
  p.gesture = "Nod";
  assert.notEqual(snapshot(p, 0)[5].d, snapshot(p, 0.2)[5].d);
  p.gesture = "Idle"; p.toggles.follow = true;
  assert.notEqual(snapshot(p, 0)[5].d, snapshot(p, 0.2)[5].d);
});

test("empty targets, target-local editing, character and scene isolation survive JSON", () => {
  const p = customProject();
  p.characters.push({});
  p.scenes.push({ duration: 0.2, characterIndex: 1 });
  const copy = JSON.parse(JSON.stringify(p));
  assert.deepEqual(snapshot(copy), snapshot(p));
  assert.equal(snapshot(p, 0, p.scenes[1]).length, 14);
  const face = getArtworkForEditing(p, p.scenes[0], "face");
  face[0].d = "M 0 0";
  assert.notEqual(p.characters[0].artwork.face[0].d, face[0].d);
  p.characters[0].artwork = { face: [], body: [], leftHand: [], rightHand: [] };
  p.scenes[0].artwork = { canvas: [], foreground: [] };
  assert.equal(snapshot(p).length, 3, "only arms and mouth remain");
  assert.deepEqual(getArtworkForEditing(p, p.scenes[0], "face"), []);
  assert.equal(snapshot(p, 0, p.scenes[1]).length, 14);
  const lax = buildLax(p);
  assert.match(lax, /id="scene-0-part-0"/);
});

test("basic editor shape conversion reuses curve geometry and retains all paint", () => {
  const style = { fill: "#123", stroke: "#abcdef", sw: 2.5, rotation: 0,
    linecap: "round", linejoin: "round", miterlimit: 4, dasharray: [], dashoffset: 0 };
  const pts = [{ x: 0, y: 0 }, { x: 20, y: 30 }, { x: 40, y: 0 }];
  const shapes = [
    { ...style, type: "rawpath", d: part().d, tx: 7, ty: -9 },
    { ...style, type: "path", pts, closed: true, smooth: true },
    { ...style, type: "path", pts, closed: false, smooth: false },
    { ...style, type: "ellipse", cx: 80, cy: 80, rx: 13, ry: 15 },
    { ...style, type: "rect", x: 3, y: 4, w: 10, h: 20 },
  ];
  const converted = shapesToParts(shapes);
  assert.doesNotThrow(() => validateSimpleShapes(partsToShapes(converted)), "converted paints reopen without loss");
  assert.deepEqual(converted.map(p => p.d), [
    translatePathD(part().d, 7, -9), buildPathD(pts, true, true), buildPathD(pts, false, false),
    ellipsePathD(80, 80, 13, 15), "M 3 4 H 13 V 24 H 3 Z",
  ]);
  for (const item of converted) assert.deepEqual({ ...item, d: "" },
    { d: "", fill: style.fill, stroke: style.stroke, strokeWidth: style.sw });
  const p = project();
  p.scenes[0].artwork = { foreground: converted };
  assert.match(buildLax(p), /fill="#112233" stroke="#abcdef"/);
});

test("zero-width strokes do not accidentally inherit the preceding canvas width", () => {
  const p = project();
  p.scenes[0].artwork = { foreground: [{ ...part("#101010"), strokeWidth: 0 }] };
  const painted = capture(p, p.scenes[0], 0);
  assert.deepEqual(painted.at(-1), { d: part().d, fill: "#101010" });
  assert.match(buildSvg(p, p.scenes[0]), /fill="#101010" stroke="#abcdef" stroke-width="0"/);
});

test("invalid imported artwork fails explicitly before rendering or XML escaping", () => {
  validateArtwork(undefined, "character");
  const invalid = [
    null, [], { canvas: [] }, { face: null }, { face: undefined }, { face: Array(201).fill(part()) },
    { face: [{ ...part(), fill: 'url(#gradient)' }] }, { face: [{ ...part(), stroke: 'red" onload="x' }] },
    { face: [{ ...part(), strokeWidth: Infinity }] }, { face: [{ ...part(), strokeWidth: -1 }] },
    { face: [{ ...part(), d: "M Infinity 0" }] }, { face: [{ ...part(), d: "M 1e309 0" }] },
    { face: [{ ...part(), d: "M 1000001 0" }] }, { face: [{ ...part(), d: "M 999999 0 l 2 0" }] },
    { face: [{ ...part(), d: "M 0 0 L" }] }, { face: [{ ...part(), d: "M 0 0 Z 1 2" }] },
    { face: [{ ...part(), d: "M 0 0 A 1 2 0 2 0 3 4" }] },
    { face: [{ ...part(), d: 'M 0 0" /><script/>' }] }, { face: [{ ...part(), d: "M 0 0".repeat(4001) }] },
    { face: [{ ...part(), d: "M,0 0" }] }, { face: [{ ...part(), d: "M 0 0," }] },
    { face: [{ ...part(), opacity: 0.5 }] }, { face: [{ d: part().d }] },
    { face: [{ ...part(), d: "M 0 0 A 10 20 30 0 1 50 50" }] },
    { face: [{ ...part(), fill: "#1234" }] }, { face: [{ ...part(), stroke: "#12345680" }] },
  ];
  for (const [index, value] of invalid.entries()) {
    assert.throws(() => validateArtwork(value, "character"), /Invalid artwork/, `invalid example ${index}`);
    const p = project();
    p.characters[0].artwork = value;
    assert.throws(() => buildLax(p), /Invalid artwork/);
    assert.throws(() => buildSvg(p, p.scenes[0]), /Invalid artwork/);
    assert.throws(() => capture(p, p.scenes[0], 0), /Invalid artwork/);
  }
  for (const change of [
    { rotation: 1 }, { type: "text" }, { fill: "url(#g)" }, { linecap: "butt" }, { linejoin: "miter" },
    { dasharray: [3, 2] }, { dashoffset: 2 }, { miterlimit: 5 }, { opacity: 0.5 }, { tx: Infinity },
  ]) assert.throws(() => shapesToParts([{ ...partsToShapes([part()])[0], ...change }]), /Invalid artwork/);
});

test("native custom scene compiles, renders, and targets actual mouth before foreground", t => {
  const cli = process.env.LA_CLI || fileURLToPath(new URL("../../../target/debug/la", import.meta.url));
  if (!process.env.LA_CLI && !existsSync(cli)) return t.skip("local la CLI is not built");
  const p = customProject();
  const wav = encodeWav({ length: 600, numberOfChannels: 1, sampleRate: 1000, getChannelData: () => new Float32Array(600) });
  p.scenes[0].audio = { src: `data:audio/wav;base64,${Buffer.from(wav).toString("base64")}` };
  const source = new URL(`./.artwork-${process.pid}.lax`, import.meta.url);
  const output = new URL(`./.artwork-${process.pid}.json`, import.meta.url);
  const svg = new URL(`./.artwork-${process.pid}.svg`, import.meta.url);
  try {
    const lax = buildLax(p);
    assert.match(lax, /mouth="scene-0-part-8"/);
    writeFileSync(source, lax);
    const compile = spawnSync(cli, ["compile", fileURLToPath(source), "-o", fileURLToPath(output)], { encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const ir = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(ir.faces[0].mouth, "scene-0-part-8");
    for (const frame of [0, 2, 4]) {
      const render = spawnSync(cli, ["export", fileURLToPath(source), "--format", "svg", "--frame", String(frame), "-o", fileURLToPath(svg)], { encoding: "utf8" });
      assert.equal(render.status, 0, render.stderr || render.stdout);
      const rendered = readFileSync(svg, "utf8");
      for (const expected of snapshot(p, frame * 1.5 / 30).filter(item => item.fill !== "none")) {
        const tag = [...rendered.matchAll(/<path\b[^>]*>/g)].find(m => m[0].includes(`fill="${expected.fill}"`))?.[0];
        assert.ok(tag, `${expected.fill} visible at native frame${frame}`);
        const actual = pathPoints(tag.match(/\bd="([^"]+)"/)[1])[0];
        const point = pathPoints(expected.d)[0];
        assert.deepEqual([actual.x, actual.y], [point.x, point.y]);
      }
    }
  } finally {
    for (const file of [source, output, svg]) rmSync(file, { force: true });
  }
});
