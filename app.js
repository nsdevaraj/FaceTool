import { VISEMES, GESTURES, EXPRESSIONS, CAMERA_SHOTS, performanceAt, analyzeAudio, shapePath, encodeWav, drawFrame, buildLax, buildSvg } from "./performance.mjs";
import { renderCharacterVideo } from "./video.mjs";
import { $, $$, escapeHtml, toast } from "./ui.mjs";
import { validateArtwork } from "./artwork-model.mjs";
import { createArtworkEditor } from "./artwork-editor.mjs";
import { initializeStudioLayout, setButtonIcon, showInspector, toggleStageFullscreen, updateStudioSummary } from "./studio-layout.mjs";

const FPS = 30;
initializeStudioLayout();
const TRACK_LABELS = { expression: "Face", gesture: "Gesture", camera: "Camera" };
const defaults = {
  title: "Coffee Break", selectedScene: 0, selectedCharacter: 0,
  characters: [{ name: "Maya", role: "Conversational host" }],
  expression: "Warm", gesture: "Idle", pace: 100, energy: 64, strength: 72,
  toggles: { blink: true, follow: true, lipSync: true },
  scenes: [{ name: "Intro", detail: "close-up", icon: "01", duration: 8, characterIndex: 0,
    line: "Import or record your dialogue to bring this character to life." }],
};
let project = structuredClone(defaults);
let elapsed = 0;
let playing = false;
let playGeneration = 0;
let playbackPending = false;
let scrub = null;
let selectedChange = null;
let frameRequest = 0;
let playbackStart = 0;
let audioContext;
let source;
let recorder;
let recordingStream;
let recordingPending = false;
let busy = false;
let exportCancelled = false;
let cancelVideo = null;
let selectedPose = VISEMES[0].phoneme;
let previewPose = false;
let db;
let saveQueue = Promise.resolve();
let saveVersion = 0;
const buffers = new WeakMap();
const canvas = $("#character-canvas");
$(".tool-grid").innerHTML = GESTURES.map(({ name, icon }) =>
  `<button class="tool" type="button" data-select="${name}" aria-pressed="false"><b aria-hidden="true">${icon}</b>${name}</button>`).join("");
