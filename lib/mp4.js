// LittleA Character and Editor — MP4 export in the browser, via ffmpeg.wasm.
//
// The deterministic renderer has always been `la export`: it walks a .lax
// frame by frame and owes nothing to wall-clock time, and it reaches MP4 by
// shelling out to a native ffmpeg. The browser had no such tool. What it could
// record, it recorded live and in WebM, because WebM is the one container
// every engine will mux — so "send this round" and "hand this to something
// that only takes MP4" were different buttons with different answers.
//
// This module is that missing tool. It runs the same ffmpeg, compiled to
// WebAssembly, in a worker (`mp4worker.js`), which gives the page two things
// it could not do before:
//
//   · `transcodeToMp4()` — take anything the browser managed to record and
//     remux/re-encode it to H.264 MP4, including on engines whose MediaRecorder
//     has no MP4 mode at all.
//   · `framesToMp4()`   — encode frames the caller paints *one at a time*, at
//     whatever speed the machine manages. Nothing is clock-paced, so the
//     result is frame-exact: the in-browser answer to `la export`, not a
//     recording of a playback.
//
// ## Where the core comes from
//
// `ffmpeg-core.wasm` is 32 MB and, because it is built `--enable-gpl
// --enable-libx264`, it is GPL — where this repository is MIT OR Apache-2.0.
// Committing it would multiply the repo's size by a binary it cannot
// relicense, so it is NOT in git (see `../vendor/ffmpeg/README.md`). It is
// looked for, in order:
//
//   1. `../vendor/ffmpeg/` — put there by the package's `tools/fetch-ffmpeg-core.mjs`.
//      Offline, no network, the way a workshop machine should be set up.
//   2. The Cache API — a copy this browser downloaded on a previous run.
//   3. The pinned CDN URL — and only when the caller passes `allowDownload`,
//      which the UI only sets after the person has been told the size. The
//      editor never reaches the network on its own.
//
// Everything degrades: with no core the export paths report why and the WebM
// buttons keep working exactly as they did.

const CORE_VERSION = "0.12.6";

/// Where the core is looked for, what it should hash to, and how big it is —
/// the same three facts `tools/fetch-ffmpeg-core.mjs` writes and
/// `../vendor/ffmpeg/README.md` publishes. Exported so a UI can quote the
/// download size before asking for it.
export const MP4_CORE = {
  version: CORE_VERSION,
  dir: new URL("../vendor/ffmpeg/", import.meta.url).href,
  remote: `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd/`,
  wasmBytes: 32_129_114,
  sha256: {
    "ffmpeg-core.js": "a34873964b0f62aec516bac75e3aa9086ec3535d4d07f0269aa94ea748b6cb71",
    "ffmpeg-core.wasm": "2390efa7fb66e7e42dbae15427571a5ffc96b829480904c30f471f0a78967f61",
  },
};

const CACHE_NAME = `littlea-ffmpeg-core-${CORE_VERSION}`;

/// Human-readable byte count, for status lines that quote a download.
export function mb(bytes) {
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
}

// SHA-256 of some bytes, as lowercase hex. `crypto.subtle` exists only in a
// secure context, which is the same condition the Cache API needs — so on a
// page where this returns null, there is no cached copy to check either.
async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The core is a 32 MB program that gets `importScripts`-ed into a worker with
// full same-origin reach, and — once cached — is re-executed on every later
// visit without asking again. So it is checked against the hashes this module
// publishes, on every path, every time. `tools/fetch-ffmpeg-core.mjs` refuses
// to *write* bytes that do not match; this refuses to *run* them.
async function verifyCore(name, bytes, where) {
  const want = MP4_CORE.sha256[name];
  const got = await sha256(bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes));
  if (got === null) {
    // No WebCrypto means an insecure context. Our own directory is as
    // trustworthy as the page itself; anything off the network is not.
    if (where === "vendor") return;
    throw new Error("the MP4 encoder cannot be verified here — serve the editor over https or localhost");
  }
  if (got !== want) {
    throw new Error(
      `${name} is not the build this editor expects (sha256 ${got.slice(0, 12)}…, wanted ${want.slice(0, 12)}…)`,
    );
  }
}

/// Can this browser run the tool at all? Cheap and synchronous — the answer
/// is about the engine, not about whether the 32 MB core is to hand. Note
/// that the single-threaded core needs no `crossOriginIsolated`, which is why
/// the editor can offer this from an ordinary static file server.
export function mp4ToolSupported() {
  return typeof Worker !== "undefined"
    && typeof WebAssembly !== "undefined"
    && typeof URL?.createObjectURL === "function";
}

