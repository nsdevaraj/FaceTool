import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, extname, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { exerciseSvgArtwork } from "./artwork-browser.mjs";

const source = fileURLToPath(new URL("../", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".wasm": "application/wasm" };

for (const mount of ["/", "/portable/nested/character/"]) {
test(`Standalone Character Studio at ${mount} imports audio, edits every pose, persists, and exports real media`, { timeout: 90000 }, async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "littlea-character-test-"));
  const root = resolve(workspace, "site");
  const escapedRequests = [];
  const failedRequests = [];
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const path = resolve(root, pathname.slice(mount.length) || "index.html");
      if (!pathname.startsWith(mount) || !path.startsWith(root + sep)) {
        escapedRequests.push(request.url);
        response.writeHead(403).end();
        return;
      }
      if (!(await realpath(path)).startsWith(root + sep)) {
        escapedRequests.push(request.url);
        response.writeHead(403).end();
        return;
      }
      const data = await readFile(path);
      response.writeHead(200, {
        "content-type": types[extname(path)] || "application/octet-stream",
        "content-length": data.length,
      }).end(request.method === "HEAD" ? undefined : data);
    } catch (error) {
      failedRequests.push(`${request.url}: ${error.code || error.message}`);
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end();
    }
  });
  let browser;
  try {
    await cp(source, root, { recursive: true,
      filter: path => !["node_modules", ".git", "tests"].includes(basename(path)) && !basename(path).startsWith(".character-test-") });
    await access(resolve(root, "vendor/ffmpeg/ffmpeg-core.wasm"));
    await mkdir(resolve(workspace, "downloads"));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.LA_CHROMIUM || undefined,
      downloadsPath: resolve(workspace, "downloads"),
      args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    const workers = [];
    const requests = [];
    const downloads = [];
    const missingCoreRequests = new WeakSet();
    const successfulHeadRequests = new WeakSet();
    const completedRequests = new Set();
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || !url.pathname.startsWith(mount)) {
        escapedRequests.push(url.href);
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("worker", worker => workers.push(worker.url()));
    context.on("request", request => requests.push(request.url()));
    context.on("requestfinished", request => {
      if (request.method() === "GET") completedRequests.add(request.url());
    });
    context.on("requestfailed", request => {
      // Chromium reports some bodyless HEAD probes as aborted after receiving successful headers.
      if (successfulHeadRequests.has(request) && request.failure()?.errorText === "net::ERR_ABORTED") return;
      if (!missingCoreRequests.has(request)) failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
    });
    context.on("response", response => {
      if (response.request().method() === "HEAD" && response.ok()) successfulHeadRequests.add(response.request());
      if (response.status() >= 400 && !missingCoreRequests.has(response.request())) {
        failedRequests.push(`${response.url()}: HTTP ${response.status()}`);
      }
    });
    page.on("download", download => downloads.push(download));
    await page.addInitScript(() => {
      HTMLCanvasElement.prototype.captureStream = () => { throw new Error("Video export must not capture a live canvas stream"); };
      const Recorder = MediaRecorder;
      window.MediaRecorder = class extends Recorder {
        constructor(stream, options) {
          if (stream.getVideoTracks().length) throw new Error("Video export must use FFmpeg WASM");
          super(stream, options);
        }
      };
      window.audioStarts = [];
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function(when, offset = 0, ...rest) {
        if (this.context instanceof AudioContext) window.audioStarts.push({ when, offset, rate: this.playbackRate.value });
        return start.call(this, when, offset, ...rest);
      };
    });
    await page.goto(`${origin}${mount}index.html`);
    await page.locator("#lip-shapes button").first().waitFor();
    assert.equal(await page.locator("#video-transparent").isChecked(), true, "video transparency is enabled by default");
    const presentation = await page.evaluate(() => {
      const stylesheet = document.querySelector('link[rel="stylesheet"]');
      const logo = document.querySelector('img[src="./assets/littlea-masks.png"]');
      return {
        stylesheet: stylesheet?.href,
        rules: stylesheet?.sheet?.cssRules.length || 0,
        logo: logo?.currentSrc,
        logoLoaded: Boolean(logo?.complete && logo.naturalWidth > 0 && logo.naturalHeight > 0),
      };
    });
    assert.equal(presentation.stylesheet, `${origin}${mount}assets/app.css`);
    assert.ok(presentation.rules > 0, "the copied local stylesheet is loaded and parsed");
    assert.equal(presentation.logo, `${origin}${mount}assets/littlea-masks.png`);
    assert.equal(presentation.logoLoaded, true, "the copied local logo is loaded and decoded");
    assert.equal(await page.locator("#lip-shapes button").count(), 15);
    const waveBounds = await page.locator("#waveform").boundingBox();
    await page.locator("#waveform").click({ position: { x: waveBounds.width / 2, y: waveBounds.height / 2 } });
    const seekGeometry = await page.evaluate(() => {
      const wave = document.querySelector("#waveform").getBoundingClientRect();
      const head = document.querySelector("#playhead").getBoundingClientRect();
      return { actual: head.left, expected: wave.left + wave.width / 2 };
    });
    assert.ok(Math.abs(seekGeometry.actual - seekGeometry.expected) < 2, "playhead aligns with the sought waveform midpoint");
    await page.getByRole("button", { name: "Go to start", exact: true }).click();
    assert.equal(await page.locator(".tool-grid button").count(), 10);
    for (const name of ["Idle", "Wave", "Explain", "Point", "Nod", "Shake", "Shrug", "Cheer", "Think", "Clap"]) {
      const gesture = page.getByRole("button", { name, exact: true });
      await gesture.click();
      assert.equal(await gesture.getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator('.tool-grid [aria-pressed="true"]').count(), 1);
    }
    for (const pose of await page.locator("#lip-shapes button").all()) {
      await pose.click();
      assert.equal(await pose.getAttribute("aria-pressed"), "true");
    }
    await page.locator('#lip-shapes button[data-pose="aa"]').click();
    await page.locator("#lip-width").fill("145");
    await page.locator("#lip-opening").fill("160");
    await page.locator('[data-action="set-pose"]').click();

    const wav = await page.evaluate(async () => {
      const { encodeWav } = await import("./performance.mjs");
      const samples = Float32Array.from({ length: 16000 }, (_, i) =>
        i < 4000 || i >= 12000 ? 0 : 0.3 * Math.sin(i * Math.PI / 16));
      return [...new Uint8Array(encodeWav({ sampleRate: 16000, numberOfChannels: 1,
        length: samples.length, getChannelData: () => samples }))];
    });
    await page.locator("#audio-file").setInputFiles({ name: "speech.wav", mimeType: "audio/wav", buffer: Buffer.from(wav) });
    await page.waitForFunction(() => document.querySelector("#studio-status").textContent.includes("speech.wav"));
    assert.equal(await page.locator("#scene-duration").isDisabled(), true);
    assert.ok(await page.locator(".visemes button").count() > 1);
    await page.locator("#pace").fill("50");
    await page.locator("#seek-time").fill("0.40");
    await page.locator("#seek-time").press("Tab");
    assert.match(await page.locator("#timecode").textContent(), /00:00.40 \/ 00:02.00/);
    await page.getByRole("button", { name: "Play scene", exact: true }).click();
    await page.waitForFunction(() => window.audioStarts.length > 0);
    let started = await page.evaluate(() => window.audioStarts.at(-1));
    assert.ok(Math.abs(started.offset - 0.2) < 0.01, "exact seek starts the voice at the source offset");
    assert.equal(started.rate, 0.5);
    const bounds = await page.locator("#waveform").boundingBox();
    await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height / 2, { steps: 4 });
    assert.equal(await page.locator("#waveform").getAttribute("aria-valuenow"), "75");
    const head = await page.locator("#playhead").boundingBox();
    assert.ok(Math.abs(head.x - (bounds.x + bounds.width * 0.75)) < 2, "dragged playhead uses the voice track coordinates");
    await page.mouse.up();
    await page.waitForFunction(() => window.audioStarts.length > 1);
    started = await page.evaluate(() => window.audioStarts.at(-1));
    assert.ok(Math.abs(started.offset - 0.75) < 0.01, "drag release resumes voice at the selected sample position");
    await page.getByRole("button", { name: "Pause scene", exact: true }).click();
    await page.locator("#pace").fill("100");
    await page.getByRole("button", { name: "Go to start", exact: true }).click();
    await page.getByRole("button", { name: "Play scene", exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector("#waveform").getAttribute("aria-valuenow")) > 25);
    await page.getByRole("button", { name: "Pause scene", exact: true }).click();
    await page.locator("#waveform").focus();
    await page.keyboard.press("Home");
    await page.waitForFunction(() => document.querySelector("#waveform").getAttribute("aria-valuenow") === "0");
    await page.locator('#lip-shapes button[data-pose="aa"]').click();
    await page.locator('[data-action="set-pose"]').click();
    await page.waitForFunction(() => document.querySelector(".save-state").textContent.includes("Saved locally"));
    await page.reload();
    await page.locator('#lip-shapes button[data-pose="aa"]').click();
    assert.equal(await page.getByRole("button", { name: "Clap", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#lip-width").inputValue(), "145");
    assert.equal(await page.locator("#lip-opening").inputValue(), "160");
    assert.match(await page.locator("#studio-status").textContent(), /speech.wav/);

    async function seekTo(seconds) {
      await page.locator("#seek-time").fill(String(seconds));
      await page.locator("#seek-time").press("Tab");
    }
    await seekTo(0.5);
    await page.getByRole("button", { name: "Focused", exact: true }).click();
    await page.getByRole("button", { name: "Cheer", exact: true }).click();
    await page.locator('[data-action="camera"]').click();
    assert.equal(await page.locator('[data-action="camera"]').textContent(), "Camera · medium shot");
    await seekTo(0.8);
    await page.getByRole("button", { name: "Bright", exact: true }).click();
    await page.getByRole("button", { name: "Nod", exact: true }).click();
    await page.locator('[data-action="camera"]').click();
    await page.locator('#camera-track [data-frame="24"]').click();
    await page.locator('[data-action="delete-performance-cue"]').click();
    assert.equal(await page.locator('[data-action="camera"]').textContent(), "Camera · medium shot");
    await page.locator('[data-action="camera"]').click();
    assert.equal(await page.locator('#camera-track [data-frame="24"]').count(), 1);
    assert.match(await page.locator("#timeline-selection").textContent(), /Camera change/);
    await page.locator('#expression-track [data-frame="24"]').click();
    await page.locator('[data-action="delete-performance-cue"]').click();
    assert.equal(await page.locator("#expression-name").textContent(), "Focused");
    await page.getByRole("button", { name: "Bright", exact: true }).click();
    assert.equal(await page.locator('#expression-track [data-frame="24"]').count(), 1);
    await seekTo(0.1);
    assert.equal(await page.locator("#expression-name").textContent(), "Warm");
    assert.equal(await page.locator('[data-action="camera"]').textContent(), "Camera · close-up", "camera edits do not affect earlier audio");
    assert.equal(await page.getByRole("button", { name: "Clap", exact: true }).getAttribute("aria-pressed"), "true");
    await seekTo(0.65);
    assert.equal(await page.locator("#expression-name").textContent(), "Focused");
    assert.equal(await page.locator('[data-action="camera"]').textContent(), "Camera · medium shot");
    assert.equal(await page.getByRole("button", { name: "Cheer", exact: true }).getAttribute("aria-pressed"), "true");
    await page.waitForFunction(() => document.querySelector(".save-state").textContent.includes("Saved locally"));
    await page.reload();
    await page.locator("#lip-shapes button").first().waitFor();
    await seekTo(0.9);
    assert.equal(await page.locator("#expression-name").textContent(), "Bright");
    assert.equal(await page.locator('[data-action="camera"]').textContent(), "Camera · wide shot");
    assert.equal(await page.getByRole("button", { name: "Nod", exact: true }).getAttribute("aria-pressed"), "true");
    for (const track of ["#expression-track", "#gesture-track", "#camera-track", ".visemes"]) {
      const box = await page.locator(track).boundingBox();
      const voice = await page.locator("#waveform").boundingBox();
      assert.equal(box.x, voice.x, `${track} starts at the audio origin`);
      assert.equal(box.width, voice.width, `${track} shares the audio scale`);
    }
    await page.getByRole("button", { name: "Go to start", exact: true }).click();
    await page.getByRole("button", { name: "Play scene", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#expression-name").textContent === "Focused"
      && document.querySelector('.tool-grid [data-select="Cheer"]').getAttribute("aria-pressed") === "true"
      && document.querySelector('[data-action="camera"]').textContent === "Camera · medium shot");
    const middleProgress = Number(await page.locator("#waveform").getAttribute("aria-valuenow"));
    assert.ok(middleProgress >= 50 && middleProgress < 80, "performance changes activate at the audio position, not globally");
    await page.waitForFunction(() => document.querySelector("#expression-name").textContent === "Bright"
      && document.querySelector('.tool-grid [data-select="Nod"]').getAttribute("aria-pressed") === "true"
      && document.querySelector('[data-action="camera"]').textContent === "Camera · wide shot");
    await page.waitForFunction(() => document.querySelector("#waveform").getAttribute("aria-valuenow") === "100");

    async function exportAs(format, transparent) {
      await page.locator('[data-modal-open="#export-modal"]').click();
      await page.locator(`input[name="format"][value="${format}"]`).check();
      if (format === "video" && transparent !== undefined) {
        await page.locator("#video-transparent").setChecked(transparent);
        assert.equal(await page.locator("#video-format-label").textContent(), transparent ? "WebM" : "MP4");
      }
      const pending = page.waitForEvent("download");
      await page.locator("#export-button").click();
      const result = await pending;
      const data = await readFile(await result.path());
      await page.locator('[data-action="cancel-export"]').click();
      return { data, name: result.suggestedFilename(), path: await result.path() };
    }
    const lax = await exportAs("lax");
    assert.match(lax.name, /\.lax$/);
    assert.match(lax.data.toString(), /<mx:Scene/);
    assert.match(lax.data.toString(), /data:audio\/wav;base64,/);
    assert.match(lax.data.toString(), /<mx:Keyframe/);
    const backup = await exportAs("json");
    const saved = JSON.parse(backup.data).project;
    assert.equal(saved.scenes[0].cues[0].phoneme, "aa");
    assert.equal(saved.characters[0].mouthSettings.aa.width, 145);
    assert.match(saved.scenes[0].audio.src, /^data:audio\/wav;base64,/);
    assert.deepEqual(saved.scenes[0].gestureCues, [{ frame: 0, value: "Clap" }, { frame: 15, value: "Cheer" }, { frame: 24, value: "Nod" }]);
    assert.deepEqual(saved.scenes[0].expressionCues, [{ frame: 15, value: "Focused" }, { frame: 24, value: "Bright" }]);
    assert.deepEqual(saved.scenes[0].cameraCues, [{ frame: 15, value: "medium shot" }, { frame: 24, value: "wide shot" }]);
    assert.equal(saved.scenes[0].detail, "close-up", "camera baseline is preserved");
    await exerciseSvgArtwork(page, exportAs, backup.data);
    for (const gesture of ["Nod", "Shake", "Shrug", "Cheer", "Think", "Clap"]) {
      await page.locator("#project-file").setInputFiles({ name: "gesture.json", mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ project: { ...saved, gesture,
          scenes: saved.scenes.map(s => ({ ...s, gestureCues: [] })) } })) });
      await page.waitForFunction(name => document.querySelector(`.tool-grid [data-select="${name}"]`)?.getAttribute("aria-pressed") === "true", gesture);
    }
    const coreUrl = `${origin}${mount}vendor/ffmpeg/ffmpeg-core.wasm`;
    await context.route(coreUrl, route => {
      missingCoreRequests.add(route.request());
      return route.fulfill({ status: 404, body: "" });
    });
    await page.locator('[data-modal-open="#export-modal"]').click();
    await page.locator('input[name="format"][value="video"]').check();
    await page.locator("#video-transparent").check();
    assert.equal(await page.locator("#download-encoder").isChecked(), false);
    const beforeFailures = downloads.length;
    await page.locator("#export-button").click();
    await page.waitForFunction(() => document.querySelector("#export-status").textContent.includes("encoder is not installed"));
    assert.equal(await page.locator("#export-button").isEnabled(), true, "missing encoder is recoverable");
    assert.equal(downloads.length, beforeFailures, "missing encoder must not produce a fake export");
    await context.unroute(coreUrl);
    await page.evaluate(() => {
      const status = document.querySelector("#export-status");
      const observer = new MutationObserver(() => {
        if (status.textContent.includes("encoding")) {
          observer.disconnect();
          document.querySelector('[data-action="cancel-export"]').click();
        }
      });
      observer.observe(status, { childList: true });
    });
    await page.locator("#export-button").click();
    await page.waitForFunction(() => document.querySelector("#export-status").textContent === "Export cancelled.");
    assert.equal(await page.locator("#export-button").isEnabled(), true, "cancel releases the encoder and allows retry");
    assert.equal(downloads.length, beforeFailures, "cancelled encoding must not download partial media");
    await page.locator('[data-action="cancel-export"]').click();
    const video = await exportAs("video", false);
    assert.match(video.name, /\.mp4$/);
    assert.ok(video.data.length > 1000);
    assert.ok(workers.includes(`${origin}${mount}lib/mp4worker.js`), "video runs the copied local FFmpeg worker");
    assert.ok(requests.includes(`${origin}${mount}vendor/ffmpeg/ffmpeg-core.wasm`), "the copied real WASM encoder was loaded");
    assert.ok(requests.every(url => new URL(url).origin === origin), "no outside-network requests without consent");
    const media = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-count_frames", "-of", "json", video.path], { encoding: "utf8" }));
    const picture = media.streams.find(s => s.codec_type === "video");
    const sound = media.streams.find(s => s.codec_type === "audio");
    assert.deepEqual([picture.codec_name, picture.width, picture.height, picture.r_frame_rate, Number(picture.nb_read_frames)], ["h264", 640, 480, "30/1", 30]);
    assert.equal(sound.codec_name, "aac");
    const audioInVideo = await page.evaluate(async bytes => {
      const ctx = new AudioContext();
      try {
        const audio = await ctx.decodeAudioData(Uint8Array.from(bytes).buffer);
        const samples = audio.getChannelData(0);
        let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        return { duration: audio.duration, peak };
      } finally { await ctx.close(); }
    }, [...video.data]);
    assert.ok(audioInVideo.duration >= 0.9 && audioInVideo.duration < 1.5, "video audio covers the scene duration");
    assert.ok(audioInVideo.peak > 0.1, "exported audio contains the imported voice, not just silence");
    await page.getByRole("button", { name: "Add scene", exact: true }).click();
    assert.equal(await page.locator("#scene-duration").isDisabled(), false);
    assert.match(await page.locator("#studio-status").textContent(), /Import or record/);
    assert.equal(await page.locator("#expression-name").textContent(), "Warm", "new scenes do not inherit another scene's face cues");
    assert.equal(await page.locator('#gesture-track [data-baseline="false"]').count(), 0);
    assert.equal(await page.locator('#camera-track [data-baseline="false"]').count(), 0);
    assert.equal(await page.locator('[data-action="camera"]').textContent(), "Camera · medium shot");
    await page.locator("#scene-duration").fill("0.5");
    await page.locator("#scene-duration").press("Tab");
    await page.getByRole("button", { name: "Add character", exact: true }).click();
    await page.locator("#new-character-name").fill("Nova");
    await page.locator('[data-action="confirm-character"]').click();
    await page.locator("#skin-color").fill("#aabbcc");
    const multiple = await exportAs("lax");
    assert.match(multiple.data.toString(), /id="scene-1"/);
    assert.match(multiple.data.toString(), /#aabbcc/);
    await page.locator("#pace").fill("150");
    const pacedVideo = await exportAs("video", false);
    const pacedMedia = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-count_frames", "-of", "json", pacedVideo.path], { encoding: "utf8" }));
    assert.equal(Number(pacedMedia.streams.find(s => s.codec_type === "video").nb_read_frames), 30, "two paced scenes share exactly one second of video");
    const pacedAudio = execFileSync("ffmpeg", ["-v", "error", "-i", pacedVideo.path, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]);
    const peak = (from, to) => {
      let max = 0;
      for (let i = Math.floor(from * 48000); i < to * 48000; i++) max = Math.max(max, Math.abs(pacedAudio.readFloatLE(i * 4)));
      return max;
    };
    assert.ok(peak(0.1, 0.6) > 0.1, "paced voice is audible in the first scene");
    assert.ok(peak(0.8, 0.98) < 0.01, "the following silent scene is not filled with stretched voice");
    await page.locator("#pace").fill("100");
    await page.locator('[data-scene-index="0"]').click();
    assert.match(await page.locator("#studio-status").textContent(), /speech.wav/);
    assert.equal(await page.locator("#skin-color").inputValue(), "#fce4d6", "character assignment is independent per scene");
    await page.locator(".project-title").fill("Changed title");
    await page.locator("#project-file").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: backup.data });
    await page.waitForFunction(() => document.querySelector(".project-title").value === "Coffee Break");
    await page.locator('#lip-shapes button[data-pose="aa"]').click();
    assert.equal(await page.locator("#lip-width").inputValue(), "145");
    await page.locator('[data-action="record"]').click();
    await page.waitForFunction(() => document.querySelector("#record-button").textContent.includes("Stop"));
    await page.waitForTimeout(300);
    await page.locator('[data-action="record"]').click();
    await page.waitForFunction(() => document.querySelector("#studio-status").textContent.includes("Recorded voice"));
    const recordedBackup = JSON.parse((await exportAs("json")).data).project;
    assert.ok(recordedBackup.scenes[0].cameraCues.every(c => c.frame < recordedBackup.scenes[0].duration * 30), "recording trims camera changes beyond the new audio end");
    const invalidCamera = structuredClone(saved);
    invalidCamera.scenes[0].cameraCues = [{ frame: 0, value: "invalid shot" }];
    await page.locator("#project-file").setInputFiles({ name: "invalid-camera.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(invalidCamera)) });
    await page.waitForFunction(() => document.querySelector("#studio-status").textContent.includes("Invalid cameraCues timeline"));
    const invalidCues = structuredClone(saved);
    invalidCues.scenes[0].gestureCues = [{ frame: 900, value: "Cheer" }];
    await page.locator("#project-file").setInputFiles({ name: "invalid-cues.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(invalidCues)) });
    await page.waitForFunction(() => document.querySelector("#studio-status").textContent.includes("Invalid gestureCues timeline"));
    assert.equal(await page.locator(".project-title").inputValue(), "Coffee Break");
    await page.locator("#project-file").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from('{"title":"invalid"}') });
    await page.waitForFunction(() => document.querySelector("#studio-status").textContent.includes("not a Character Studio project"));
    assert.equal(await page.locator(".project-title").inputValue(), "Coffee Break", "invalid imports preserve the current project");
    assert.deepEqual(errors, []);
    assert.ok(requests.every(url => !/\/(?:editor|shared)\//.test(new URL(url).pathname)),
      "scripts, styles, images, workers, and WASM never request editor or shared folders");
    for (const asset of ["assets/app.css", "assets/littlea-masks.png", "vendor/ffmpeg/ffmpeg-core.js", "vendor/ffmpeg/ffmpeg-core.wasm"]) {
      assert.ok(completedRequests.has(`${origin}${mount}${asset}`), `${asset} finishes loading from the standalone copy`);
    }
    assert.deepEqual(escapedRequests, [], "all requests stay within the isolated character copy and mount");
    assert.deepEqual(failedRequests, [], "all local resources load except the deliberately missing encoder");
  } finally {
    try {
      await browser?.close();
    } finally {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await rm(workspace, { recursive: true, force: true });
    }
  }
});
}