const scene = () => project.scenes[project.selectedScene];
const character = () => project.characters[scene().characterIndex ?? project.selectedCharacter];
const rate = () => project.pace / 100;
const artworkEditor = createArtworkEditor({
  getProject: () => project, getScene: scene, getTime: () => elapsed, download,
  onApply() { previewPose = false; render(); saveProject(); toast("SVG artwork saved."); },
});
const report = error => {
  console.error(error);
  $("#studio-status").textContent = error.message || String(error);
  toast(error.message || String(error));
};
const run = action => Promise.resolve().then(action).catch(report);
const time = seconds => `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;

function validateProject(value) {
  const p = value?.project ?? value;
  if (!p || typeof p.title !== "string" || !Array.isArray(p.characters) || !p.characters.length
      || !Array.isArray(p.scenes) || !p.scenes.length || p.scenes.length > 100) {
    throw new Error("This is not a Character Studio project.");
  }
  const number = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
  if (!p.characters.every(c => c && typeof c.name === "string" && c.name.trim())) throw new Error("Invalid character name.");
  for (const c of p.characters) {
    validateArtwork(c.artwork, "character");
    for (const color of [c.lipColor, c.skinColor]) {
      if (color !== undefined && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Invalid character color.");
    }
    for (const [key, settings] of Object.entries(c.mouthSettings ?? {})) {
      if (!VISEMES.some(v => v.phoneme === key) || !number(settings?.width, 30, 180)
          || !number(settings?.opening, 10, 200)) throw new Error("Invalid mouth settings.");
    }
  }
  for (const s of p.scenes) {
    if (!s || typeof s.name !== "string" || !number(s.duration, 0.1, 600)
        || typeof s.line !== "string") throw new Error("Invalid scene or duration (maximum 10 minutes per scene).");
    validateArtwork(s.artwork, "scene");
    if (s.characterIndex !== undefined && (!Number.isInteger(s.characterIndex) || !p.characters[s.characterIndex])) throw new Error("Invalid scene character.");
    if (s.audio && (typeof s.audio.src !== "string" || !/^data:audio\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]+$/.test(s.audio.src))) throw new Error("Project audio must be embedded, not an external URL.");
    if (s.cues && (!Array.isArray(s.cues) || !s.cues.every(c => Number.isInteger(c.frame)
        && number(c.frame, 0, Math.ceil(s.duration * FPS)) && VISEMES.some(v => v.phoneme === c.phoneme)))) throw new Error("Invalid lip timeline.");
    if (s.waveform && (!Array.isArray(s.waveform) || s.waveform.length > 256 || !s.waveform.every(v => number(v, 0, 1)))) throw new Error("Invalid waveform.");
    for (const [key, values] of [["expressionCues", EXPRESSIONS], ["gestureCues", GESTURES.map(g => g.name)], ["cameraCues", CAMERA_SHOTS]]) {
      const cues = s[key];
      if (cues !== undefined && (!Array.isArray(cues) || cues.length > Math.ceil(s.duration * FPS)
          || !cues.every(c => c && Number.isInteger(c.frame) && number(c.frame, 0, Math.ceil(s.duration * FPS) - 1) && values.includes(c.value))
          || new Set(cues.map(c => c.frame)).size !== cues.length)) throw new Error(`Invalid ${key} timeline.`);
    }
  }
  for (const [key, min, max] of [["pace", 50, 150], ["energy", 0, 100], ["strength", 0, 100]]) {
    if (p[key] !== undefined && !number(p[key], min, max)) throw new Error(`Invalid ${key}.`);
  }
  if (p.expression !== undefined && !EXPRESSIONS.includes(p.expression)) throw new Error("Invalid face expression.");
  if (p.gesture !== undefined && !GESTURES.some(g => g.name === p.gesture)) throw new Error("Invalid gesture.");
  for (const key of ["blink", "follow", "lipSync"]) {
    if (p.toggles?.[key] !== undefined && typeof p.toggles[key] !== "boolean") throw new Error("Invalid animation toggle.");
  }
  return { ...structuredClone(defaults), ...p,
    scenes: p.scenes.map(s => ({ ...s,
      expressionCues: [...(s.expressionCues ?? [])].sort((a, b) => a.frame - b.frame),
      gestureCues: [...(s.gestureCues ?? [])].sort((a, b) => a.frame - b.frame),
      cameraCues: [...(s.cameraCues ?? [])].sort((a, b) => a.frame - b.frame),
      characterIndex: s.characterIndex ??
      (Number.isInteger(p.selectedCharacter) && p.characters[p.selectedCharacter] ? p.selectedCharacter : 0) })),
    selectedScene: Number.isInteger(p.selectedScene) && p.scenes[p.selectedScene] ? p.selectedScene : 0,
    selectedCharacter: Number.isInteger(p.selectedCharacter) && p.characters[p.selectedCharacter] ? p.selectedCharacter : 0,
    toggles: { ...defaults.toggles, ...p.toggles } };
}

async function openStorage() {
  db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("littlea-character", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("projects");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const saved = await new Promise((resolve, reject) => {
    const request = db.transaction("projects").objectStore("projects").get("current");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const legacy = saved ? null : localStorage.getItem("littlea-character-project-v1");
  if (saved || legacy) project = validateProject(saved || JSON.parse(legacy));
}

function saveProject() {
  const snapshot = structuredClone(project);
  const version = ++saveVersion;
  $(".save-state").textContent = "Saving...";
  saveQueue = saveQueue.then(() => new Promise((resolve, reject) => {
    if (!db) { reject(new Error("Local storage unavailable. Export a Studio project to keep your work.")); return; }
    const transaction = db.transaction("projects", "readwrite");
    transaction.objectStore("projects").put(snapshot, "current");
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new Error("Saving was interrupted."));
    transaction.onerror = () => reject(transaction.error);
  })).then(() => {
    if (version === saveVersion) $(".save-state").textContent = "Saved locally (including audio)";
  }).catch(error => {
    $(".save-state").textContent = "Not saved - export a backup";
    report(error);
  });
}

function context() {
  audioContext ??= new AudioContext();
  return audioContext;
}

async function bufferFor(s) {
  if (!s.audio) return null;
  if (!buffers.has(s)) {
    const response = await fetch(s.audio.src);
    buffers.set(s, await context().decodeAudioData(await response.arrayBuffer()));
  }
  return buffers.get(s);
}

function draw() {
  const s = previewPose
    ? { ...scene(), cues: [{ frame: 0, phoneme: selectedPose }] } : scene();
  drawFrame(canvas, previewPose ? { ...project, toggles: { ...project.toggles, lipSync: true } } : project, s, elapsed);
}

function setElapsed(value) {
  elapsed = Math.max(0, Math.min(value, scene().duration));
  const progress = elapsed / scene().duration * 100;
  $(".timeline").style.setProperty("--progress", `${progress}%`);
  $("#waveform").setAttribute("aria-valuenow", String(Math.round(progress)));
  $("#waveform").setAttribute("aria-valuetext", `${time(elapsed / rate())} of ${time(scene().duration / rate())}`);
  $("#timecode").textContent = `${time(elapsed / rate())} / ${time(scene().duration / rate())}`;
  $("#seek-time").max = String(scene().duration / rate());
  if (document.activeElement !== $("#seek-time")) $("#seek-time").value = (elapsed / rate()).toFixed(2);
  renderPerformance();
  draw();
}

function stop() {
  const position = playing ? (context().currentTime - playbackStart) * rate() : elapsed;
  playGeneration++;
  playbackPending = false;
  if (source) { source.stop(); source.disconnect(); source = null; }
  playing = false;
  cancelAnimationFrame(frameRequest);
  setButtonIcon($("#play-button"), "play");
  $("#play-button").setAttribute("aria-label", "Play scene");
  $("#play-button").title = "Play scene";
  setElapsed(position);
}

async function play() {
  if (playing) { stop(); return; }
  const generation = ++playGeneration;
  playbackPending = true;
  const s = scene();
  let buffer;
  try {
    await context().resume();
    buffer = await bufferFor(s);
  } finally {
    if (generation === playGeneration) playbackPending = false;
  }
  if (generation !== playGeneration || s !== scene() || busy) return;
  if (elapsed >= s.duration) elapsed = 0;
  previewPose = false;
  const startedAt = context().currentTime;
  if (buffer) {
    source = context().createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate();
    source.connect(context().destination);
    source.start(startedAt, Math.min(elapsed, buffer.duration));
  } else {
    $("#studio-status").textContent = "Silent preview: import or record audio for this scene.";
  }
  playing = true;
  playbackStart = startedAt - elapsed / rate();
  setButtonIcon($("#play-button"), "pause");
  $("#play-button").setAttribute("aria-label", "Pause scene");
  $("#play-button").title = "Pause scene";
  const tick = () => {
    if (!playing) return;
    setElapsed((context().currentTime - playbackStart) * rate());
    if (elapsed >= s.duration) { stop(); return; }
    frameRequest = requestAnimationFrame(tick);
  };
  tick();
}

async function seek(value) {
  const resume = playing || playbackPending;
  stop();
  previewPose = false;
  selectedChange = null;
  setElapsed(value);
  if (resume && elapsed < scene().duration) await play();
}

function renderPerformance() {
  const active = performanceAt(project, scene(), elapsed);
  $("#expression-name").textContent = active.expression;
  $('[data-action="camera"]').textContent = `Camera · ${active.camera}`;
  $$(".palette").forEach(b => {
    const selected = b.dataset.select === active.expression;
    b.classList.toggle("active", selected);
    b.setAttribute("aria-pressed", String(selected));
  });
  $(".expression-icon").textContent = $(".palette.active .emoji").textContent;
  $$(".tool").forEach(b => {
    const selected = b.dataset.select === active.gesture;
    b.classList.toggle("active", selected);
    b.setAttribute("aria-pressed", String(selected));
  });
  $$(".performance-track button").forEach(b => b.setAttribute("aria-pressed",
    String(selectedChange?.track === b.dataset.track && selectedChange.frame === Number(b.dataset.frame))));
  $("#timeline-selection").textContent = selectedChange
    ? `${TRACK_LABELS[selectedChange.track]} change at ${time(selectedChange.frame / FPS / rate())}`
    : "Choose a Face, Gesture or Camera cue to edit.";
}

function storePerformance(track, value) {
  if (playing) setElapsed((context().currentTime - playbackStart) * rate());
  const frame = Math.min(Math.floor(elapsed * FPS + 1e-7), Math.ceil(scene().duration * FPS) - 1);
  const key = `${track}Cues`;
  scene()[key] = [...(scene()[key] ?? []).filter(c => c.frame !== frame), { frame, value }].sort((a, b) => a.frame - b.frame);
  selectedChange = { track, frame };
  previewPose = false;
  if (!playing) elapsed = frame / FPS;
  renderTimeline();
  setElapsed(elapsed);
  saveProject();
}

function trimSceneCues(target) {
  for (const key of ["cues", "expressionCues", "gestureCues", "cameraCues"]) {
    if (target[key]) target[key] = target[key].filter(c => c.frame < target.duration * FPS);
  }
  selectedChange = null;
}

function renderLips() {
  const c = character();
  $("#lip-shapes").innerHTML = VISEMES.map(v => `<button type="button" data-pose="${escapeHtml(v.phoneme)}" aria-pressed="${v.phoneme === selectedPose}" title="${escapeHtml(v.phoneme)}">
    <svg viewBox="-16 -10 112 60" aria-hidden="true"><path d="${escapeHtml(shapePath(v.phoneme, c.mouthSettings?.[v.phoneme]))}" fill="${c.lipColor || "#8b3a3a"}"/></svg>${escapeHtml(v.phoneme)}</button>`).join("");
  const settings = c.mouthSettings?.[selectedPose] ?? { width: 100, opening: 100 };
  for (const key of ["width", "opening"]) {
    $(`#lip-${key}`).value = settings[key];
    $(`#lip-${key}-value`).textContent = `${settings[key]}%`;
  }
  $("#lip-color").value = c.lipColor || "#8b3a3a";
  $("#skin-color").value = c.skinColor || "#fce4d6";
  $("#lip-color-label").textContent = $("#lip-color").value;
  $("#skin-color-label").textContent = $("#skin-color").value;
  $("#selected-viseme").textContent = selectedPose.toUpperCase();
}

