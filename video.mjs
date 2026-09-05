import { framesToMp4, framesToWebm, releaseMp4Tool } from "./lib/mp4.js";
import { drawFrame, encodeWav, exportFramePlan } from "./performance.mjs";

const FPS = 30;
const checkCancelled = signal => {
  if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
};

export async function renderCharacterVideo(project, { bufferFor, signal, onStatus, allowDownload = false, transparent = true }) {
  const plan = exportFramePlan(project);
  if (!plan.length) throw new Error("Add a scene before exporting video.");
  const frames = plan.at(-1).end;
  const pace = project.pace / 100;
  const output = document.createElement("canvas");
  output.width = 640;
  output.height = 480;
  const abort = () => releaseMp4Tool();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    checkCancelled(signal);
    let audio = null;
    if (plan.some(part => part.scene.audio)) {
      onStatus?.({ phase: "audio", message: "Mixing scene audio..." });
      const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      if (!Offline) throw new Error("Offline audio mixing is required to export a video with sound.");
      const mix = new Offline(2, Math.ceil(frames / FPS * 48000), 48000);
      for (const { scene, start, end } of plan) {
        checkCancelled(signal);
        if (!scene.audio) continue;
        const buffer = await bufferFor(scene);
        checkCancelled(signal);
        if (!buffer) throw new Error(`Could not decode audio for "${scene.name}".`);
        const source = mix.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = pace;
        source.connect(mix.destination);
        source.start(start / FPS);
        source.stop(end / FPS);
      }
      const mixed = await mix.startRendering();
      checkCancelled(signal);
      audio = encodeWav(mixed);
    }
    let segment = 0;
    const encode = transparent ? framesToWebm : framesToMp4;
    return await encode({
      frames, fps: FPS, audio, signal, allowDownload, onStatus,
      ...(transparent ? { transparent: true } : {}),
      paint(frame) {
        checkCancelled(signal);
        while (frame >= plan[segment].end) segment++;
        const { scene, start } = plan[segment];
        drawFrame(output, project, scene, (frame - start) / FPS * pace, { transparentBackground: transparent });
        return output;
      },
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    releaseMp4Tool();
  }
}

export function renderCharacterMp4(project, options) {
  return renderCharacterVideo(project, { ...options, transparent: false });
}
