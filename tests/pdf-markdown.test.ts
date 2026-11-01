import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { generateAI, generationSchema } from "../src/lib/ai";
import { getStore, KBStore, StoreError } from "../src/lib/db";
import { createBackup, exportAIMarkdown, restoreBackup } from "../src/lib/archive";
import { imageCrop, renderPDFImage, validatePNG } from "../src/lib/ai/pdf-image";
import { runCodex } from "../src/lib/ai/codex";
import type { Note, Paper } from "../src/lib/types";

// Explicit renderer/CLI/HTTP boundary fixtures. These are NOT model results.
function png(width: number, height: number): Buffer {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind: string, bytes: Buffer) => {
    const type = Buffer.from(kind), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8;
  const pixels = Buffer.alloc((width + 1) * height, 255);
  for (let row = 0; row < height; row++) pixels[row * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-pdf-markdown-"));
  const previous = { ...process.env }, originalFetch = globalThis.fetch;
  const callsFile = path.join(root, "calls.jsonl"), modeFile = path.join(root, "mode.txt");
  const info = path.join(root, "fixture pdfinfo.mjs"), render = path.join(root, "fixture pdftoppm.mjs");
  const imageFile = path.join(root, "source.png");
  writeFileSync(modeFile, "ready"); writeFileSync(imageFile, png(800, 600));
  writeFileSync(info, `#!${process.execPath}
const page = process.argv.includes('-f') ? Number(process.argv[process.argv.indexOf('-f') + 1]) : 1;
process.stdout.write('Pages: 3\\nPage ' + page + ' rot: ' + (page === 3 ? 90 : 0) + '\\n');
`);
  writeFileSync(render, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({args,pid:process.pid,cwd:process.cwd()}) + '\\n');
if (fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8') === 'hang') setInterval(() => {}, 1000);
else fs.copyFileSync(${JSON.stringify(imageFile)}, args.at(-1) + '.png');
`);
  chmodSync(info, 0o700); chmodSync(render, 0o700);
  process.env.KB_DATA_DIR = root; process.env.KB_AI_PROVIDER = "ollama";
  process.env.KB_OLLAMA_URL = "http://127.0.0.1:11434";
  process.env.KB_OLLAMA_MODEL = "explicit-vision-fixture-not-inference";
  process.env.KB_PDFINFO = info; process.env.KB_PDFTOPPM = render;
  const store = getStore();
  const paper = store.dispatch("paper.create", { title: "EXPLICIT PDF IMAGE FIXTURE" }) as Paper;
  const attachment = store.addAttachment(paper.id, "fixture.pdf", Buffer.from("%PDF-1.7\nEXPLICIT RENDERER BOUNDARY FIXTURE\n%%EOF"));
  const note = store.dispatch("note.create", { purpose: "idea", title: "Private draft", body: "PRIVATE ORIGINAL NEVER SENT OR MODIFIED" }) as Note;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const message = "```markdown\nEXPLICIT TRANSCRIPTION FIXTURE\n\n$x_t$\n\n$$\nx_{t+1} = x_t - \\eta \\nabla f(x_t)\n$$\n```";
    return Response.json(process.env.KB_AI_PROVIDER === "ollama" ? { message: { content: message } } : { choices: [{ message: { content: message } }] });
  };
  return { root, store, paper, attachment, note, requests, imageFile, callsFile,
    mode(value: string) { writeFileSync(modeFile, value); },
    calls(): Array<{ args: string[]; pid: number; cwd: string }> {
      return existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    },
    cleanup() {
      globalThis.fetch = originalFetch; store.close();
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous); rmSync(root, { recursive: true, force: true });
    },
  };
}
const cancelled = (error: unknown) => error instanceof StoreError && error.status === 499;

test("PDF markdown sends visual selection through Ollama and compatible API, preserves LaTeX and immutable notes", async () => {
  const ctx = setup();
  try {
    const originalNotes = ctx.store.snapshot().notes;
    const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    const selected = await generateAI({ paperId: ctx.paper.id, kind: "markdown", attachmentId: ctx.attachment.id,
      pageIndex: 2, selection: "unreliable x? formula", rects: [rect] });
    assert.equal(selected.sourceScope, "selection_image");
    assert.equal(selected.sourceAttachmentId, ctx.attachment.id);
    assert.deepEqual(selected.sourcePageIndices, [2]);
    assert.match(selected.sourceText, /PDF 内置旋转：90°/);
    assert.match(selected.sourceText, /外接矩形/);
    assert.match(selected.sourceText, /不是原始 LaTeX 源码/);
    assert.match(selected.body, /\$x_t\$/);
    assert.match(selected.body, /\$\$\nx_\{t\+1\} = x_t - \\eta \\nabla f\(x_t\)\n\$\$/);
    assert.doesNotMatch(selected.body, /^```/);
    const messages = ctx.requests[0].body.messages as Array<{ content: string; images?: string[] }>;
    assert.match(messages[1].content, /不翻译、不分析/);
    assert.doesNotMatch(JSON.stringify(ctx.requests), /PRIVATE ORIGINAL/);
    assert.deepEqual(Buffer.from(messages[1].images![0], "base64"), readFileSync(ctx.imageFile));
    const renderArgs = ctx.calls();
    assert.equal(renderArgs.length, 2);
    assert.deepEqual(renderArgs[0].args.slice(0, 5), ["-f", "3", "-l", "3", "-singlefile"]);
    const crop = imageCrop([rect], 90, 800, 600);
    assert.deepEqual(renderArgs[1].args.slice(renderArgs[1].args.indexOf("-x"), -2), [
      "-x", String(crop.x), "-y", String(crop.y), "-W", String(crop.width), "-H", String(crop.height),
    ]);
    assert.equal(existsSync(path.dirname(renderArgs[0].args.at(-1)!)), false, "temporary images are removed after dispatch");
    process.env.KB_AI_PROVIDER = "openai-compatible";
    process.env.KB_OPENAI_URL = "https://fixture.invalid/v1";
    process.env.KB_OPENAI_MODEL = "explicit-compatible-vision-fixture";
    const page = await generateAI({ paperId: ctx.paper.id, kind: "markdown", attachmentId: ctx.attachment.id, pageIndex: 0 });
    assert.equal(page.sourceScope, "page_image"); assert.deepEqual(page.sourcePageIndices, [0]);
    const compatible = ctx.requests[1].body.messages as Array<{ content: unknown }>;
    assert.deepEqual((compatible[1].content as Array<Record<string, unknown>>)[1], {
      type: "image_url", image_url: { url: `data:image/png;base64,${readFileSync(ctx.imageFile).toString("base64")}` },
    });
    assert.deepEqual(ctx.store.snapshot().notes, originalNotes);
    assert.match(exportAIMarkdown(page, ctx.store.snapshot()), /^# PDF Markdown 与 LaTeX 识别/);
    const report = restoreBackup(createBackup(ctx.store), ctx.root);
    const restored = new KBStore(report.restoredDirectory);
    try { assert.deepEqual(restored.snapshot(), ctx.store.snapshot()); } finally { restored.close(); }
  } finally { ctx.cleanup(); }
});