function renderTimeline() {
  const s = scene();
  $("#waveform").innerHTML = (s.waveform ?? Array(80).fill(0)).map(v => `<i style="--h:${Math.max(3, v * 100)}%"></i>`).join("");
  const cues = s.cues ?? [];
  $(".visemes").innerHTML = cues.map((cue, i) => {
    const start = cue.frame / FPS;
    const end = (cues[i + 1]?.frame / FPS) || s.duration;
    return `<button type="button" data-cue="${cue.frame}" title="${escapeHtml(cue.phoneme)} at ${time(start / rate())}" style="left:${start / s.duration * 100}%;width:${Math.max(0, end - start) / s.duration * 100}%">${escapeHtml(cue.phoneme)}</button>`;
  }).join("");
  $("#timeline-times").innerHTML = Array.from({ length: 5 }, (_, i) => {
    const at = s.duration * i / 4;
    return `<button type="button" data-seek="${at}" aria-label="Seek to ${time(at / rate())}">${time(at / rate())}</button>`;
  }).join("");
  for (const track of Object.keys(TRACK_LABELS)) {
    const cues = s[`${track}Cues`] ?? [];
    const baseline = track === "camera" ? s.detail ?? "close-up" : project[track];
    const spans = cues[0]?.frame === 0 ? cues : [{ frame: 0, value: baseline, baseline: true }, ...cues];
    $(`#${track}-track`).innerHTML = spans.map((cue, i) => {
      const start = cue.frame / FPS, end = spans[i + 1] ? spans[i + 1].frame / FPS : s.duration;
      return `<button type="button" data-track="${track}" data-frame="${cue.frame}" data-baseline="${!!cue.baseline}" aria-pressed="false"
        aria-label="${TRACK_LABELS[track]}: ${escapeHtml(cue.value)} at ${time(start / rate())}"
        title="${escapeHtml(cue.value)} at ${time(start / rate())}${cue.baseline ? " (default)" : ""}"
        style="left:${start / s.duration * 100}%;width:${Math.max(0, end - start) / s.duration * 100}%">${escapeHtml(cue.value)}</button>`;
    }).join("");
  }
}

