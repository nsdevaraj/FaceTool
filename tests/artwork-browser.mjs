import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

export async function exerciseSvgArtwork(page, exportAs, original) {
  const modal = page.locator("#artwork-modal");
  const host = page.locator("#artwork-editor");
  const target = page.locator("#artwork-target");
  const fill = () => host.locator('[data-ed$=":fill"]');
  const transparent = () => host.getByRole("button", { name: "Transparent fill", exact: true });
  const apply = () => modal.getByRole("button", { name: "Apply artwork", exact: true }).click();
  const open = () => page.getByRole("button", { name: "Edit SVG artwork", exact: true }).click();
  const point = async (x, y) => {
    const canvas = host.locator('svg[data-ed$=":canvas"]');
    const bounds = await canvas.boundingBox();
    const dimensions = await canvas.evaluate(el => ({ width: el.viewBox.baseVal.width, height: el.viewBox.baseVal.height }));
    return { x: bounds.x + x * bounds.width / dimensions.width, y: bounds.y + y * bounds.height / dimensions.height };
  };

  await page.getByRole("button", { name: "Edit face SVG", exact: true }).click();
  const buttons = await host.locator("button").evaluateAll(elements => elements.filter(el => !el.hidden).map(el => ({
    label: el.getAttribute("aria-label"), tooltip: el.dataset.tooltip,
    icon: Boolean(el.querySelector('svg[aria-hidden="true"] path[d]')), text: el.textContent.trim(),
    width: el.getBoundingClientRect().width,
  })));
  assert.ok(buttons.length > 25);
  for (const button of buttons) {
    assert.ok(button.icon && button.label && button.tooltip === button.label, "each button has a local icon, tooltip and accessible name");
    assert.equal(button.text, "", "toolbar buttons contain icons rather than text substitutes");
    assert.ok(button.width >= 28 && button.width <= 55, "icon controls remain compact");
  }
  const selectTool = host.getByRole("button", { name: "Select/Move (V)", exact: true });
  await selectTool.hover();
  await page.getByRole("tooltip", { name: "Select/Move (V)", exact: true }).waitFor();
  await transparent().focus();
  await page.getByRole("tooltip", { name: "Transparent fill", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("tooltip").count(), 0, "Escape dismisses the tooltip without closing the editor");
  assert.equal(await modal.isVisible(), true);
  assert.ok(Number(await host.locator('rect[stroke="#0099FF"][stroke-dasharray]').first().getAttribute("height")) > 260,
    "face selection bounds include curved geometry for usable resizing");
  await apply();
  assert.equal(await page.locator(".artwork-tooltip").count(), 0, "closing the editor cleans up tooltips");
  assert.equal(JSON.parse((await exportAs("json")).data).project.characters[0].artwork?.face, undefined,
    "opening and applying without edits keeps the generated animated face");
  await page.getByRole("button", { name: "Edit face SVG", exact: true }).click();
  assert.equal(await target.inputValue(), "face");
  assert.equal(await host.locator('[data-ed$=":tool-text"]').isVisible(), false);
  assert.equal(await host.locator('[data-ed$=":tool-gradient"]').isVisible(), false);
  await fill().fill("#ab12cd");
  const from = await point(245, 220), to = await point(260, 225);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await target.selectOption("leftHand");
  await fill().fill("#11aa77");
  await target.selectOption("rightHand");
  await fill().fill("#cc7744");
  await target.selectOption("body");
  await fill().fill("#6655cc");
  await target.selectOption("canvas");
  await fill().fill("#123456");
  await target.selectOption("foreground");
  await fill().fill("#ffaa00");
  await host.getByRole("button", { name: "Rect (R)", exact: true }).click();
  const a = await point(40, 30), b = await point(120, 70);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await host.getByRole("button", { name: "Undo (Ctrl+Z)", exact: true }).click();
  await host.getByRole("button", { name: "Redo (Ctrl+Shift+Z)", exact: true }).click();

  const rows = () => host.locator('[data-ed$=":shapeList"] > [data-sid]');
  await rows().first().click();
  await transparent().click();
  assert.equal(await transparent().getAttribute("aria-pressed"), "true");
  assert.equal(await host.locator('rect[fill="none"][stroke="#5c3a2e"]').count(), 1);
  await transparent().click();
  assert.equal(await transparent().getAttribute("aria-pressed"), "false");
  assert.equal(await fill().inputValue(), "#ffaa00", "turning transparency off restores the fill colour");

  const blank = await point(10, 10);
  await page.mouse.click(blank.x, blank.y);
  await transparent().click();
  await host.getByRole("button", { name: "Rect (R)", exact: true }).click();
  const c = await point(40, 90), d = await point(120, 130);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(d.x, d.y, { steps: 4 });
  await page.mouse.up();
  assert.equal(await transparent().getAttribute("aria-pressed"), "true", "new shapes inherit transparent fill");
  await fill().fill("#445566");
  assert.equal(await transparent().getAttribute("aria-pressed"), "false", "choosing a colour restores solid fill");
  await transparent().click();
  await host.getByRole("button", { name: "Undo (Ctrl+Z)", exact: true }).click();
  await rows().last().click();
  assert.equal(await transparent().getAttribute("aria-pressed"), "false");
  await host.getByRole("button", { name: "Redo (Ctrl+Shift+Z)", exact: true }).click();
  await rows().last().click();
  assert.equal(await transparent().getAttribute("aria-pressed"), "true", "redo restores transparent fill");
  await rows().first().click();
  assert.equal(await transparent().getAttribute("aria-pressed"), "false", "the toggle follows selection");
  await rows().last().click();
  assert.equal(await transparent().getAttribute("aria-pressed"), "true");

  await host.locator('[data-ed$=":importSvgFile"]').setInputFiles({
    name: "unsafe.svg", mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/image.png"/></svg>'),
  });
  await page.waitForFunction(() => /unsupported|not supported|not allowed/i.test(document.querySelector("#artwork-status").textContent));
  await modal.getByRole("button", { name: "Preview edits", exact: true }).click();
  assert.match(await page.locator("#artwork-status").textContent(), /Draft preview updated/);
  const previewPixel = await page.locator("#artwork-preview").evaluate(el => [...el.getContext("2d").getImageData(4, 4, 1, 1).data]);
  assert.deepEqual(previewPixel, [18, 52, 86, 255], "draft preview includes all edited targets");
  const downloading = page.waitForEvent("download");
  await modal.getByRole("button", { name: "Download SVG", exact: true }).click();
  const svgFile = await downloading;
  const drawing = await readFile(await svgFile.path(), "utf8");
  assert.match(drawing, /#ffaa00/, "failed SVG imports preserve the current drawing");
  assert.match(drawing, /fill="none"/, "SVG preserves transparent fill");
  await apply();
  assert.equal(await modal.isVisible(), false);
  const snapshot = await exportAs("json");
  const edited = JSON.parse(snapshot.data).project;
  assert.ok(edited.characters[0].artwork.face.some(part => part.fill === "#ab12cd"));
  assert.ok(edited.characters[0].artwork.body.some(part => part.fill === "#6655cc"));
  assert.equal(edited.characters[0].artwork.leftHand[0].fill, "#11aa77");
  assert.equal(edited.characters[0].artwork.rightHand[0].fill, "#cc7744");
  assert.equal(edited.scenes[0].artwork.canvas[0].fill, "#123456");
  assert.equal(edited.scenes[0].artwork.foreground[0].fill, "#ffaa00");
  assert.equal(edited.scenes[0].artwork.foreground[1].fill, "none");
  assert.equal(edited.scenes[0].artwork.foreground[1].stroke, "#5c3a2e", "transparency preserves the outline");
  assert.match(edited.scenes[0].artwork.foreground[0].d, /^M/);

  await page.reload();
  await page.locator("#lip-shapes button").first().waitFor();
  const restored = JSON.parse((await exportAs("json")).data).project;
  assert.deepEqual(restored.characters[0].artwork, edited.characters[0].artwork);
  assert.deepEqual(restored.scenes[0].artwork, edited.scenes[0].artwork);
  const lax = await exportAs("lax");
  for (const color of ["#ab12cd", "#11aa77", "#cc7744", "#123456", "#ffaa00"]) assert.ok(lax.data.toString().includes(color));
  const wholeSvg = await exportAs("svg");
  assert.match(wholeSvg.name, /\.svg$/);
  assert.match(wholeSvg.data.toString(), /#123456/);
  assert.match(wholeSvg.data.toString(), /#ffaa00/);
  const alphaVideo = await exportAs("video");
  assert.match(alphaVideo.name, /\.webm$/, "the default export uses an alpha-capable format");
  const metadata = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-of", "json", alphaVideo.path], { encoding: "utf8" }));
  const alphaStream = metadata.streams.find(s => s.codec_type === "video");
  assert.equal(alphaStream.codec_name, "vp8");
  assert.equal(Number(alphaStream.nb_read_frames), 30);
  assert.equal(metadata.streams.find(s => s.codec_type === "audio").codec_name, "opus");
  const rgba = execFileSync("ffmpeg", ["-v", "error", "-c:v", "libvpx", "-i", alphaVideo.path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 2 * 1024 * 1024 });
  const alpha = (x, y) => rgba[(y * 640 + x) * 4 + 3];
  assert.equal(alpha(8, 8), 0, "background has real decoded transparency, not black pixels");
  assert.equal(alpha(320, 400), 255, "character remains opaque");
  assert.equal(alpha(60, 40), 255, "foreground artwork remains visible");
  assert.equal(alpha(80, 110), 0, "transparent foreground fill stays clear in the encoded video");
  const audio = execFileSync("ffmpeg", ["-v", "error", "-i", alphaVideo.path, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]);
  let voicePeak = 0;
  for (let i = 0; i + 4 <= audio.length; i += 4) voicePeak = Math.max(voicePeak, Math.abs(audio.readFloatLE(i)));
  assert.ok(voicePeak > 0.1, "transparent WebM retains audible voice");
  const video = await exportAs("video", false);
  const pixels = execFileSync("ffmpeg", ["-v", "error", "-i", video.path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  const pixel = [...pixels.subarray((8 * 640 + 8) * 3, (8 * 640 + 8) * 3 + 3)];
  assert.equal(pixel.length, 3);
  assert.ok(pixel.every((channel, i) => Math.abs(channel - [18, 52, 86][i]) < 12), "real MP4 contains edited canvas pixels");

  await open();
  await target.selectOption("face");
  await modal.getByRole("button", { name: "Reset this artwork", exact: true }).click();
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(JSON.parse((await exportAs("json")).data).project.characters[0].artwork.face, edited.characters[0].artwork.face);
  await open();
  await target.selectOption("face");
  await modal.getByRole("button", { name: "Reset this artwork", exact: true }).click();
  await apply();
  assert.equal(JSON.parse((await exportAs("json")).data).project.characters[0].artwork.face, undefined);

  await open();
  await target.selectOption("foreground");
  await host.locator('[data-ed$=":importSvgFile"]').setInputFiles({
    name: "decoration.svg", mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><path d="M 20 20 L 60 20 L 40 60 Z" fill="#2255aa"/></svg>'),
  });
  await page.waitForFunction(() => Boolean(document.querySelector('#artwork-editor path[fill="#2255aa"]')));
  await apply();
  assert.equal(JSON.parse((await exportAs("json")).data).project.scenes[0].artwork.foreground[0].fill, "#2255aa");

  const invalid = structuredClone(edited);
  invalid.characters[0].artwork.face[0].d = "M NaN 0";
  await page.locator("#project-file").setInputFiles({ name: "invalid-artwork.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(invalid)) });
  await page.waitForFunction(() => /artwork|path/i.test(document.querySelector("#studio-status").textContent));
  assert.equal(JSON.parse((await exportAs("json")).data).project.scenes[0].artwork.foreground[0].fill, "#2255aa", "invalid project artwork does not replace the current project");
  await page.locator("#project-file").setInputFiles({ name: "original.json", mimeType: "application/json", buffer: original });
  await page.waitForFunction(() => document.querySelector("#studio-status").textContent.includes("speech.wav"));
}
