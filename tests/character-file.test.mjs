import test from "node:test";
import assert from "node:assert/strict";
import { parseCharacter, serializeCharacter } from "../character-file.mjs";

const character = () => ({
  name: "Nova", role: "Presenter", skinColor: "#fce4d6", lipColor: "#8b3a3a",
  mouthSettings: { aa: { width: 140, opening: 160 } },
  artwork: { face: [{ d: "M 10 20 L 30 40 Z", fill: "#abcdef", stroke: "none", strokeWidth: 0 }], leftHand: [] },
});

test("character files round-trip settings and custom artwork without scene data", () => {
  const original = character();
  const copy = parseCharacter(serializeCharacter({ ...original, scenes: [{ audio: "private" }], unknown: true }));
  assert.deepEqual(copy, original);
  copy.artwork.face[0].fill = "#000000";
  assert.equal(original.artwork.face[0].fill, "#abcdef");
  assert.deepEqual(parseCharacter(serializeCharacter({ name: "Maya" })), { name: "Maya" });
});

test("character import rejects malformed files and unsupported versions", () => {
  for (const text of ["{", "null", "[]", '{}', '{"format":"littlea-character","version":2}']) {
    assert.throws(() => parseCharacter(text), /character|JSON/);
  }
});

test("character import validates names, colors, mouth settings and safe artwork", () => {
  for (const patch of [
    { name: " " }, { role: {} }, { skinColor: "url(https://example.com)" },
    { mouthSettings: [] }, { mouthSettings: { unknown: { width: 100, opening: 100 } } },
    { mouthSettings: { aa: { width: 181, opening: 100 } } },
    { mouthSettings: { aa: { width: 100, opening: "100" } } },
    { artwork: { canvas: [] } },
    { artwork: { face: [{ d: "M 0 0", fill: "url(https://example.com)", stroke: "none", strokeWidth: 0 }] } },
  ]) {
    const text = JSON.stringify({ format: "littlea-character", version: 1, character: { ...character(), ...patch } });
    assert.throws(() => parseCharacter(text), /Invalid/);
  }
});