function render() {
  const s = scene();
  updateStudioSummary(project);
  $(".project-title").value = project.title;
  $(".sidebar section:first-of-type .stack").innerHTML = project.characters.map((c, i) => `<button type="button" class="list-item character-option${c === character() ? " active" : ""}" data-character-index="${i}"><span class="portrait">${escapeHtml(c.name[0])}</span><span><strong>${escapeHtml(c.name)}</strong><span>${escapeHtml(c.role || "Performer")}</span></span></button>`).join("");
  $(".sidebar section:nth-of-type(2) .stack").innerHTML = project.scenes.map((s, i) => `<button type="button" class="list-item scene-card${i === project.selectedScene ? " active" : ""}" data-scene-index="${i}"><span class="scene-thumb">${i + 1}</span><span><strong>${escapeHtml(s.name)}</strong><span>${time(s.duration / rate())}${s.audio ? " · Audio" : " · Silent"}</span></span></button>`).join("");
  $("#scene-name").textContent = s.name;
  $("#script").value = s.line;
  $("#scene-duration").value = s.duration;
  $("#scene-duration").disabled = !!s.audio;
  $("#character-name").textContent = character().name;
  $(".selected-expression div span").textContent = `Face preset · ${project.strength}% strength`;
  $$(".toggle").forEach((b, i) => {
    const enabled = project.toggles[["blink", "follow", "lipSync"][i]];
    b.classList.toggle("on", enabled);
    b.setAttribute("aria-pressed", String(enabled));
  });
  for (const [id, key] of [["pace", "pace"], ["energy", "energy"], ["expression", "strength"]]) {
    $(`#${id}`).value = project[key];
    $(`#${id}`).closest(".field").querySelector(".value").textContent = key === "pace" ? `${rate().toFixed(2)}×` : `${project[key]}%`;
  }
  $("#studio-status").textContent = s.audio
    ? `${s.audio.name || "Recorded voice"} · Audio-driven lip sync (amplitude, not phoneme recognition). Edit cues to refine speech.`
    : "Import or record audio. Script notes are not converted to speech.";
  renderLips();
  renderTimeline();
  setElapsed(elapsed);
}