test("visual generation validates concrete source, page range, normalized crops and unavailable vision without guessing from text", async () => {
  const ctx = setup();
  try {
    const base = { paperId: ctx.paper.id, kind: "markdown" as const, attachmentId: ctx.attachment.id, pageIndex: 0 };
    for (const invalid of [
      { ...base, attachmentId: undefined }, { ...base, pageIndex: undefined }, { ...base, pageIndex: -1 },
      { ...base, rects: [] }, { ...base, rects: [{ x: 0.8, y: 0.1, width: 0.3, height: 0.1 }] },
      { ...base, rects: [{ x: 0, y: 0, width: 0, height: 1 }] },
      { ...base, rects: Array.from({ length: 501 }, () => ({ x: 0, y: 0, width: 1, height: 1 })) },
    ]) assert.equal(generationSchema.safeParse(invalid).success, false);
    assert.equal(generationSchema.safeParse(base).success, true);
    const other = ctx.store.dispatch("paper.create", { title: "FOREIGN SOURCE" }) as Paper;
    await assert.rejects(generateAI({ ...base, paperId: other.id }), /附件与文献不匹配/);
    await assert.rejects(generateAI({ ...base, pageIndex: 3 }), (error: unknown) => error instanceof StoreError && error.status === 400);
    assert.equal(ctx.requests.length, 0);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("image input unsupported", { status: 400 }); };
    await assert.rejects(generateAI(base), /支持图像输入/);
    assert.equal(calls, 1, "a vision error does not trigger text-only retry");
    assert.equal(ctx.store.snapshot().aiContents.length, 0);
    process.env.KB_PDFTOPPM = path.join(ctx.root, "missing-renderer");
    await assert.rejects(generateAI(base), /未改用纯文本猜测公式/);
    assert.equal(calls, 1);
  } finally { ctx.cleanup(); }
});

