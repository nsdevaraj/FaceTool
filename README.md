# Character Studio

This folder is a standalone, buildless application. Copy it anywhere and serve
it over HTTP; it does not need `editor/`, `apps/shared/`, a bundler, or a backend.
From inside the copied `character` folder:

```sh
python3 -m http.server 8081 --bind 127.0.0.1
```

Open <http://localhost:8081/>. Hosting under a subdirectory also works because
assets, modules and workers use relative URLs. Direct `file:` loading cannot
load ES modules. Microphone capture requires localhost or HTTPS.

The original repository URL `/apps/character/` still works. Existing browser
projects keep their storage keys. When moving to a different origin, export a
Studio JSON backup first and import it at the new site; browser storage does
not move with the folder.

## Package layout

- `app.js`, `ui.mjs`, `index.html`: Studio controls and UI.
- `performance.mjs`: audio analysis, lips, gestures, face/camera timeline,
  vector rendering and self-contained LAX export.
- `video.mjs`: deterministic video rendering and offline audio mixing.
- `artwork-editor.mjs`, `artwork-model.mjs`: SVG editing drafts, validated vector
  artwork, and conversion between drawing tools and saved paths.
- `lib/`: Face Tool geometry, visemes, SVG/XML helpers, FFmpeg adapter and worker.
- `assets/`: local stylesheet and logo (App Lab assets bundled for portability).
- `vendor/ffmpeg/`: optional installed FFmpeg WASM core and license information.
- `tools/fetch-ffmpeg-core.mjs`: local, hash-verified encoder installer.
- `tests/`: character regressions, including a browser test that copies this
  folder to a temporary location and serves it without repository access.

Runtime library implementations live here. The main editor keeps small
compatibility exports pointing here, rather than separate copies of the
geometry or encoder. Editor-specific dialogs and native LittleA tooling remain
in their host projects; they are not needed to run Character Studio. The source
licenses are included as `LICENSE-MIT` and `LICENSE-APACHE`.

## Make a talking character

1. Import an audio file or record a voice take. Each scene owns its audio.
   Audio is decoded locally and stored as embedded WAV, not a temporary URL.
2. Play or scrub the waveform. Lip timing uses Face Tool's amplitude analysis,
   not speech/phoneme recognition; script notes do not generate speech.
3. Select any of the 15 Face Tool mouth shapes. Adjust width and opening,
   reset one shape, or apply a size to all shapes. Settings belong to the
   character, so repeated uses stay consistent. Skin and lip colors are editable.
4. For precise timing, scrub to a position, choose a shape, and select
   **Set at playhead**. A cue holds until the next cue. Auto-align and Regenerate
   replace manual cues with a fresh audio analysis.
5. Add scenes and assign characters. Pace applies to audio and animation
   together (speed changes also change voice pitch).
   Without audio, a scene is silent and its duration is editable.

Projects, including audio, autosave in IndexedDB. Storage failures are reported;
export a Studio project backup if storage is unavailable or full. Browser
storage is local to the site's origin and browser profile.

## Edit face, hands and canvas as SVG

Choose **Edit SVG artwork** above the stage, **Edit face SVG** under Face, or
**Edit hands SVG** under Gesture. The target selector offers:

- **Face:** head, eyes, eyebrows and nose. The animated mouth is separate and
  still uses the lip controls and audio cues. Custom face artwork follows head
  motion, but replaces the built-in automatic blink and expression artwork.
- **Body:** neck and clothing.
- **Left/right hand:** a 160 x 160 drawing with the wrist at (80, 80). Draw palms
  and fingers around that anchor; each hand follows its arm through gestures.
- **Canvas background / foreground:** the entire 640 x 480 scene behind or in
  front of the animated character. Add backgrounds, props, frames and decorations.

Select a shape to move/resize it or edit supported path nodes. Draw with the
pen, freehand, line and shape tools; change fill/stroke, duplicate, reorder,
undo or redo. Switch targets without losing drafts. **Preview edits** shows the
combined scene at the playhead. **Apply artwork** saves all changed targets;
**Cancel** or Escape discards the session. **Reset this artwork** restores the
selected target's generated default only after Apply.

The artwork toolbar uses bundled SVG icons, with tooltips on hover or keyboard
focus. Tooltips include keyboard shortcuts where available; Escape dismisses
a tooltip. No icon font or network connection is needed.

Use **Transparent fill** (the slashed square beside Fill) to remove the selected shape's fill without
removing its outline. Toggle it off or pick a colour to restore a solid fill.
With no shape selected, it sets the fill for newly drawn shapes. Transparent
fills are preserved in saved artwork, SVG, LAX and video exports.

Character artwork is shared by scenes using that character; canvas artwork
belongs only to the current scene. These are persistent design edits, not new
timeline cues. Camera framing affects the character, while background and
foreground artwork remain in scene coordinates. Existing projects are unchanged
until artwork is applied.