function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function attachAudio(blob, name, target) {
  if (blob.size > 80 * 1024 * 1024) throw new Error("Audio is too large. Use a clip under 80 MB.");
  const buffer = await context().decodeAudioData(await blob.arrayBuffer());
  if (buffer.duration < 0.1 || buffer.duration > 600) throw new Error("Use audio between 0.1 seconds and 10 minutes.");
  const src = await dataUrl(new Blob([encodeWav(buffer)], { type: "audio/wav" }));
  const waveform = Array.from({ length: 80 }, (_, i) => {
    const data = buffer.getChannelData(0);
    const start = Math.floor(i * data.length / 80);
    const end = Math.floor((i + 1) * data.length / 80);
    let peak = 0;
    for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(data[j]));
    return Math.min(1, peak);
  });
  target.audio = { name, src };
  target.duration = buffer.duration;
  target.cues = analyzeAudio(buffer, FPS);
  target.waveform = waveform;
  trimSceneCues(target);
  buffers.set(target, buffer);
  elapsed = 0;
  previewPose = false;
  render();
  saveProject();
}

async function toggleRecording() {
  if (recorder?.state === "recording") { recorder.stop(); return; }
  if (recordingPending) return;
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) throw new Error("Recording needs a supported browser on localhost or HTTPS.");
  stop();
  const target = scene();
  recordingPending = true;
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    recorder = new MediaRecorder(recordingStream);
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = event => report(event.error || new Error("Microphone recording failed."));
    recorder.onstop = () => {
      const type = recorder.mimeType;
      recordingStream.getTracks().forEach(t => t.stop());
      $("#record-button span:last-child").textContent = "Record";
      $("#record-button").classList.remove("recording");
      run(async () => {
        busy = true;
        try { await attachAudio(new Blob(chunks, { type }), "Recorded voice", target); }
        finally { busy = false; }
      });
    };
    recorder.start();
    $("#record-button span:last-child").textContent = "Stop";
    $("#record-button").classList.add("recording");
    $("#studio-status").textContent = "Recording voice. Press Stop to attach and align this take.";
  } catch (error) {
    recordingStream?.getTracks().forEach(t => t.stop());
    throw error;
  } finally { recordingPending = false; }
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function exportVideo() {
  const controller = new AbortController();
  const transparent = $("#video-transparent").checked;
  cancelVideo = () => controller.abort();
  try {
    const blob = await renderCharacterVideo(project, {
      bufferFor, signal: controller.signal, transparent,
      allowDownload: $("#download-encoder").checked,
      onStatus({ message }) {
        if (!controller.signal.aborted) $("#export-status").textContent = `FFmpeg WASM: ${message}`;
      },
    });
    if (!controller.signal.aborted) download(`${slug()}.${transparent ? "webm" : "mp4"}`, blob);
  } finally {
    cancelVideo = null;
  }
}