test("Markdown reuse matches exact page, crop and image bytes and explicit regeneration still makes a new request", async () => {
  const ctx = setup();
  try {
    const notes = ctx.store.snapshot().notes;
    const input = { paperId: ctx.paper.id, kind: "markdown" as const,
      attachmentId: ctx.attachment.id, pageIndex: 0,
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }] };
    const first = await generateAI(input);
    assert.equal((await generateAI(input)).id, first.id);
    assert.equal(ctx.requests.length, 1);
    assert.equal(ctx.store.snapshot().aiContents.length, 1);
    const fresh = await generateAI({ ...input, force: true });
    assert.notEqual(fresh.id, first.id);
    assert.equal(ctx.requests.length, 2);
    assert.equal((await generateAI(input)).id, fresh.id);
    await generateAI({ ...input, pageIndex: 1 }); assert.equal(ctx.requests.length, 3);
    await generateAI({ ...input, rects: [{ ...input.rects[0], width: 0.4 }] }); assert.equal(ctx.requests.length, 4);
    writeFileSync(ctx.imageFile, png(799, 600));
    const changedImage = await generateAI(input);
    assert.notEqual(changedImage.id, fresh.id);
    assert.equal(ctx.requests.length, 5, "changed pixels cannot reuse a former transcription");
    const beforeCancellation = ctx.store.snapshot();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(generateAI(input, controller.signal), cancelled);
    assert.deepEqual(ctx.store.snapshot(), beforeCancellation);
    assert.deepEqual(ctx.store.snapshot().notes, notes);
  } finally { ctx.cleanup(); }
});

test("selection cropping maps all intrinsic rotations from bottom-left CropBox coordinates with a small symbol margin", () => {
  const rect = { x: 0.125, y: 0.25, width: 0.25, height: 0.375 };
  assert.deepEqual(imageCrop([rect], 0, 1000, 1000), { x: 117, y: 367, width: 266, height: 391 });
  assert.deepEqual(imageCrop([rect], 90, 1000, 1000), { x: 242, y: 117, width: 391, height: 266 });
  assert.deepEqual(imageCrop([rect], 180, 1000, 1000), { x: 617, y: 242, width: 266, height: 391 });
  assert.deepEqual(imageCrop([rect], 270, 1000, 1000), { x: 367, y: 617, width: 391, height: 266 });
  assert.deepEqual(imageCrop([{ x: 0, y: 0, width: 1, height: 1 }], -90, 800, 600), { x: 0, y: 0, width: 800, height: 600 });
  assert.throws(() => validatePNG(Buffer.from("not an image")), /图像格式/);
  const oversized = png(3000, 1); assert.throws(() => validatePNG(oversized), /尺寸/);
});