// ---- finding the core ---------------------------------------------------

async function head(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

async function cacheOpen() {
  // `caches` exists only in a secure context. http://localhost and
  // http://127.0.0.1 count as secure, a bare LAN IP does not — in which case
  // the tool still works, it just re-downloads.
  try {
    return typeof caches !== "undefined" ? await caches.open(CACHE_NAME) : null;
  } catch {
    return null;
  }
}

/// Where the core would come from if it were asked for right now, without
/// downloading anything. `source` is `"vendor"`, `"cache"`, `"remote"` or
/// `null`; `remote` means "available, but only after a download this size".
export async function mp4ToolStatus() {
  if (!mp4ToolSupported()) {
    return { supported: false, source: null, ready: false, needsDownload: false, bytes: 0 };
  }
  if (loaded) return { supported: true, source: loadedFrom, ready: true, needsDownload: false, bytes: 0 };

  const vendored = await head(`${MP4_CORE.dir}ffmpeg-core.wasm`);
  if (vendored) {
    return { supported: true, source: "vendor", ready: false, needsDownload: false, bytes: 0 };
  }
  const cache = await cacheOpen();
  if (cache && await cache.match(`${MP4_CORE.remote}ffmpeg-core.wasm`)) {
    return { supported: true, source: "cache", ready: false, needsDownload: false, bytes: 0 };
  }
  return {
    supported: true,
    source: "remote",
    ready: false,
    needsDownload: true,
    bytes: MP4_CORE.wasmBytes,
  };
}

// Read a response body with progress. The core is 32 MB; a silent wait that
// long reads as a hang, so callers get told how far along it is.
async function bytesWithProgress(res, onStatus, phase) {
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body?.getReader || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onStatus?.({ phase, done: got, total, message: `downloading the encoder — ${mb(got)} of ${mb(total)}` });
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// Fetch both halves of the core from one base, caching them when we are
// allowed to and the browser has somewhere to put them.
//
// The bytes are read first and cached second, rather than the other way round
// by cloning the response: `cache.put` drains whichever branch it is given,
// and a tee'd 32 MB body would arrive at our reader all at once — leaving the
// progress bar to jump from nothing to done. Constructing the cache entry
// from bytes we already have keeps the download visible.
async function fetchCore(base, onStatus, store, where) {
  const jsRes = await fetch(`${base}ffmpeg-core.js`);
  if (!jsRes.ok) throw new Error(`ffmpeg-core.js: HTTP ${jsRes.status}`);
  const js = await jsRes.text();

  const wasmRes = await fetch(`${base}ffmpeg-core.wasm`);
  if (!wasmRes.ok) throw new Error(`ffmpeg-core.wasm: HTTP ${wasmRes.status}`);
  const wasm = await bytesWithProgress(wasmRes, onStatus, "core");

  onStatus?.({ phase: "core", message: "checking the encoder" });
  await verifyCore("ffmpeg-core.js", js, where);
  await verifyCore("ffmpeg-core.wasm", wasm, where);

  if (store) {
    try {
      // The Response constructor copies the bytes it is given, so caching
      // does not alias the buffer that is about to be transferred to the
      // worker.
      await store.put(`${base}ffmpeg-core.js`, new Response(js, {
        headers: { "content-type": "text/javascript", "content-length": String(js.length) },
      }));
      await store.put(`${base}ffmpeg-core.wasm`, new Response(wasm, {
        headers: { "content-type": "application/wasm", "content-length": String(wasm.length) },
      }));
    } catch { /* quota, private mode — not worth failing the export over */ }
  }
  return { js, wasm };
}

// ---- the worker ---------------------------------------------------------

let worker = null;
let loaded = null;      // Promise<true> once the core is up
let loadedFrom = null;  // which of vendor/cache/remote it came from
let seq = 0;
const pending = new Map();
let onLog = null;
let onTick = null;

function spawn() {
  if (worker) return worker;
  worker = new Worker(new URL("./mp4worker.js", import.meta.url), { type: "classic" });
  worker.onmessage = ({ data }) => {
    // A status callback belongs to the caller, and callers throw — the bulk
    // exporter's cancel does exactly that. This is the worker's message pump,
    // not the body of an awaited promise, so a throw here would escape as an
    // uncaught page error and every later reply would be lost with it.
    if (data.type === "log") { try { onLog?.(data.message); } catch { /* the caller's problem */ } return; }
    if (data.type === "progress") { try { onTick?.(data.progress, data.time); } catch { /* ditto */ } return; }
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    data.ok ? p.resolve(data.data) : p.reject(new Error(data.error));
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || "the ffmpeg worker failed to start");
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  return worker;
}

function call(op, args = {}, transfer = []) {
  const id = ++seq;
  spawn().postMessage({ id, op, ...args }, transfer);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/// Load the core, if it is not up already. `allowDownload` is the consent to
/// spend 32 MB of someone's connection — without it, a browser that has
/// neither a vendored nor a cached copy is told so rather than made to wait.
/// Resolves once ffmpeg is ready to be handed argv.
export function loadMp4Tool({ allowDownload = false, onStatus } = {}) {
  if (loaded) return loaded;
  if (!mp4ToolSupported()) return Promise.reject(new Error("this browser cannot run WebAssembly workers"));

  loaded = (async () => {
    onStatus?.({ phase: "core", message: "looking for the MP4 encoder" });

    let source = null;
    let js = null;
    let wasm = null;

    if (await head(`${MP4_CORE.dir}ffmpeg-core.wasm`)) {
      source = "vendor";
      ({ js, wasm } = await fetchCore(MP4_CORE.dir, onStatus, null, "vendor"));
    } else {
      const store = await cacheOpen();
      const hitJs = store && await store.match(`${MP4_CORE.remote}ffmpeg-core.js`);
      const hitWasm = store && await store.match(`${MP4_CORE.remote}ffmpeg-core.wasm`);
      if (hitJs && hitWasm) {
        source = "cache";
        js = await hitJs.text();
        wasm = await bytesWithProgress(hitWasm, onStatus, "core");
        // A cached copy is re-executed on every later visit with no further
        // prompt, so it is checked exactly as a fresh download is — and a
        // copy that fails is evicted rather than left to fail again.
        try {
          await verifyCore("ffmpeg-core.js", js, "cache");
          await verifyCore("ffmpeg-core.wasm", wasm, "cache");
        } catch (e) {
          await store.delete(`${MP4_CORE.remote}ffmpeg-core.js`).catch(() => {});
          await store.delete(`${MP4_CORE.remote}ffmpeg-core.wasm`).catch(() => {});
          throw new Error(`${e.message} — the cached copy has been discarded, try again`);
        }
      } else if (allowDownload) {
        source = "remote";
        onStatus?.({ phase: "core", message: `downloading the encoder — ${mb(MP4_CORE.wasmBytes)}, once` });
        ({ js, wasm } = await fetchCore(MP4_CORE.remote, onStatus, store, "remote"));
      } else {
        throw new Error(
          `the MP4 encoder is not installed — run \`node tools/fetch-ffmpeg-core.mjs\` from the Character Studio folder (or LittleA repository root), `
          + `or allow the one-time ${mb(MP4_CORE.wasmBytes)} download`,
        );
      }
    }

    // A blob URL rather than the fetched URL: the cached copy has no URL of
    // its own, and doing it the same way for every source means one code path
    // in the worker instead of three.
    const coreUrl = URL.createObjectURL(new Blob([js], { type: "text/javascript" }));
    onStatus?.({ phase: "core", message: "starting the MP4 encoder" });
    try {
      await call("load", { coreUrl, wasmBinary: wasm.buffer }, [wasm.buffer]);
    } finally {
      URL.revokeObjectURL(coreUrl);
    }
    loadedFrom = source;
    return true;
  })();

  // A failed load must not be remembered, or the next attempt short-circuits
  // to the same error without retrying.
  loaded.catch(() => { loaded = null; loadedFrom = null; releaseMp4Tool(); });
  return loaded;
}

/// Drop the worker and the 32 MB it is holding. The next export loads again —
/// from the cache, so it is quick, but not free. Worth calling when a page is
/// done exporting for a while; not worth calling between two exports.
export function releaseMp4Tool() {
  if (worker) { worker.terminate(); worker = null; }
  for (const p of pending.values()) p.reject(new Error("the MP4 encoder was released"));
  pending.clear();
  loaded = null;
  loadedFrom = null;
}

// ---- encoding -----------------------------------------------------------

const WORK = "/la";

// One job at a time. Both entry points write the same fixed paths in the
// core's single in-memory filesystem (`/la/f000000.png`, `/la/out.mp4`), so
// two overlapping exports would silently overwrite each other's frames and
// delete files the other was about to encode. The UI guards its own buttons,
// but the invariant belongs to whoever owns the paths, which is here.
let busy = null;

function claim(what) {
  if (busy) throw new Error(`the MP4 encoder is already ${busy} — it can only do one job at a time`);
  busy = what;
}

// The x264 knobs, in one place so both entry points argue for the same
// picture. `yuv420p` because it is the only chroma format every player and
// phone will decode; `+faststart` moves the index to the front so the file
// begins playing before it has finished downloading.
function x264Args({ crf = 20, preset = "veryfast" } = {}) {
  return ["-c:v", "libx264", "-preset", preset, "-crf", String(crf), "-pix_fmt", "yuv420p"];
}

// x264 cannot encode an odd width or height. Rather than refuse, round down —
// a no-op for the even sizes everything else in the editor produces, and one
// pixel off for the ones it does not.
const EVEN = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

async function cleanup(paths) {
  // If the tool was released mid-render there is nothing left to tidy, and
  // asking would spawn a fresh worker purely to delete files that died with
  // the old one.
  if (!worker) return;
  for (const p of paths) {
    try { await call("remove", { path: p }); } catch { /* already gone */ }
  }
}

function abortIf(signal) {
  if (signal?.aborted) throw new DOMException("export cancelled", "AbortError");
}

/// Re-encode anything the browser recorded — a WebM from MediaRecorder, a
/// WebM from the WebCodecs path, an MP4 that needs its index moved — into an
/// H.264 MP4 that plays everywhere.
///
/// `fps` forces a constant frame rate, which is worth doing for MediaRecorder
/// output: a live capture is variable-rate by nature, and some editors treat
/// a variable-rate MP4 as damaged. Audio, if the input has any, is carried
/// over as AAC.
export async function transcodeToMp4(input, {
  fps = 0,
  crf = 20,
  preset = "veryfast",
  onStatus,
  signal,
  ...load
} = {}) {
  claim("transcoding");
  const inPath = `${WORK}/in.bin`;
  const outPath = `${WORK}/out.mp4`;
  const prev = onTick;
  try {
    await loadMp4Tool({ onStatus, ...load });
    abortIf(signal);

    const bytes = input instanceof Uint8Array
      ? input
      : new Uint8Array(input instanceof ArrayBuffer ? input : await input.arrayBuffer());

    await call("mkdir", { path: WORK });
    onStatus?.({ phase: "encode", message: `encoding MP4 — ${mb(bytes.length)} of video` });
    // The copy is deliberate: the buffer is transferred to the worker, and the
    // caller's Blob-derived array should not be emptied out from under them.
    const owned = bytes.slice();
    await call("write", { path: inPath, data: owned }, [owned.buffer]);

    onTick = (p) => onStatus?.({ phase: "encode", done: p, total: 1, message: `encoding MP4 — ${Math.round(p * 100)}%` });
    await call("run", {
      args: [
        "-i", inPath,
        ...(fps ? ["-r", String(fps)] : []),
        "-vf", EVEN,
        ...x264Args({ crf, preset }),
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-y", outPath,
      ],
    });
    abortIf(signal);
    const out = await call("read", { path: outPath });
    return new Blob([out], { type: "video/mp4" });
  } finally {
    onTick = prev;
    await cleanup([inPath, outPath]);
    busy = null;
  }
}

// How much PNG is allowed to pile up in the core's in-memory filesystem
// before it is turned into video and thrown away. The whole point of
// segmenting is that a render's length stops mattering to memory: 40 MB of
// frames plus the 32 MB core is a working set any laptop has, where a
// three-minute deck's worth of PNG at once is not.
const SEGMENT_BYTES = 40 * 1024 * 1024;
const SEGMENT_FRAMES = 240;

// Turn whatever the caller painted into PNG bytes. A canvas is the usual
// answer; a Blob or a Uint8Array is taken as already-encoded PNG, which is
// what a caller that renders off the main thread will have.
async function pngBytes(frame) {
  if (frame instanceof Uint8Array) return frame;
  if (frame instanceof Blob) return new Uint8Array(await frame.arrayBuffer());
  if (typeof OffscreenCanvas !== "undefined" && frame instanceof OffscreenCanvas) {
    return new Uint8Array(await (await frame.convertToBlob({ type: "image/png" })).arrayBuffer());
  }
  if (frame?.toBlob) {
    const blob = await new Promise((res) => frame.toBlob(res, "image/png"));
    if (!blob) throw new Error("the frame canvas could not be read");
    return new Uint8Array(await blob.arrayBuffer());
  }
  throw new Error("paint() must return a canvas, a Blob, or PNG bytes");
}

/// Encode `frames` frames into an MP4, deterministically.
///
/// `paint(i)` is called for frame `i` and returns what that frame looks like
/// — a canvas, or PNG bytes. It is awaited, and the next frame is not asked
/// for until this one is safely encoded, so the render runs at the speed the
/// machine can actually paint and encode rather than in real time. A slow
/// machine therefore takes longer; it does not drop a frame. That is the
/// whole difference between this and a recording.
///
/// `audio` is an optional soundtrack — a Blob or bytes in anything ffmpeg can
/// demux, which in practice means the WAV a caller can write without needing
/// an encoder of its own. It is re-encoded to AAC and fitted to the picture:
/// padded with silence if it is short, cut if it is long. Callers that have no
/// soundtrack leave it null and get a video-only file.
///
/// Memory is bounded by encoding in segments: every `segmentBytes` of PNG (or
/// `segmentFrames` frames) the accumulated stills become one H.264 elementary
/// stream and the stills are deleted. The segments are encoded without
/// B-frames so that coding order is display order, which is what lets the
/// finished streams be concatenated byte-for-byte; one last `-c copy` pass
/// then wraps the result in MP4 without re-encoding a single pixel.
export async function framesToMp4({
  frames,
  paint,
  fps = 30,
  crf = 20,
  preset = "veryfast",
  audio = null,
  segmentFrames = SEGMENT_FRAMES,
  segmentBytes = SEGMENT_BYTES,
  onStatus,
  signal,
  ...load
} = {}) {
  if (!Number.isFinite(frames) || frames < 1) throw new Error("framesToMp4 needs at least one frame");
  claim("rendering");
  const segments = [];
  const written = [];   // PNG paths not yet folded into a segment
  const litter = [];    // everything to delete when we are done or have failed
  let pendingBytes = 0;
  let painted = 0;

  const flush = async () => {
    if (!written.length) return;
    const seg = `${WORK}/s${segments.length}.h264`;
    onStatus?.({
      phase: "encode",
      done: painted,
      total: frames,
      message: `encoding — frame ${painted} of ${frames}`,
    });
    await call("run", {
      args: [
        "-framerate", String(fps),
        "-i", `${WORK}/f%06d.png`,
        "-an", "-vf", EVEN,
        ...x264Args({ crf, preset }),
        // No B-frames, and this is the line the whole segmented design rests
        // on. A raw Annex-B stream carries no timestamps, so a decoder infers
        // them from coding order — which is only display order when nothing
        // is reordered. With B-frames the mp4 muxer meets pictures whose
        // presentation time it cannot know ("pts has no value") and silently
        // drops them, and each segment's reordering restarts at its own
        // boundary besides. Without them, coding order *is* display order,
        // every segment ends where the next begins, and concatenation is
        // exactly what it looks like. The cost is a few per cent of file
        // size; the gain is that a render is frame-exact no matter how many
        // segments it took.
        "-bf", "0",
        "-f", "h264",
        "-y", seg,
      ],
    });
    segments.push(seg);
    litter.push(seg);
    await cleanup(written);
    written.length = 0;
    pendingBytes = 0;
  };

  try {
    await loadMp4Tool({ onStatus, ...load });
    abortIf(signal);
    await call("mkdir", { path: WORK });

    for (let i = 0; i < frames; i++) {
      abortIf(signal);
      const png = await pngBytes(await paint(i));
      // Frames are numbered from zero *within a segment*: ffmpeg's image2
      // demuxer wants an unbroken run starting at the first index it finds,
      // and resetting per segment keeps that true however many there are.
      const path = `${WORK}/f${String(written.length).padStart(6, "0")}.png`;
      const owned = png.slice();
      await call("write", { path, data: owned }, [owned.buffer]);
      written.push(path);
      litter.push(path);
      pendingBytes += png.length;
      painted = i + 1;
      onStatus?.({
        phase: "paint",
        done: painted,
        total: frames,
        message: `rendering — frame ${painted} of ${frames}`,
      });
      if (pendingBytes >= segmentBytes || written.length >= segmentFrames) await flush();
    }
    await flush();
    abortIf(signal);

    if (!segments.length) throw new Error("nothing was rendered");

    // One segment is already the finished elementary stream; more than one are
    // joined inside the worker's own filesystem, which for Annex-B is exactly
    // `cat`. Doing it there rather than here keeps the encoded stream off the
    // main thread — reading it back to concatenate would rebuild the whole
    // render in page memory and undo the point of segmenting at all.
    let stream = segments[0];
    if (segments.length > 1) {
      stream = `${WORK}/all.h264`;
      litter.push(stream);
      await call("concat", { paths: segments, into: stream });
      segments.length = 0;   // `concat` deletes each part as it appends it
    }

    const outPath = `${WORK}/out.mp4`;
    litter.push(outPath);
    onStatus?.({ phase: "mux", done: frames, total: frames, message: "writing the MP4" });

    let audioPath = null;
    if (audio) {
      audioPath = `${WORK}/audio.bin`;
      litter.push(audioPath);
      const a = audio instanceof Uint8Array
        ? audio
        : new Uint8Array(audio instanceof ArrayBuffer ? audio : await audio.arrayBuffer());
      const owned = a.slice();
      await call("write", { path: audioPath, data: owned }, [owned.buffer]);
    }

    await call("run", {
      args: [
        "-r", String(fps), "-f", "h264", "-i", stream,
        ...(audioPath ? ["-i", audioPath] : []),
        "-c:v", "copy",
        // `apad` then `-shortest` is the pair that makes the soundtrack fit
        // whatever the video turned out to be. `-shortest` alone would cut the
        // *video* short if the audio ran out first — the picture ending early
        // because a track was a second shy is not a trade worth making — and
        // padding alone would run on forever. Together: silence to the end of
        // the picture, and not one frame past it.
        ...(audioPath ? ["-af", "apad", "-c:a", "aac", "-b:a", "192k", "-shortest"] : []),
        "-movflags", "+faststart",
        "-y", outPath,
      ],
    });
    const out = await call("read", { path: outPath });
    onStatus?.({ phase: "done", done: frames, total: frames, message: `MP4 ready — ${mb(out.length)}` });
    return new Blob([out], { type: "video/mp4" });
  } finally {
    await cleanup(litter);
    busy = null;
  }
}

/// Subscribe to ffmpeg's own log lines — the terminal output a native run
/// would print. Handy when an encode fails for a reason only ffmpeg knows.
export function onMp4Log(fn) {
  onLog = fn;
  return () => { if (onLog === fn) onLog = null; };
}

// ---------------------------------------------------------------------------
// GIF and WebM
//
// `la export` produces both from the CLI; the editor only ever produced MP4,
// so "export and deliver anywhere" stopped at the one format in the browser.
//
// Opaque WebM and GIF use one pass, capped to bound their PNG working set.
// Transparent WebM instead encodes bounded segments and joins their packets
// with the concat demuxer: byte-concatenating WebM would lose its timestamps
// and alpha-bearing BlockAdditional data.
// ---------------------------------------------------------------------------

/// The longest one-pass render either format will attempt.
///
/// Twenty seconds at 30fps. Past this the PNGs pile up in the worker's
/// in-memory filesystem, and a clear refusal beats an out-of-memory crash
/// with a half-written file.
export const MAX_ONE_PASS_FRAMES = 600;

/// VP8 in WebM, with Opus audio when a soundtrack is supplied.
function vp8Args({ crf = 12, deadline = "realtime", cpuUsed = 8, transparent = false } = {}) {
  return [
    // VP8, not VP9. VP9 in this wasm build runs out of heap before it
    // encodes a second frame ("Failed to allocate new_fb_ptr->mvs") — it
    // keeps far more reference state, and the core is built with a fixed
    // memory ceiling. VP8 is a legitimate WebM video codec, plays
    // everywhere WebM does, and fits.
    "-c:v", "libvpx",
    // VP8 shares its quantizer with the alpha encoder. A nonzero quantizer
    // turns clear matte pixels into alpha 1–2 at Studio resolution.
    "-crf", String(transparent ? 0 : crf),
    // libvpx treats `-crf` as a ceiling unless the bitrate is unconstrained.
    "-b:v", "0",
    "-deadline", deadline,
    "-cpu-used", String(cpuUsed),
    "-pix_fmt", transparent ? "yuva420p" : "yuv420p",
    ...(transparent ? ["-auto-alt-ref", "0", "-qmin", "0", "-qmax", "0"] : []),
  ];
}

/// Render `frames` painted images into one file, in a single ffmpeg pass.
///
/// `finish(inPath, outPath, audioPath)` returns the argument list; the caller
/// decides the codec, so the frame loop is written once for both formats.
async function onePass({
  frames,
  paint,
  fps,
  audio,
  outName,
  mime,
  label,
  finish,
  onStatus,
  signal,
  ...load
}) {
  if (!Number.isFinite(frames) || frames < 1) throw new Error(`${label} needs at least one frame`);
  if (frames > MAX_ONE_PASS_FRAMES) {
    throw new Error(
      `${label} is limited to ${MAX_ONE_PASS_FRAMES} frames in the browser ` +
      `(asked for ${frames}); use \`la export\` for a longer render`,
    );
  }
  claim("rendering");
  const litter = [];
  try {
    await loadMp4Tool({ onStatus, ...load });
    abortIf(signal);
    await call("mkdir", { path: WORK });

    for (let i = 0; i < frames; i++) {
      abortIf(signal);
      const png = await pngBytes(await paint(i));
      const path = `${WORK}/f${String(i).padStart(6, "0")}.png`;
      const owned = png.slice();
      await call("write", { path, data: owned }, [owned.buffer]);
      litter.push(path);
      onStatus?.({
        phase: "paint",
        done: i + 1,
        total: frames,
        message: `rendering — frame ${i + 1} of ${frames}`,
      });
    }
    abortIf(signal);

    let audioPath = null;
    if (audio) {
      audioPath = `${WORK}/audio.bin`;
      litter.push(audioPath);
      const a = audio instanceof Uint8Array
        ? audio
        : new Uint8Array(audio instanceof ArrayBuffer ? audio : await audio.arrayBuffer());
      const owned = a.slice();
      await call("write", { path: audioPath, data: owned }, [owned.buffer]);
    }

    const outPath = `${WORK}/${outName}`;
    litter.push(outPath);
    onStatus?.({ phase: "encode", done: frames, total: frames, message: `encoding the ${label}` });
    await call("run", { args: finish(`${WORK}/f%06d.png`, outPath, audioPath) });
    const out = await call("read", { path: outPath });
    onStatus?.({ phase: "done", done: frames, total: frames, message: `${label} ready — ${mb(out.length)}` });
    return new Blob([out], { type: mime });
  } finally {
    await cleanup(litter);
    busy = null;
  }
}

async function segmentedWebm({
  frames,
  paint,
  fps,
  crf,
  audio,
  segmentFrames = SEGMENT_FRAMES,
  segmentBytes = SEGMENT_BYTES,
  onStatus,
  signal,
  ...load
}) {
  if (!Number.isSafeInteger(frames) || frames < 1) throw new Error("WebM needs a positive integer frame count");
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(frames / fps)) {
    throw new Error("WebM needs a positive finite fps and duration");
  }
  if (!Number.isSafeInteger(segmentFrames) || segmentFrames < 1) {
    throw new Error("WebM segmentFrames must be a positive integer");
  }
  if (!Number.isFinite(segmentBytes) || segmentBytes <= 0) {
    throw new Error("WebM segmentBytes must be positive and finite");
  }
  claim("rendering");
  const litter = new Set();
  const written = [];
  const segments = [];
  let pendingBytes = 0;
  let painted = 0;
  const flush = async () => {
    if (!written.length) return;
    const path = `${WORK}/s${segments.length}.webm`;
    litter.add(path);
    onStatus?.({ phase: "encode", done: painted, total: frames, message: `encoding — frame ${painted} of ${frames}` });
    abortIf(signal);
    await call("run", {
      args: [
        "-framerate", String(fps), "-i", `${WORK}/f%06d.png`,
        "-frames:v", String(written.length), "-an", "-vf", EVEN,
        ...vp8Args({ crf, transparent: true }),
        "-y", path,
      ],
    });
    abortIf(signal);
    // WebM rounds duration to milliseconds. Using that rounded duration at
    // every boundary accumulates drift; concat needs the actual frame span.
    // FFmpeg parses these in microseconds. Round absolute boundaries, not
    // each segment independently, so even hours of short segments stay exact.
    const end = Math.round(painted / fps * 1e6);
    const start = Math.round((painted - written.length) / fps * 1e6);
    segments.push(`file '${path}'\nduration ${(end - start) / 1e6}\n`);
    await cleanup(written);
    for (const png of written) litter.delete(png);
    written.length = 0;
    pendingBytes = 0;
  };
  try {
    await loadMp4Tool({ onStatus, ...load });
    abortIf(signal);
    await call("mkdir", { path: WORK });
    for (let i = 0; i < frames; i++) {
      abortIf(signal);
      const png = await pngBytes(await paint(i));
      abortIf(signal);
      // Flush before adding a PNG that would overflow the byte budget. One
      // oversized frame is allowed, but never a whole segment of such frames.
      if (written.length && pendingBytes + png.length > segmentBytes) await flush();
      const path = `${WORK}/f${String(written.length).padStart(6, "0")}.png`;
      const owned = png.slice();
      litter.add(path);
      await call("write", { path, data: owned }, [owned.buffer]);
      written.push(path);
      pendingBytes += png.length;
      painted = i + 1;
      onStatus?.({ phase: "paint", done: painted, total: frames, message: `rendering — frame ${painted} of ${frames}` });
      abortIf(signal);
      if (written.length >= segmentFrames || pendingBytes >= segmentBytes) await flush();
    }
    await flush();
    abortIf(signal);
    const listPath = `${WORK}/segments.txt`;
    const list = new TextEncoder().encode(segments.join(""));
    litter.add(listPath);
    await call("write", { path: listPath, data: list }, [list.buffer]);
    let audioPath = null;
    if (audio) {
      audioPath = `${WORK}/audio.bin`;
      litter.add(audioPath);
      const a = audio instanceof Uint8Array
        ? audio
        : new Uint8Array(audio instanceof ArrayBuffer ? audio : await audio.arrayBuffer());
      abortIf(signal);
      const owned = a.slice();
      await call("write", { path: audioPath, data: owned }, [owned.buffer]);
    }
    const outPath = `${WORK}/out.webm`;
    litter.add(outPath);
    onStatus?.({ phase: "encode", done: frames, total: frames, message: "writing the WebM" });
    abortIf(signal);
    await call("run", {
      args: [
        "-f", "concat", "-safe", "0", "-i", listPath,
        ...(audioPath ? ["-i", audioPath] : []),
        "-map", "0:v:0", "-c:v", "copy",
        // Copy the VP8 packets, including their alpha side data. Fitting audio
        // explicitly avoids -shortest ending the picture at an Opus boundary.
        ...(audioPath ? [
          "-map", "1:a:0", "-af", `apad,atrim=duration=${frames / fps}`,
          // This core crashes encoding Studio's stereo mix in 20ms Opus
          // frames. Smaller frames avoid that path without downmixing audio.
          "-c:a", "libopus", "-frame_duration", "5", "-b:a", "128k",
        ] : ["-an"]),
        "-avoid_negative_ts", "disabled",
        "-y", outPath,
      ],
    });
    abortIf(signal);
    const out = await call("read", { path: outPath });
    abortIf(signal);
    onStatus?.({ phase: "done", done: frames, total: frames, message: `WebM ready — ${mb(out.length)}` });
    return new Blob([out], { type: "video/webm" });
  } finally {
    await cleanup(litter);
    busy = null;
  }
}

/// Encode painted frames as a WebM (VP8 video, Opus audio).
/// `transparent` preserves canvas alpha with bounded PNG segments; its
/// `segmentFrames` / `segmentBytes` limits default to the MP4 working set.
/// Alpha uses a zero quantizer to keep clear/opaque matte pixels intact;
/// `crf` controls only the opaque path.
/// The default opaque one-pass path retains its 600-frame limit.
export function framesToWebm({ frames, paint, fps = 30, crf = 12, audio = null, transparent = false, ...rest } = {}) {
  if (transparent) return segmentedWebm({ frames, paint, fps, crf, audio, ...rest });
  return onePass({
    frames,
    paint,
    fps,
    audio,
    outName: "out.webm",
    mime: "video/webm",
    label: "WebM",
    onStatus: rest.onStatus,
    signal: rest.signal,
    ...rest,
    finish: (input, output, audioPath) => [
      "-framerate", String(fps), "-i", input,
      ...(audioPath ? ["-i", audioPath] : []),
      ...(audioPath ? [] : ["-an"]),
      "-vf", EVEN,
      ...vp8Args({ crf }),
      // Same pairing as the MP4 path: pad the soundtrack to the picture,
      // then stop at whichever the picture is.
      ...(audioPath ? ["-af", "apad", "-c:a", "libopus", "-b:a", "128k", "-shortest"] : []),
      "-y", output,
    ],
  });
}

/// Encode painted frames as an animated GIF.
///
/// This wasm build uses FFmpeg's single-pass GIF palette because its
/// `palettegen`/`paletteuse` filter graph exceeds the browser heap. The native
/// CLI remains the high-fidelity path for a whole-clip optimized palette.
export function framesToGif({ frames, paint, fps = 30, ...rest } = {}) {
  return onePass({
    frames,
    paint,
    fps,
    // A GIF carries no soundtrack, so one is refused rather than ignored.
    audio: null,
    outName: "out.gif",
    mime: "image/gif",
    label: "GIF",
    onStatus: rest.onStatus,
    signal: rest.signal,
    ...rest,
    finish: (input, output) => [
      "-framerate", String(fps), "-i", input,
      "-an",
      // Single pass, with ffmpeg's built-in palette. The two-pass
      // `palettegen`/`paletteuse` pair gives a better picture — it picks
      // 256 colours from the WHOLE clip instead of per frame — but
      // `paletteuse` cannot be constructed in this wasm build's heap
      // ("Error creating filter 'paletteuse' / Out of memory"). `la export
      // --format gif` does the good version natively; this is the
      // in-browser one, and says so.
      "-vf", `${EVEN}`,
      "-gifflags", "+transdiff",
      "-loop", "0",
      "-y", output,
    ],
  });
}