const slug = () => project.title.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || "character";

$("#video-transparent").addEventListener("change", () => {
  const transparent = $("#video-transparent").checked;
  $("#video-format-label").textContent = transparent ? "WebM" : "MP4";
  $("#video-format-help").textContent = transparent
    ? "Transparent WebM (VP8 + Opus), 640 x 480 at 30 fps. No live recording."
    : "Opaque MP4 (H.264 + AAC), 640 x 480 at 30 fps. Includes canvas background.";
});

async function exportProject() {
  stop();
  busy = true;
  exportCancelled = false;
  $("#export-button").disabled = true;
  $("main").inert = true;
  try {
    const format = $('input[name="format"]:checked').value;
    if (format === "video") await exportVideo();
    else if (format === "svg") download(`${slug()}.svg`, new Blob([buildSvg(project, scene(), elapsed)], { type: "image/svg+xml" }));
    else if (format === "lax") download(`${slug()}.lax`, new Blob([buildLax(project)], { type: "application/xml" }));
    else download(`${slug()}.littlea-character.json`, new Blob([JSON.stringify({ app: "LittleA Character", version: 2, project })], { type: "application/json" }));
    $("#export-status").textContent = exportCancelled ? "Export cancelled." : "Export complete.";
  } catch (error) {
    $("#export-status").textContent = exportCancelled ? "Export cancelled." : `Export failed: ${error.message || error}`;
    if (!exportCancelled) throw error;
  } finally {
    busy = false;
    $("main").inert = false;
    $("#export-button").disabled = false;
  }
}