The drawing toolbar imports simple vector SVGs; **Download SVG** exports the
selected target. Supported artwork uses paths, rectangles, circles/ellipses,
lines and polygons with solid hex colors or no paint. Text, gradients, images,
scripts, external references, rotation and advanced stroke effects are not
supported by this character path workflow and are rejected rather than silently
lost. Convert complex artwork to simple paths before importing.

Applied artwork is stored in Studio JSON and IndexedDB, baked into animated LAX,
and rendered into FFmpeg WASM video. **Current scene SVG** in the export dialog
downloads a static vector snapshot at the playhead; use LAX to retain animation
and audio.

## Voice-aligned performance timeline

The Gesture palette includes Idle, Wave, Explain, Point, Nod, Shake, Shrug,
Cheer, Clap, and Think. Press Play to see the movement; Energy controls its
strength and Pace controls its speed. Explicit head gestures still animate
when Head follow is off.

- Click or drag the waveform, use its arrow/Home/End keys, click the time ruler,
  or enter an exact **Seek (seconds)** value. The playhead, voice, visemes, face,
  gestures, and camera share one timeline. Seeking during playback resumes audio at the
  chosen position; dragging pauses audio until release.
- Select a Face preset or Gesture to record a change at the playhead, on the
  current scene's 30 fps source timeline. Changes hold until the next change.
  Gesture motion restarts when its cue begins.
- Click **Camera** to cycle close-up, medium shot, and wide shot, saving that
  framing at the playhead. Camera changes are cuts that hold until the next cue;
  they do not change the framing before the cue or in another scene.
- Click a Face/Gesture/Camera cue to seek to it, then select another preset to replace
  it, or use **Delete selected change**. Default spans are not authored cues.
- Time labels and exact seeking use the paced playback time. Changing Pace
  keeps the stored changes aligned with the same words in the source audio.
- Changes autosave per scene and survive Studio JSON, video, and LAX export.
  Older projects keep their global face/gesture and scene camera framing as defaults before any cues.
  Auto-align only regenerates lip cues. Shortening/replacing audio removes
  performance cues beyond the new scene end, while preserving earlier changes.

## Export

- **Reusable LittleA scene (.lax):** all scenes in order, vector character
  artwork, animation timelines, and embedded WAV sound cues. Open the file in
  the main LittleA editor to edit or reuse it in another LittleA project.
- **Video:** transparent background is enabled by default. FFmpeg WASM produces
  a 640 x 480, 30 fps WebM with VP8 alpha video and Opus audio. This omits the
  entire Canvas background target (including its decorations), while retaining
  the animated character and Foreground artwork. Preview, SVG and LAX exports
  are unchanged. Some players display transparent video against black; use an
  alpha-aware editor or composite it over another background.
  Uncheck **Transparent video background** for H.264 MP4 with AAC audio and the
  scene's background. Standard H.264 MP4 does not preserve transparency.
  Frames render individually, not through MediaRecorder or live playback, so
  slower encoding does not drop animation frames. The audio mix uses the same
  paced, frame-aligned scene boundaries as LAX export. Cancel stops the encoder
  and discards the export. Hiding the tab does not cancel rendering.
- **Editable Studio project (.json):** all scenes, characters, mouth settings,
  manual cues and embedded audio. Restore it using **Open project**.
- **Current scene SVG:** a static, editable vector snapshot of the scene at the
  playhead, including custom artwork; no audio or animation.

Audio clips are limited to 10 minutes and 80 MB per import. Browser codec support
determines which input files decode. WAV export is uncompressed, so project and
LAX files may be substantially larger than the original compressed audio.
Both video formats use the installed files in this folder's `vendor/ffmpeg/`,
then the browser cache. If missing, either run `node tools/fetch-ffmpeg-core.mjs`
from the character folder, or enable the export dialog's one-time ~31 MB download.
Downloads are opt-in and hash-verified; project media never leaves the browser.
There is no silent fallback to another video encoder when FFmpeg is unavailable.
For very long videos, the native LittleA CLI may use less browser memory.
The exported LAX header includes an MP4 export command with the exact frame count;
replace `scene.lax` with the downloaded filename. The CLI also preserves embedded
audio when mixing, rendering video, or bundling the scene.

For offline portability, run the installer before copying and include both
`vendor/ffmpeg/ffmpeg-core.js` and `vendor/ffmpeg/ffmpeg-core.wasm`. These large GPL
assets are gitignored, so a fresh clone needs installation or download consent.
See [encoder licensing and setup](vendor/ffmpeg/README.md). The original
repository-root `node tools/fetch-ffmpeg-core.mjs` command still installs here.

## Tests

From this folder:

```sh
npm ci
npx playwright install chromium
node tools/fetch-ffmpeg-core.mjs
npm test
```

Tests use Node's test runner and Playwright; system `ffmpeg` and `ffprobe` are
required to inspect generated video. These are test dependencies, not runtime
dependencies. Native LAX compilation checks additionally use the repository's
built `la` CLI when available (or `LA_CLI` pointing to an installed executable).
