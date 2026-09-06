import { createSvgEditor } from "./lib/svgeditor.js";
import { ARTWORK_TARGETS, partsToShapes, shapesToParts } from "./artwork-model.mjs";
import { getArtworkForEditing, drawFrame } from "./performance.mjs";
import { $, $$ } from "./ui.mjs";
import { mountArtworkToolbar } from "./artwork-toolbar.mjs";
import { MAX_CHARACTER_FILE_SIZE, parseCharacter, serializeCharacter } from "./character-file.mjs";

const signature = shapes => JSON.stringify(shapesToParts(shapes));
const descriptions = {
  face: "Character face artwork. Lips keep their audio animation; custom eyes and brows replace automatic blink and expressions. Head motion stays active.",
  body: "Character neck and clothing artwork. Camera framing still applies.",
  leftHand: "Character left hand, centered on the wrist at (80, 80). The hand follows the left arm through every gesture.",
  rightHand: "Character right hand, centered on the wrist at (80, 80). The hand follows the right arm through every gesture.",
  canvas: "Scene background and decorations behind the character. Draw anywhere on the 640 x 480 canvas.",
  foreground: "Scene decorations in front of the character. Draw anywhere on the 640 x 480 canvas.",
};

export function createArtworkEditor({ getProject, getScene, getTime, onApply, download }) {
  const modal = $("#artwork-modal");
  const host = $("#artwork-editor");
  const status = $("#artwork-status");
  const picker = $("#artwork-target");
  const characterFile = $("#artwork-character-file");
  picker.replaceChildren(...ARTWORK_TARGETS.map(target => {
    const option = document.createElement("option");
    option.value = target.id;
    option.textContent = target.label;
    return option;
  }));
  const drafts = new Map();
  let editor, target, previousFocus, project, scene, character, disposeToolbar;
  let liveProject, characterIndex, importVersion = 0;
  const error = value => { status.textContent = value.message || String(value); };
  const owner = item => item.scope === "character" ? character : scene;

  function storeDraft() {
    if (editor) drafts.get(target.id).shapes = editor.getShapes();
  }

  function editedProject() {
    storeDraft();
    const changes = [];
    for (const [id, draft] of drafts) {
      const item = ARTWORK_TARGETS.find(t => t.id === id);
      if (signature(draft.shapes) !== draft.initial) {
        changes.push({ item, parts: shapesToParts(draft.shapes) });
      } else if (draft.reset) changes.push({ item, parts: undefined });
    }
    return changes;
  }

  function draftState() {
    const changes = editedProject();
    const previewCharacter = { ...character, artwork: { ...character.artwork } };
    const previewScene = { ...scene, artwork: { ...scene.artwork } };
    for (const { item, parts } of changes) {
      const data = item.scope === "character" ? previewCharacter.artwork : previewScene.artwork;
      if (parts === undefined) delete data[item.id];
      else data[item.id] = parts;
    }
    return { previewCharacter, previewScene };
  }

  function preview() {
    const { previewCharacter, previewScene } = draftState();
    drawFrame($("#artwork-preview"), {
      ...project, characters: project.characters.map(c => c === character ? previewCharacter : c),
    }, previewScene, getTime());
    status.textContent = "Draft preview updated. Apply to save; Cancel discards all draft edits.";
  }

  function mount(id) {
    storeDraft();
    disposeToolbar?.();
    editor?.destroy();
    target = ARTWORK_TARGETS.find(t => t.id === id);
    if (!target) throw new Error("Unknown artwork target.");
    picker.value = id;
    if (!drafts.has(id)) {
      const shapes = partsToShapes(getArtworkForEditing(project, scene, id));
      drafts.set(id, { shapes, initial: signature(shapes), reset: false });
    }
    editor = createSvgEditor(host, {
      canvasWidth: target.width, canvasHeight: target.height,
      simplePaths: true, onError: error,
    });
    editor.setShapes(drafts.get(id).shapes);
    editor.selectShapeAt(0);
    disposeToolbar = mountArtworkToolbar(host);
    const svg = $('svg[data-ed$=":canvas"]', host);
    svg.setAttribute("viewBox", `0 0 ${target.width} ${target.height}`);
    svg.style.width = `${target.width < 300 ? 400 : target.width}px`;
    svg.style.height = "auto";
    $("#artwork-help").textContent = descriptions[id];
    status.textContent = "Select a shape to move, resize or drag its nodes. Use the drawing tools to add shapes.";
  }

  function close() {
    importVersion++;
    characterFile.value = "";
    disposeToolbar?.();
    disposeToolbar = null;
    editor?.destroy();
    editor = null;
    host.replaceChildren();
    drafts.clear();
    modal.classList.remove("open");
    $("main").inert = false;
    previousFocus?.focus();
  }

  function reset() {
    const data = { ...owner(target).artwork };
    delete data[target.id];
    const defaultCharacter = target.scope === "character" ? { ...character, artwork: data } : character;
    const defaultScene = target.scope === "scene" ? { ...scene, artwork: data } : scene;
    const defaultProject = { ...project, characters: project.characters.map(c => c === character ? defaultCharacter : c) };
    const shapes = partsToShapes(getArtworkForEditing(defaultProject, defaultScene, target.id));
    drafts.set(target.id, { shapes, initial: signature(shapes), reset: true });
    editor.setShapes(shapes);
    preview();
    status.textContent = "Default artwork restored in the draft. Apply to save this reset.";
  }

  picker.addEventListener("change", () => {
    try { mount(picker.value); } catch (e) { error(e); }
  });
  characterFile.addEventListener("change", async () => {
    const file = characterFile.files[0];
    if (!file) return;
    const version = ++importVersion;
    try {
      if (file.size > MAX_CHARACTER_FILE_SIZE) throw new Error("Character files must be smaller than 20 MB.");
      const text = await file.text();
      if (version !== importVersion) return;
      const imported = parseCharacter(text);
      storeDraft();
      disposeToolbar?.();
      disposeToolbar = null;
      editor?.destroy();
      editor = null;
      for (const item of ARTWORK_TARGETS) {
        if (item.scope === "character") drafts.delete(item.id);
      }
      character = imported;
      project.characters[characterIndex] = character;
      mount(target.id);
      preview();
      status.textContent = `Imported "${character.name}" into the draft. Apply artwork replaces the current character; Cancel keeps the original.`;
    } catch (e) {
      if (version === importVersion) error(e);
    } finally {
      if (version === importVersion) characterFile.value = "";
    }
  });
  modal.addEventListener("click", event => {
    const action = event.target.closest("[data-artwork-action]")?.dataset.artworkAction;
    if (!action) return;
    try {
      if (action === "cancel") close();
      else if (action === "reset") reset();
      else if (action === "preview") preview();
      else if (action === "import-character") characterFile.click();
      else if (action === "export-character") {
        const { previewCharacter } = draftState();
        const file = new Blob([serializeCharacter(previewCharacter)], { type: "application/json" });
        if (file.size > MAX_CHARACTER_FILE_SIZE) throw new Error("Character files must be smaller than 20 MB.");
        const name = character.name.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "character";
        download(`${name}.character.json`, file);
        status.textContent = "Character exported with draft artwork, colors and mouth settings. Scene layers and audio are not included.";
      }
      else if (action === "download") {
        shapesToParts(editor.getShapes());
        download(`${target.id}.svg`, new Blob([editor.exportSvg(target.width, target.height)], { type: "image/svg+xml" }));
        status.textContent = "SVG downloaded for the selected artwork target.";
      } else if (action === "apply") {
        const changes = editedProject();
        for (const { item, parts } of changes) {
          const data = owner(item).artwork ??= {};
          if (parts === undefined) delete data[item.id];
          else data[item.id] = parts;
        }
        liveProject.characters[characterIndex] = character;
        close();
        onApply();
      }
    } catch (e) { error(e); }
  });
  modal.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      const focusable = $$('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]', modal)
        .filter(el => el.getClientRects().length && !el.closest("[hidden]"));
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  return {
    open(id = "canvas") {
      previousFocus = document.activeElement;
      liveProject = getProject();
      scene = getScene();
      characterIndex = scene.characterIndex ?? liveProject.selectedCharacter ?? 0;
      character = structuredClone(liveProject.characters[characterIndex]);
      project = { ...liveProject, characters: [...liveProject.characters] };
      project.characters[characterIndex] = character;
      drafts.clear();
      modal.classList.add("open");
      $("main").inert = true;
      try {
        mount(id);
        drawFrame($("#artwork-preview"), project, scene, getTime());
        picker.focus();
      } catch (e) {
        close();
        throw e;
      }
    },
    close,
  };
}