document.addEventListener("click", event => run(async () => {
  if (event.target.closest("#artwork-modal")) return;
  const b = event.target.closest("button");
  if (!b) return;
  const action = b.dataset.action;
  if (action === "cancel-export") {
    exportCancelled = true;
    if (busy) $("#export-status").textContent = "Cancelling export...";
    cancelVideo?.();
    if (!busy) $("#export-modal").classList.remove("open");
    return;
  }
  if (busy || recordingPending || (recorder?.state === "recording" && action !== "record")) {
    toast("Finish the current audio or export operation first."); return;
  }
  if (b.dataset.modalOpen) { $(b.dataset.modalOpen).classList.add("open"); return; }
  if (b.hasAttribute("data-modal-close")) { b.closest(".modal-backdrop").classList.remove("open"); return; }
  if (b.dataset.sceneIndex !== undefined) {
    stop(); project.selectedScene = Number(b.dataset.sceneIndex);
    project.selectedCharacter = scene().characterIndex;
    elapsed = 0; previewPose = false; selectedChange = null; render(); saveProject(); return;
  }
  if (b.dataset.characterIndex !== undefined) {
    stop(); project.selectedCharacter = Number(b.dataset.characterIndex);
    scene().characterIndex = project.selectedCharacter; render(); saveProject(); return;
  }
  if (b.dataset.pose !== undefined) {
    stop(); selectedPose = b.dataset.pose; previewPose = true; renderLips(); draw(); return;
  }
  if (b.dataset.cue !== undefined) { await seek(Number(b.dataset.cue) / FPS); return; }
  if (b.dataset.seek !== undefined) { await seek(Number(b.dataset.seek)); return; }
  if (b.dataset.track) {
    const frame = Number(b.dataset.frame);
    await seek(frame / FPS);
    selectedChange = b.dataset.baseline === "true" ? null : { track: b.dataset.track, frame };
    renderPerformance();
    return;
  }
  if (b.closest(".palette-grid") || b.closest(".tool-grid")) {
    storePerformance(b.closest(".palette-grid") ? "expression" : "gesture", b.dataset.select);
    if (b.dataset.select === "Custom") { showInspector("lip"); $("#lip-width").scrollIntoView({ block: "center" }); $("#lip-width").focus(); }
    return;
  }
  if (action === "edit-artwork") {
    if (document.fullscreenElement) await document.exitFullscreen();
    stop(); artworkEditor.open(b.dataset.artworkTarget);
  }
  else if (action === "play") await play();
  else if (action === "rewind") { stop(); previewPose = false; selectedChange = null; setElapsed(0); }
  else if (action === "delete-performance-cue") {
    if (!selectedChange) throw new Error("Select a Face, Gesture or Camera change on the timeline first.");
    const key = `${selectedChange.track}Cues`;
    scene()[key] = scene()[key].filter(c => c.frame !== selectedChange.frame);
    selectedChange = null;
    renderTimeline(); setElapsed(elapsed); saveProject();
  }
  else if (action === "preview") { document.body.classList.toggle("preview-mode"); }
  else if (action === "import-audio") $("#audio-file").click();
  else if (action === "import-project") $("#project-file").click();
  else if (action === "record") await toggleRecording();
  else if (action === "export") await exportProject();
  else if (action === "grid") $(".avatar-stage").classList.toggle("show-grid");
  else if (action === "fit") await toggleStageFullscreen();
  else if (action === "camera") {
    if (playing) setElapsed((context().currentTime - playbackStart) * rate());
    const current = performanceAt(project, scene(), elapsed).camera;
    storePerformance("camera", CAMERA_SHOTS[(CAMERA_SHOTS.indexOf(current) + 1) % CAMERA_SHOTS.length]);
  } else if (action === "add-scene") {
    stop(); project.scenes.push({ name: `Scene ${project.scenes.length + 1}`, detail: "medium shot", duration: 6, line: "", characterIndex: project.selectedCharacter });
    project.selectedScene = project.scenes.length - 1; elapsed = 0; selectedChange = null; previewPose = false; render(); saveProject();
  } else if (action === "add-character") {
    $("#character-modal").classList.add("open"); $("#new-character-name").focus();
  } else if (action === "confirm-character") {
    const name = $("#new-character-name").value.trim();
    if (!name) throw new Error("Enter a character name.");
    project.characters.push({ name, role: "Custom performer" });
    project.selectedCharacter = project.characters.length - 1;
    scene().characterIndex = project.selectedCharacter;
    $("#character-modal").classList.remove("open"); render(); saveProject();
  } else if (action === "toggle") {
    const key = ["blink", "follow", "lipSync"][$$(".toggle").indexOf(b)];
    project.toggles[key] = !project.toggles[key]; render(); saveProject();
  } else if (action === "align" || action === "regenerate") {
    const target = scene();
    stop(); busy = true;
    try {
      const buffer = await bufferFor(target);
      if (!buffer) throw new Error("Import or record audio before generating lip sync.");
      target.cues = analyzeAudio(buffer, FPS); previewPose = false;
      render(); saveProject(); toast("Audio-driven lip sync regenerated; manual cues replaced.");
    } finally { busy = false; }
  } else if (action === "remove-audio") {
    stop(); delete scene().audio; delete scene().waveform; delete scene().cues; buffers.delete(scene()); render(); saveProject();
  } else if (action === "set-pose") {
    const frame = Math.min(Math.round(elapsed * FPS), Math.ceil(scene().duration * FPS) - 1);
    scene().cues = [...(scene().cues ?? []).filter(c => c.frame !== frame), { frame, phoneme: selectedPose }].sort((a, b) => a.frame - b.frame);
    previewPose = false; renderTimeline(); draw(); saveProject();
  } else if (action === "delete-cue") {
    const frame = Math.round(elapsed * FPS);
    if (!(scene().cues ?? []).some(c => c.frame === frame)) throw new Error("Select a timeline cue before deleting it.");
    scene().cues = scene().cues.filter(c => c.frame !== frame);
    previewPose = false; renderTimeline(); draw(); saveProject();
  } else if (action === "reset-pose") {
    delete (character().mouthSettings ?? {})[selectedPose]; renderLips(); draw(); saveProject();
  } else if (action === "apply-shapes") {
    const settings = character().mouthSettings?.[selectedPose] ?? { width: 100, opening: 100 };
    character().mouthSettings = Object.fromEntries(VISEMES.map(v => [v.phoneme, { ...settings }]));
    renderLips(); draw(); saveProject();
  }
}));

