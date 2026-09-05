import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VISEMES, GESTURES, performanceAt, exportFramePlan, analyzeAudio, shapePath, encodeWav, drawFrame, buildLax, totalDuration } from "../performance.mjs";
import { STANDARD_VISEMES } from "../lib/mouthshapes.js";
import { pathCommandSig, pathPoints, scalePathD, translatePathD } from "../lib/pathdata.js";

const audio = (samples, sampleRate = 1000) => ({
  length: samples[0].length, numberOfChannels: samples.length, sampleRate,
  getChannelData: channel => Float32Array.from(samples[channel]),
});
const dataUrl = buffer => `data:audio/wav;base64,${Buffer.from(encodeWav(buffer)).toString("base64")}`;
const project = () => ({
  title: 'Maya & "friends"', selectedCharacter: 0, pace: 100, energy: 64, strength: 72,
  expression: "Warm", gesture: "Wave", toggles: { blink: true, follow: true, lipSync: true },
  characters: [{ name: "Maya", mouthSettings: { aa: { width: 125, opening: 75 } }, lipColor: "#812345", skinColor: "#fce4d6" }],
  scenes: [{ duration: 4, cues: [{ frame: 0, phoneme: "rest" }, { frame: 3, phoneme: "aa" }] }],
});

test("visemes reuse Face Tool geometry and percentage transforms preserve topology", () => {
  assert.equal(VISEMES, STANDARD_VISEMES);
  for (const v of VISEMES) {
    assert.equal(shapePath(v.phoneme), scalePathD(v.d, 1, 1));
    const transformed = shapePath(v.phoneme, { width: 150, opening: 50 });
    assert.equal(pathCommandSig(transformed), "MCCZ");
    assert.deepEqual(pathPoints(transformed), pathPoints(scalePathD(v.d, 1.5, 0.5, -20, 10)));
  }
  assert.equal(shapePath("unknown"), shapePath("rest"));
});

test("audio analysis emits structured canonical silence and speech cues", () => {
  assert.deepEqual(analyzeAudio(null), [{ frame: 0, phoneme: "rest" }]);
  assert.deepEqual(analyzeAudio(audio([Array(1000).fill(0)])), [{ frame: 0, phoneme: "rest" }]);
  const samples = Array.from({ length: 1000 }, (_, i) => i < 100 || i > 800 ? 0 : Math.sin(i) * i / 1000);
  const cues = analyzeAudio(audio([samples]));
  assert.ok(cues.some(cue => cue.phoneme !== "rest"));
  assert.equal(cues.at(-1).phoneme, "rest");
  assert.ok(cues.every((cue, i) => VISEMES.some(v => v.phoneme === cue.phoneme) && (!i || cue.frame > cues[i - 1].frame)));
  assert.deepEqual(analyzeAudio(audio([[]])), [{ frame: 0, phoneme: "rest" }]);
});

test("WAV encoder writes interleaved clipped PCM16 and correct metadata", () => {
  const wav = encodeWav(audio([[-2, 0, 2], [1, -1, 0.5]], 48000));
  const view = new DataView(wav);
  assert.equal(Buffer.from(wav).toString("ascii", 0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), wav.byteLength - 8);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(28, true), 192000);
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, 32767, 0, -32768, 32767, 16384]);
});

function capture(p, scene, time, includeStrokes = false) {
  const painted = [];
  const ctx = { save() {}, restore() {}, setTransform() {}, clearRect() {},
    fill(path) { painted.push({ d: path.d, fill: this.fillStyle }); },
    stroke(path) { if (includeStrokes) painted.push({ d: path.d, stroke: this.strokeStyle }); } };
  const old = globalThis.Path2D;
  globalThis.Path2D = class { constructor(d) { this.d = d; } };
  try { drawFrame({ width: 640, height: 480, getContext: () => ctx }, p, scene, time); }
  finally { if (old === undefined) delete globalThis.Path2D; else globalThis.Path2D = old; }
  return painted;
}