test("cancel stops the renderer child and late model completion never saves markdown or changes notes", async () => {
  const ctx = setup();
  try {
    const before = ctx.store.snapshot();
    ctx.mode("hang");
    const controller = new AbortController();
    const pending = renderPDFImage({ file: ctx.store.attachmentPath(ctx.attachment.id), pageIndex: 0, signal: controller.signal });
    const rejected = assert.rejects(pending, cancelled);
    const deadline = Date.now() + 5000;
    while (!ctx.calls().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const call = ctx.calls()[0]; assert.ok(call, "renderer fixture started");
    controller.abort(); await rejected;
    let running = true;
    const exitDeadline = Date.now() + 3000;
    while (running && Date.now() < exitDeadline) {
      try { process.kill(call.pid, 0); await new Promise((resolve) => setTimeout(resolve, 10)); }
      catch { running = false; }
    }
    assert.equal(running, false, "render process was stopped");
    assert.equal(existsSync(path.dirname(call.args.at(-1)!)), false);
    ctx.mode("ready");
    const late = new AbortController();
    globalThis.fetch = async () => { late.abort(); return Response.json({ message: { content: "LATE UNSAVED RESULT" } }); };
    await assert.rejects(generateAI({ paperId: ctx.paper.id, kind: "markdown", attachmentId: ctx.attachment.id, pageIndex: 0 }, late.signal), cancelled);
    assert.deepEqual(ctx.store.snapshot(), before);
  } finally { ctx.cleanup(); }
});

test("Codex accepts only validated temporary PNG attachments without enabling tools and removes them after the invocation", async () => {
  const ctx = setup();
  try {
    const executable = path.join(ctx.root, "fixture codex.mjs"), log = path.join(ctx.root, "codex-call.json");
    writeFileSync(executable, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), images = args.flatMap((value,index) => value === '--image' ? [args[index + 1]] : []);
let prompt = ''; for await (const part of process.stdin) prompt += part;
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({args,prompt,images:images.map(file => ({file,bytes:fs.readFileSync(file).toString('base64'),mode:fs.statSync(file).mode & 511}))}));
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'EXPLICIT CODEX TRANSCRIPTION $x^2$'}}) + '\\n');
process.stdout.write(JSON.stringify({type:'turn.completed'}) + '\\n');
`);
    chmodSync(executable, 0o700); process.env.KB_CODEX_BIN = executable;
    const image = readFileSync(ctx.imageFile);
    const result = await runCodex({ prompt: "EXPLICIT TRANSCRIPTION PROMPT", summary: false, images: [image] });
    assert.match(result.text, /\$x\^2\$/);
    const call = JSON.parse(readFileSync(log, "utf8")) as { args: string[]; prompt: string; images: Array<{ file: string; bytes: string; mode: number }> };
    assert.equal(call.prompt, "EXPLICIT TRANSCRIPTION PROMPT");
    assert.equal(call.args.at(-1), "-"); assert.ok(call.args.indexOf("--image") < call.args.length - 1);
    for (const flag of ["features.shell_tool=false", "features.apps=false", "features.plugins=false", "features.image_generation=false"])
      assert.ok(call.args.includes(flag));
    assert.equal(call.images[0].bytes, image.toString("base64"));
    assert.equal(call.images[0].mode, 0o600); assert.equal(existsSync(call.images[0].file), false);
    await assert.rejects(runCodex({ prompt: "invalid image", summary: false, images: [Buffer.from("fake")] }), /图像格式/);
  } finally { ctx.cleanup(); }
});

const popplerAvailable = ["pdfinfo", "pdftoppm"].every((command) =>
  spawnSync(command, ["-v"], { timeout: 5000, stdio: "ignore" }).status === 0);
test("real Poppler renders the exact rotated fixture page and clips the expected synthetic formula region", {
  skip: !popplerAvailable && "pdfinfo/pdftoppm are not installed",
}, async () => {
  const previousInfo = process.env.KB_PDFINFO, previousRenderer = process.env.KB_PDFTOPPM;
  delete process.env.KB_PDFINFO; delete process.env.KB_PDFTOPPM;
  const file = path.resolve("tests/fixtures/reading-fixture.pdf");
  const fingerprint = () => createHash("sha256").update(readFileSync(file)).digest("hex");
  const before = fingerprint();
  try {
    const page = await renderPDFImage({ file, pageIndex: 2 });
    assert.equal(page.rotation, 90);
    assert.deepEqual(validatePNG(page.bytes), { width: 2600, height: 1950 });
    const selected = await renderPDFImage({ file, pageIndex: 2,
      rects: [{ x: 70 / 600, y: 350 / 800, width: 460 / 600, height: 120 / 800 }] });
    assert.equal(selected.rotation, 90);
    assert.deepEqual(selected.crop, { x: 1129, y: 219, width: 407, height: 1512 });
    assert.deepEqual(validatePNG(selected.bytes), { width: 407, height: 1512 });
    assert.equal(fingerprint(), before, "rendering never changes the original PDF");
  } finally {
    if (previousInfo === undefined) delete process.env.KB_PDFINFO; else process.env.KB_PDFINFO = previousInfo;
    if (previousRenderer === undefined) delete process.env.KB_PDFTOPPM; else process.env.KB_PDFTOPPM = previousRenderer;
  }
});
