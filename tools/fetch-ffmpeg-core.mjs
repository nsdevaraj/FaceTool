// Vendor the ffmpeg.wasm core shared by Character Studio and the editor.
//
// The browser can render MP4 in the page (lib/mp4.js), which it
// does by running a real ffmpeg compiled to WebAssembly. That core is 32 MB
// and, being built `--enable-gpl --enable-libx264`, it is GPL — where this
// repository is MIT OR Apache-2.0. Two good reasons not to commit it, and one
// good reason to make fetching it a single command: without a local copy the
// editor can only offer to download it from a CDN at run time, which is no
// use on a machine that is offline, and no use to anyone who would rather the
// editor never opened a socket at all.
//
// So: run this once, and `vendor/ffmpeg/` has the core. From then on
// MP4 export is local, offline, and instant to start. The files are
// .gitignored; this script is the record of exactly which build they are.
//
// Usage (from the Character Studio folder):
//   node tools/fetch-ffmpeg-core.mjs            # fetch if missing
//   node tools/fetch-ffmpeg-core.mjs --force    # re-fetch and re-verify
//   node tools/fetch-ffmpeg-core.mjs --check    # verify what is there, fetch nothing
//
// The expected hashes live here AND in lib/mp4.js (`MP4_CORE.sha256`),
// because the editor quotes the download size in its own UI. Bumping the
// version means changing both, and vendor/ffmpeg/README.md.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(packageDir, "vendor/ffmpeg");

const VERSION = "0.12.6";
const BASE = `https://unpkg.com/@ffmpeg/core@${VERSION}/dist/umd/`;

// Single-threaded on purpose. The multi-threaded core needs COOP/COEP headers
// and therefore a server that sets them; the editor is meant to be opened
// from any plain static file server, so it uses the build that does not care.
const FILES = [
  { name: "ffmpeg-core.js", sha256: "a34873964b0f62aec516bac75e3aa9086ec3535d4d07f0269aa94ea748b6cb71", bytes: 114_673 },
  { name: "ffmpeg-core.wasm", sha256: "2390efa7fb66e7e42dbae15427571a5ffc96b829480904c30f471f0a78967f61", bytes: 32_129_114 },
];

const force = process.argv.includes("--force");
const checkOnly = process.argv.includes("--check");
const mb = (n) => `${(n / 1_048_576).toFixed(1)} MB`;
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function verify(path, want) {
  if (!existsSync(path)) return "missing";
  const got = sha(readFileSync(path));
  return got === want ? "ok" : `hash mismatch (${got.slice(0, 12)}…)`;
}

if (checkOnly) {
  let bad = 0;
  for (const f of FILES) {
    const state = verify(join(outDir, f.name), f.sha256);
    console.log(`${state === "ok" ? "ok  " : "FAIL"} ${f.name} — ${state}`);
    if (state !== "ok") bad++;
  }
  if (bad) {
    console.error(`\n${bad} file(s) need fetching: node tools/fetch-ffmpeg-core.mjs --force`);
    process.exit(1);
  }
  console.log(`\nffmpeg.wasm core ${VERSION} is vendored and verified.`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

let fetched = 0;
for (const f of FILES) {
  const path = join(outDir, f.name);
  if (!force && verify(path, f.sha256) === "ok") {
    console.log(`have  ${f.name} (${mb(statSync(path).size)})`);
    continue;
  }
  process.stdout.write(`get   ${f.name} (${mb(f.bytes)}) … `);
  const res = await fetch(BASE + f.name);
  if (!res.ok) {
    console.error(`\nFATAL: ${BASE}${f.name} — HTTP ${res.status}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha(buf);
  if (got !== f.sha256) {
    // A wrong hash means the bytes are not the build this repository was
    // tested against. Refuse rather than write it: a silently different
    // ffmpeg is a silently different export.
    console.error(`\nFATAL: ${f.name} hash mismatch\n  expected ${f.sha256}\n  got      ${got}`);
    process.exit(1);
  }
  writeFileSync(path, buf);
  console.log("ok");
  fetched++;
}

console.log(
  `\nffmpeg.wasm core ${VERSION} is in ${outDir}`
  + `${fetched ? "" : " (nothing to do)"}.`
  + `\nMP4 export now works offline — see vendor/ffmpeg/README.md.`,
);