test("canvas honors source-time lip sync, character, settings, blink, gesture and toggles", () => {
  const p = project();
  p.toggles.follow = false;
  const scene = p.scenes[0];
  const rest = capture(p, scene, 0), open = capture(p, scene, 0.1);
  assert.notEqual(rest.at(-1).d, open.at(-1).d);
  assert.equal(open.at(-1).d, translatePathD(shapePath("aa", p.characters[0].mouthSettings.aa), 280, 244));
  assert.equal(open.at(-1).fill, "#812345");
  assert.notDeepEqual(capture(p, scene, 3.4), open);
  p.toggles.lipSync = false;
  assert.equal(capture(p, scene, 0.1).at(-1).d, rest.at(-1).d);
  p.characters.push({ lipColor: "#abcdef" });
  assert.equal(capture(p, { ...scene, characterIndex: 1 }, 0).at(-1).fill, "#abcdef");
});

test("all new gestures are distinct, animated, and use matching exported paths", () => {
  assert.equal(GESTURES.length, 10);
  assert.equal(new Set(GESTURES.map(g => g.name)).size, 10);
  const p = project();
  p.toggles = { follow: false, blink: false, lipSync: false };
  p.scenes[0].duration = 0.6;
  const poses = new Set();
  for (const gesture of ["Nod", "Shake", "Shrug", "Cheer", "Clap", "Think"]) {
    p.gesture = gesture;
    const first = capture(p, p.scenes[0], 0, true);
    const next = capture(p, p.scenes[0], 0.2, true);
    assert.notDeepEqual(first, next, `${gesture} moves with natural head follow disabled`);
    poses.add(JSON.stringify(next));
    const lax = buildLax(p);
    for (const part of next) {
      assert.ok(lax.includes(`d="${part.d}"`), `${gesture} exports the preview geometry`);
      assert.ok(!/NaN|Infinity/.test(part.d), `${gesture} has finite geometry`);
    }
    p.energy = 0;
    assert.deepEqual(capture(p, p.scenes[0], 0, true), capture(p, p.scenes[0], 0.2, true), `${gesture} respects zero energy`);
    p.energy = 64;
  }
  assert.equal(poses.size, 6);
});

test("face and gesture cues hold per scene and restart gesture motion at the keyed time", () => {
  const p = project();
  const s = p.scenes[0];
  s.expressionCues = [{ frame: 30, value: "Focused" }, { frame: 60, value: "Bright" }];
  s.gestureCues = [{ frame: 15, value: "Clap" }, { frame: 45, value: "Cheer" }];
  assert.deepEqual(performanceAt(p, s, 0), { expression: "Warm", gesture: "Wave", camera: "close-up", gestureTime: 0 });
  assert.deepEqual(performanceAt(p, s, 0.5), { expression: "Warm", gesture: "Clap", camera: "close-up", gestureTime: 0 });
  assert.deepEqual(performanceAt(p, s, 1.2), { expression: "Focused", gesture: "Clap", camera: "close-up", gestureTime: 0.7 });
  assert.deepEqual(performanceAt(p, s, 2), { expression: "Bright", gesture: "Cheer", camera: "close-up", gestureTime: 0.5 });
  assert.equal(performanceAt(p, { duration: 4 }, 2).gesture, "Wave");
  p.pace = 150;
  assert.equal(performanceAt(p, s, 1).expression, "Focused", "cues stay on the source audio clock");
});

