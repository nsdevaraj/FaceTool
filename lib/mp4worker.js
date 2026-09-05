// LittleA Character and Editor — the worker that hosts the ffmpeg.wasm core.
//
// ffmpeg.wasm is a 32 MB module that runs a real, synchronous C main() every
// time it encodes. On the main thread that would freeze the page for the whole
// render, so the core lives here and the page talks to it by message. This
// file is deliberately the *only* place that knows the core's own API; the
// page-side half of the conversation is `mp4.js`, and nothing else imports it.
//
// A **classic** worker, not a module one, for a specific reason: the core has
// to be loadable from wherever it was found. A vendored copy is an ordinary
// URL, but a copy restored from the browser's cache is a Blob, and
// `importScripts()` takes a blob: URL where a static `import` cannot. The wasm
// itself never goes through `locateFile` — the page fetches those 32 MB (so it
// can show progress and cache the result) and transfers the ArrayBuffer here,
// which Emscripten accepts as `wasmBinary`.
//
// Every request carries an `id` and gets exactly one `{ id, ok }` reply. Logs
// and progress arrive unsolicited, with no `id`, because they belong to the
// run rather than to any one request.

/* eslint-env worker */

let core = null;

// ffmpeg writes everything a human would see on a terminal — including the
// reason an encode failed — to its logger. The last lines are kept so a
// failed `run` can report *why* instead of just a non-zero exit code.
const tail = [];
const TAIL_MAX = 40;

function loadCore(coreUrl, wasmBinary) {
  // `importScripts` is the classic-worker path and defines the factory as a
  // global. The ESM core is a module with a default export instead, so if the
  // caller handed us one of those, fall back to a dynamic import.
  try {
    importScripts(coreUrl);
  } catch {
    return import(/* @vite-ignore */ coreUrl).then((m) => start(m.default, wasmBinary));
  }
  return start(self.createFFmpegCore, wasmBinary);
}

async function start(factory, wasmBinary) {
  if (typeof factory !== "function") throw new Error("ffmpeg-core.js did not define createFFmpegCore");
  core = await factory({
    // Handing the bytes over means Emscripten never fetches the .wasm itself,
    // so the core does not need to know where it lives and works identically
    // whether it came from disk, from the cache, or off the network.
    wasmBinary,
    // The core's own `locateFile` would otherwise try to resolve a sibling
    // .wasm relative to a blob: URL, which has no directory to be relative to.
    locateFile: (path) => path,
  });
  core.setLogger(({ type, message }) => {
    tail.push(message);
    if (tail.length > TAIL_MAX) tail.shift();
    self.postMessage({ type: "log", level: type, message });
  });
  core.setProgress(({ progress, time }) => self.postMessage({ type: "progress", progress, time }));
  return true;
}

// One ffmpeg invocation, argv exactly as it would be typed. `core.exec` is
// synchronous — it returns when the encode is done — and leaves its exit code
// in `core.ret`; `reset()` clears the state the next run would otherwise
// inherit.
function run(args, timeout) {
  tail.length = 0;
  core.setTimeout(timeout ?? -1);
  core.exec(...args);
  const ret = core.ret;
  core.reset();
  if (ret !== 0) {
    const why = tail.filter((l) => l && !/^\s*$/.test(l)).slice(-6).join("\n");
    throw new Error(`ffmpeg exited ${ret}${why ? `\n${why}` : ""}`);
  }
  return ret;
}

// The core's MEMFS is a plain in-memory filesystem, so anything written here
// counts against the tab's heap. `mp4.js` is what keeps that bounded; these
// are just the primitives it does it with.
const ops = {
  load: ({ coreUrl, wasmBinary }) => loadCore(coreUrl, wasmBinary),
  run: ({ args, timeout }) => run(args, timeout),
  write: ({ path, data }) => { core.FS.writeFile(path, data); return true; },
  read: ({ path }) => core.FS.readFile(path),
  remove: ({ path }) => { core.FS.unlink(path); return true; },
  mkdir: ({ path }) => { try { core.FS.mkdir(path); } catch { /* already there */ } return true; },
  list: ({ path }) => core.FS.readdir(path).filter((n) => n !== "." && n !== ".."),
  size: ({ path }) => core.FS.stat(path).size,
  // Join files end to end without either half crossing postMessage. The page
  // could read each part and write the whole back, but that would put the
  // entire encoded stream — and a second copy of it — on the main thread,
  // which is exactly the memory the segmented encode exists to avoid. Each
  // source is freed as soon as it has been appended, so the peak is one
  // segment plus the growing target.
  concat: ({ paths, into }) => {
    const out = core.FS.open(into, "w");
    try {
      for (const p of paths) {
        const bytes = core.FS.readFile(p);
        core.FS.write(out, bytes, 0, bytes.length);
        core.FS.unlink(p);
      }
    } finally {
      core.FS.close(out);
    }
    return true;
  },
};

self.onmessage = async ({ data: { id, op, ...args } }) => {
  try {
    const fn = ops[op];
    if (!fn) throw new Error(`unknown ffmpeg op "${op}"`);
    if (op !== "load" && !core) throw new Error("ffmpeg core is not loaded");
    const data = await fn(args);
    // A file read hands back the only copy of what can be a very large buffer;
    // transferring it avoids a second one existing even briefly. This is safe
    // because the core's FS.readFile allocates a fresh array rather than
    // handing out a view into the wasm heap — transferring one of those would
    // detach the whole module's memory.
    self.postMessage({ id, ok: true, data }, data instanceof Uint8Array ? [data.buffer] : []);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
};
