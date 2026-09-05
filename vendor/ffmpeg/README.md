# `ffmpeg.wasm` core — Character Studio and editor MP4 encoder

Character Studio and the browser editor render MP4 using real ffmpeg compiled
to WebAssembly, driven by [`lib/mp4.js`](../../lib/mp4.js) in the worker
[`lib/mp4worker.js`](../../lib/mp4worker.js). This directory is where that core
lives. Both applications use this single implementation.

**The two artefacts below are not in git.** Fetch them with one command:

```sh
node tools/fetch-ffmpeg-core.mjs          # from the character folder
node tools/fetch-ffmpeg-core.mjs --check  # verify what is already here
```

| | |
| --- | --- |
| Package | [`@ffmpeg/core`](https://github.com/ffmpegwasm/ffmpeg.wasm) — single-threaded UMD build |
| Version | **0.12.6** |
| Files | `ffmpeg-core.js` (114,673 bytes), `ffmpeg-core.wasm` (32,129,114 bytes) |
| Upstream | `https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/` |
| Licence | **GPL-2.0-or-later** (built `--enable-gpl --enable-libx264`) |

```sh
sha256sum vendor/ffmpeg/ffmpeg-core.*
# a34873964b0f62aec516bac75e3aa9086ec3535d4d07f0269aa94ea748b6cb71  ffmpeg-core.js
# 2390efa7fb66e7e42dbae15427571a5ffc96b829480904c30f471f0a78967f61  ffmpeg-core.wasm
```

## Why this one is fetched rather than committed

The application code is committed, because Character Studio is a buildless app
that must style and run itself with no network. This one is the exception, for
two reasons that both point the same way:

- **Size.** The core is 32 MB. The largest file otherwise tracked in this
  repository is 1.4 MB, and the whole history is under 100 MB — committing the
  core would roughly double the repo for every clone, including the ones that
  never export a video.
- **Licence.** LittleA is MIT OR Apache-2.0. The core is GPL, because H.264
  encoding means libx264 and libx264 is GPL. Redistributing it from this
  repository would put a copyleft binary inside a permissively licensed tree.
  Fetching it on request keeps the two separate: the GPL program is obtained,
  unmodified, from its own publisher, and merely *run* by the editor.

## Why single-threaded

The multi-threaded core (`@ffmpeg/core-mt`) is faster, but it uses
`SharedArrayBuffer`, which browsers only allow in a cross-origin-isolated page —
meaning the server has to send `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` headers. The editor is meant to open from any
plain static file server (and from `python3 -m http.server`), so it uses the
build that needs no headers at all.

## What the editor does when this directory is empty

It still works, and it never reaches the network on its own:

1. If the core is here, it is used — offline, no request beyond this origin.
2. Otherwise, if this browser downloaded the core on a previous visit, the copy
   in the Cache API is used.
3. Otherwise the export offers a one-time ~31 MB download, and only proceeds
   once the person says yes. Declining leaves every WebM export working exactly
   as before.

Whichever of the three it was, the bytes are hashed and compared against the
table above before the core is executed, and a cached copy that fails is
evicted rather than left to fail again. This script refuses to *write* bytes
that do not match; `lib/mp4.js` refuses to *run* them.

## Upgrading

Change the version and the hashes in **three** places — they are deliberately
duplicated so that a mismatch is loud rather than silent:

- `tools/fetch-ffmpeg-core.mjs` (`VERSION`, `FILES`)
- `lib/mp4.js` (`MP4_CORE`)
- this file

Then `node tools/fetch-ffmpeg-core.mjs --force` and re-run `npm test` in the
character folder. Its portable browser test checks a real encode against system
`ffprobe`. Within the LittleA repository, also run `node editor/js/mp4-test.mjs`
to check editor compatibility, cache verification, GIF and segmented MP4 encoding.

For a completely offline folder copy, include both installed encoder files.
They remain gitignored and are not covered by LittleA's permissive license:
redistribution must comply with the upstream GPL license and corresponding-source
requirements. See the [upstream project](https://github.com/ffmpegwasm/ffmpeg.wasm).
