import { validateArtwork } from "./artwork-model.mjs";
import { STANDARD_VISEMES } from "./lib/mouthshapes.js";

export const MAX_CHARACTER_FILE_SIZE = 20 * 1024 * 1024;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

function characterData(value) {
  if (!record(value) || typeof value.name !== "string" || !value.name.trim()) {
    throw new Error("Invalid character name.");
  }
  const character = { name: value.name };
  if (value.role !== undefined) {
    if (typeof value.role !== "string") throw new Error("Invalid character role.");
    character.role = value.role;
  }
  for (const key of ["lipColor", "skinColor"]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || !/^#[0-9a-f]{6}$/i.test(value[key])) {
      throw new Error("Invalid character color.");
    }
    character[key] = value[key];
  }
  if (value.mouthSettings !== undefined) {
    if (!record(value.mouthSettings)) throw new Error("Invalid mouth settings.");
    character.mouthSettings = {};
    for (const [phoneme, settings] of Object.entries(value.mouthSettings)) {
      if (!STANDARD_VISEMES.some(viseme => viseme.phoneme === phoneme) || !record(settings) ||
          !Number.isFinite(settings.width) || settings.width < 30 || settings.width > 180 ||
          !Number.isFinite(settings.opening) || settings.opening < 10 || settings.opening > 200) {
        throw new Error("Invalid mouth settings.");
      }
      character.mouthSettings[phoneme] = { width: settings.width, opening: settings.opening };
    }
  }
  validateArtwork(value.artwork, "character");
  if (value.artwork !== undefined) character.artwork = structuredClone(value.artwork);
  return character;
}

export function serializeCharacter(character) {
  return JSON.stringify({ format: "littlea-character", version: 1, character: characterData(character) }, null, 2);
}

export function parseCharacter(text) {
  if (typeof text !== "string" || text.length > MAX_CHARACTER_FILE_SIZE) {
    throw new Error("Character files must be smaller than 20 MB.");
  }
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("The character file is not valid JSON."); }
  if (data?.format !== "littlea-character" || data.version !== 1) {
    throw new Error("Choose a supported character file created with Export character.");
  }
  return characterData(data.character);
}