test("paced face, gesture and camera timeline export matches preview at cue boundaries", () => {
  const p = project();
  p.pace = 150;
  p.scenes[0].duration = 1.5;
  p.scenes[0].expressionCues = [{ frame: 15, value: "Focused" }, { frame: 30, value: "Surprised" }];
  p.scenes[0].gestureCues = [{ frame: 15, value: "Clap" }, { frame: 30, value: "Nod" }];
  p.scenes[0].cameraCues = [{ frame: 15, value: "medium shot" }, { frame: 30, value: "wide shot" }];
  const lax = buildLax(p);
  for (const [sourceTime, outputFrame] of [[0.5, 10], [1, 20]]) {
    const before = capture(p, p.scenes[0], sourceTime - 0.05, true);
    const at = capture(p, p.scenes[0], sourceTime, true);
    assert.notDeepEqual(at, before);
    for (const item of at.filter(item => !before.some(previous => previous.d === item.d))) {
      assert.ok(lax.includes(`<mx:Keyframe frame="${outputFrame}" d="${item.d}"`), `keyed performance at output frame ${outputFrame}`);
    }
  }
});

test("camera changes hold until the next cue without altering scene defaults", () => {
  const p = project();
  const s = { ...p.scenes[0], detail: "medium shot",
    cameraCues: [{ frame: 15, value: "wide shot" }, { frame: 45, value: "close-up" }] };
  const before = JSON.stringify(s);
  assert.equal(performanceAt(p, s, 0.49).camera, "medium shot");
  assert.equal(performanceAt(p, s, 0.5).camera, "wide shot");
  assert.equal(performanceAt(p, s, 1.49).camera, "wide shot");
  assert.equal(performanceAt(p, s, 1.5).camera, "close-up");
  assert.equal(performanceAt(p, s, 3).camera, "close-up");
  assert.equal(performanceAt(p, p.scenes[0], 1).camera, "close-up");
  assert.equal(JSON.stringify(s), before);
});

test("video and LAX share paced, contiguous frame boundaries for fractional scenes", () => {
  const p = project();
  p.pace = 150;
  p.scenes = [{ duration: 0.17 }, { duration: 0.27 }, { duration: 0.14 }];
  const plan = exportFramePlan(p);
  assert.deepEqual(plan.map(({ start, end }) => [start, end]), [[0, 3], [3, 9], [9, 12]]);
  const lax = buildLax(p);
  for (const { start, end } of plan) {
    assert.ok(lax.includes(`frame="${start}" visible="1"`));
    assert.ok(lax.includes(`frame="${end}" visible="0"`));
  }
  assert.match(lax, /--frames 12 /);
});

test("export sequences scenes, embeds and retimes PCM audio, and matches canvas path keys", () => {
  const p = project();
  p.pace = 200;
  p.toggles.follow = false;
  p.scenes[0].audio = { src: dataUrl(audio([Array(5000).fill(0.5)])) };
  p.scenes.push({ duration: 2, cues: [{ frame: 0, phoneme: "FF" }], audio: p.scenes[0].audio });
  const before = JSON.stringify(p);
  const lax = buildLax(p);
  assert.equal(totalDuration(p), 3);
  assert.match(lax, /name="Maya &amp; &quot;friends&quot;"/);
  assert.match(lax, /sound="voice-0" frame="0"/);
  assert.match(lax, /sound="voice-1" frame="60"/);
  assert.match(lax, /frame="90" visible="0"/);
  assert.match(lax, /la export scene.lax --format mp4 --frames 90 -o scene.mp4/);
  assert.match(lax, /<mx:Face id="face-1" sound="voice-1" mouth="scene-1-part-13">/);
  assert.match(lax, /<mx:Viseme phoneme="FF" frame="60"\/>/);
  assert.doesNotMatch(lax, /loop="true"/);
  assert.ok(lax.includes(capture(p, p.scenes[0], 0.2).at(-1).d));
  const sources = [...lax.matchAll(/src="data:audio\/wav;base64,([^"]+)"/g)];
  for (const [index, match] of sources.entries()) {
    const wav = Buffer.from(match[1], "base64");
    assert.equal(wav.readUInt32LE(24), 2000);
    assert.equal(wav.readUInt32LE(28), 4000);
    assert.equal(wav.readUInt32LE(40), (index ? 2 : 4) * 1000 * 2);
  }
  assert.equal(JSON.stringify(p), before);
  assert.throws(() => buildLax({ ...p, scenes: [{ duration: 1, audio: { src: "voice.wav" } }] }), /embedded PCM16 WAV/);
});