$("#audio-file").addEventListener("change", () => run(async () => {
  const file = $("#audio-file").files[0];
  if (!file) return;
  const target = scene();
  busy = true; stop();
  $("#studio-status").textContent = "Decoding audio and generating lip sync...";
  try { await attachAudio(file, file.name, target); }
  finally { busy = false; $("#audio-file").value = ""; }
}));
$("#project-file").addEventListener("change", () => run(async () => {
  const file = $("#project-file").files[0];
  if (!file) return;
  busy = true; stop();
  try {
    const imported = validateProject(JSON.parse(await file.text()));
    for (const s of imported.scenes) {
      const buffer = await bufferFor(s);
      if (buffer && Math.abs(buffer.duration - s.duration) > 0.1) throw new Error("Audio duration does not match the saved scene.");
    }
    project = imported; elapsed = 0; previewPose = false; selectedChange = null; render(); saveProject();
  } finally { busy = false; $("#project-file").value = ""; }
}));
document.addEventListener("input", event => {
  if (busy || recordingPending || recorder?.state === "recording") return;
  const id = event.target.id;
  if (event.target.matches(".project-title")) project.title = event.target.value;
  else if (id === "script") scene().line = event.target.value;
  else if (["lip-width", "lip-opening"].includes(id)) {
    stop(); previewPose = true;
    character().mouthSettings ??= {};
    character().mouthSettings[selectedPose] = { width: Number($("#lip-width").value), opening: Number($("#lip-opening").value) };
    renderLips(); draw();
  } else if (id === "lip-color" || id === "skin-color") {
    character()[id === "lip-color" ? "lipColor" : "skinColor"] = event.target.value; renderLips(); draw();
  } else if (["pace", "energy", "expression"].includes(id)) {
    stop(); project[id === "expression" ? "strength" : id] = Number(event.target.value); render();
  } else return;
  saveProject();
});
$("#scene-duration").addEventListener("change", () => run(() => {
  if (scene().audio) return;
  const duration = Number($("#scene-duration").value);
  if (!Number.isFinite(duration) || duration < 0.1 || duration > 600) throw new Error("Duration must be 0.1 to 600 seconds.");
  stop(); scene().duration = duration;
  trimSceneCues(scene());
  render(); saveProject();
}));
function scrubTo(event) {
  const bounds = $("#waveform").getBoundingClientRect();
  previewPose = false;
  selectedChange = null;
  setElapsed((event.clientX - bounds.left) / bounds.width * scene().duration);
}
$("#waveform").addEventListener("pointerdown", event => {
  if (busy || recordingPending || recorder?.state === "recording" || event.button !== 0) return;
  scrub = { pointer: event.pointerId, resume: playing || playbackPending };
  stop();
  event.currentTarget.setPointerCapture(event.pointerId);
  event.currentTarget.focus();
  scrubTo(event);
});
$("#waveform").addEventListener("pointermove", event => {
  if (scrub?.pointer === event.pointerId) scrubTo(event);
});
function finishScrub(event) {
  if (scrub?.pointer !== event.pointerId) return;
  if (event.type === "pointerup") scrubTo(event);
  const resume = scrub.resume;
  scrub = null;
  if ($("#waveform").hasPointerCapture(event.pointerId)) $("#waveform").releasePointerCapture(event.pointerId);
  if (resume && elapsed < scene().duration) run(play);
}
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) $("#waveform").addEventListener(type, finishScrub);
$("#seek-time").addEventListener("change", () => run(async () => {
  if (busy || recordingPending || recorder?.state === "recording") return;
  const seconds = Number($("#seek-time").value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > scene().duration / rate()) throw new Error("Seek time must be within this scene.");
  await seek(seconds * rate());
}));
document.addEventListener("keydown", event => {
  if ($("#artwork-modal").classList.contains("open")) return;
  if (busy || recordingPending || recorder?.state === "recording") return;
  if (event.key === "Escape") $$(".modal-backdrop.open").forEach(m => m.classList.remove("open"));
  if (event.target === $("#waveform") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    run(() => seek(event.key === "Home" ? 0 : event.key === "End" ? scene().duration : elapsed + (event.key === "ArrowRight" ? 0.25 : -0.25)));
  } else if (event.code === "Space" && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(event.target.tagName)) {
    event.preventDefault(); run(play);
  }
});
window.addEventListener("pagehide", () => {
  if ($("#artwork-modal").classList.contains("open")) artworkEditor.close();
  cancelVideo?.();
  stop();
  if (recorder?.state === "recording") recorder.stop();
  recordingStream?.getTracks().forEach(t => t.stop());
});

$("main").inert = true;
try {
  await openStorage();
  render();
} catch (error) {
  render();
  $(".save-state").textContent = "Could not restore local project";
  report(error);
} finally {
  $("main").inert = false;
}