test("camera framing scales the character but not the background in preview and LAX", () => {
  const p = project();
  p.toggles.follow = false;
  const scene = p.scenes[0];
  const close = capture(p, { ...scene, detail: "close-up" }, 0.1);
  scene.detail = "wide shot";
  const wide = capture(p, scene, 0.1);
  assert.equal(wide[0].d, close[0].d);
  assert.equal(wide.at(-1).d, scalePathD(close.at(-1).d, 0.7, 0.7, 96, 144));
  assert.ok(buildLax(p).includes(wide.at(-1).d));
});

test("generated Lax compiles to paths, held visibility and embedded audio IR", t => {
  const cli = process.env.LA_CLI || fileURLToPath(new URL("../../../target/debug/la", import.meta.url));
  if (!process.env.LA_CLI && !existsSync(cli)) return t.skip("local la CLI is not built; set LA_CLI to enable native assertions");
  const source = new URL(`./.character-performance-${process.pid}.lax`, import.meta.url);
  const output = new URL(`./.character-performance-${process.pid}.json`, import.meta.url);
  const svg = new URL(`./.character-performance-${process.pid}.svg`, import.meta.url);
  const p = project();
  p.scenes[0].duration = 0.5;
  p.scenes[0].audio = { src: dataUrl(audio([Array(500).fill(0)])) };
  p.scenes[0].expressionCues = [{ frame: 3, value: "Focused" }];
  p.scenes[0].gestureCues = [{ frame: 3, value: "Nod" }];
  p.scenes[0].cameraCues = [{ frame: 3, value: "wide shot" }];
  p.scenes.push({ duration: 0.5, cues: [{ frame: 0, phoneme: "FF" }] });
  try {
    writeFileSync(source, buildLax(p));
    const run = spawnSync(cli, ["compile", fileURLToPath(source), "-o", fileURLToPath(output)], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const ir = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(ir.fps, 30);
    assert.equal(ir.audio[0].sound, "voice-0");
    assert.match(ir.sounds[0].src, /^data:audio\/wav;base64,/);
    assert.equal(ir.faces[0].mouth, "scene-0-part-13");
    assert.deepEqual(ir.faces[0].visemes, [{ phoneme: "rest", frame: 0 }, { phoneme: "aa", frame: 3 }]);
    assert.ok(JSON.stringify(ir).includes("scene-0-part-"));
    for (const [frame, sceneIndex, sourceFrame] of [[6, 0, 6], [18, 1, 3], [30, null, 0]]) {
      const render = spawnSync(cli, ["export", fileURLToPath(source), "--format", "svg", "--frame", String(frame), "-o", fileURLToPath(svg)], { encoding: "utf8" });
      assert.equal(render.status, 0, render.stderr || render.stdout);
      const snapshot = readFileSync(svg, "utf8");
      const mouths = [...snapshot.matchAll(/<path\b[^>]*>/g)].filter(m => m[0].includes("#812345"));
      assert.equal(mouths.length, sceneIndex === null ? 0 : 1, `scene visibility at frame ${frame}`);
      if (sceneIndex !== null) {
        // The native runtime tessellates path morphs into polylines.
        const actual = pathPoints(mouths[0][0].match(/\bd="([^"]+)"/)[1]);
        const expected = pathPoints(capture(p, p.scenes[sceneIndex], sourceFrame / 30).at(-1).d);
        assert.deepEqual(actual[0], expected[0], `runtime mouth origin at frame ${frame}`);
        const strokeWidth = Number(mouths[0][0].match(/stroke-width="([^"]+)"/)[1]);
        assert.ok(Math.abs(strokeWidth - (sceneIndex === 0 ? 1.4 : 2)) < 0.001, "camera scales the exported stroke with its geometry");
      }
    }
  } finally {
    rmSync(source, { force: true }); rmSync(output, { force: true }); rmSync(svg, { force: true });
  }
});
