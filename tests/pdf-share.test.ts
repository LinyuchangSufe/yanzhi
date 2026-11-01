import { test } from "node:test";
import assert from "node:assert/strict";
import {
  linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { KBStore, StoreError } from "../src/lib/db";
import { pdfShareFilename, preparePDFShare } from "../src/lib/pdf-share";
import { folderOpenCommand, openPDFShareFolder } from "../src/lib/pdf-share-open";
import type { Paper } from "../src/lib/types";

// These are original storage fixtures, never real research PDFs or model output.
const pdf = (name: string) => Buffer.from(`%PDF-1.7\nTEST ${name}\n%%EOF`);
function setup() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "kb-pdf-share-test-")));
  const dir = path.join(root, "data");
  const store = new KBStore(dir);
  return { root, dir, store, cleanup() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function paper(store: KBStore, fields: Partial<Paper> = {}) {
  return store.dispatch("paper.create", {
    title: "TEST 文献标题", authors: ["张三", "李四"], year: 2026, ...fields,
  }) as Paper;
}
const status = (expected: number) => (error: unknown) =>
  error instanceof StoreError && error.status === expected;

test("sharing names preserve readable Unicode, remove paths and controls, and bound UTF-8 bytes", () => {
  const filename = pdfShareFilename(
    { year: 2026, authors: ["张三/John\\Smith"], title: 'A../B: C? D*\nE\u0000\u202e题名' },
    { filename: "irrelevant-gibberish.pdf" },
  );
  assert.match(filename, /^2026 - 张三 John Smith - A\.\. B C D E 题名\.pdf$/);
  assert.doesNotMatch(filename, /[/\\:\u0000-\u001f\u202e]/u);
  const long = pdfShareFilename(
    { year: null, authors: ["作者😀".repeat(100)], title: "题名😀".repeat(200) },
    { filename: "附录😀".repeat(100) + ".pdf" }, 1, 2,
  );
  assert.ok(Buffer.byteLength(long) <= 220);
  assert.match(long, /^年份未知 - 作者😀/);
  assert.match(long, / - 附件 02 - 附录😀/);
  assert.equal(long, Buffer.from(long).toString("utf8"));
  assert.doesNotMatch(long, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
  assert.equal(pdfShareFilename({ year: null, authors: [], title: "\n/" }, { filename: "x.pdf" }), "年份未知 - 作者未知 - 未命名文献.pdf");
});

test("sharing creates independent readable PDF copies and leaves all state, Markdown and source bytes untouched", () => {
  const ctx = setup();
  try {
    const current = paper(ctx.store);
    const attachment = ctx.store.addAttachment(current.id, "garbled-123.pdf", pdf("main"));
    const note = ctx.store.snapshot().notes[0];
    ctx.store.dispatch("note.update", { id: note.id, revision: note.revision, body: "PRIVATE personal Markdown $x^2$" });
    const before = ctx.store.snapshot();
    const markdown = readFileSync(path.join(ctx.dir, "notes", `${note.id}.md`));
    const sourcePath = ctx.store.attachmentPath(attachment.id);
    const source = readFileSync(sourcePath);
    const result = preparePDFShare(ctx.store, current.id);
    assert.equal(result.directory, path.join(ctx.dir, "share", "papers"));
    assert.equal(result.opened, false);
    assert.equal(result.missingCount, 0);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].filename, "2026 - 张三 - TEST 文献标题.pdf");
    assert.deepEqual(readFileSync(result.files[0].path), source);
    assert.notEqual(lstatSync(result.files[0].path).ino, lstatSync(sourcePath).ino);
    assert.equal(lstatSync(result.files[0].path).mode & 0o777, 0o600);
    assert.deepEqual(ctx.store.snapshot(), before);
    assert.deepEqual(readFileSync(sourcePath), source);
    assert.deepEqual(readFileSync(path.join(ctx.dir, "notes", `${note.id}.md`)), markdown);
    assert.deepEqual(readdirSync(result.directory), [result.files[0].filename]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|personal Markdown/);
  } finally { ctx.cleanup(); }
});

test("multiple attachments retain deterministic explicit attachment names and repeat actions reuse identical files", () => {
  const ctx = setup();
  try {
    const current = paper(ctx.store);
    ctx.store.addAttachment(current.id, "正文.pdf", pdf("main"));
    ctx.store.addAttachment(current.id, "supplement.pdf", pdf("supplement"));
    const first = preparePDFShare(ctx.store, current.id);
    assert.equal(first.files.length, 2);
    assert.ok(first.files.some((file) => /附件 \d{2} - 正文\.pdf$/.test(file.filename)));
    assert.ok(first.files.some((file) => /附件 \d{2} - supplement\.pdf$/.test(file.filename)));
    const stats = first.files.map((file) => lstatSync(file.path));
    const repeated = preparePDFShare(ctx.store, current.id);
    assert.deepEqual(repeated, first);
    assert.deepEqual(repeated.files.map((file) => lstatSync(file.path).ino), stats.map((stat) => stat.ino));
    assert.equal(readdirSync(first.directory).length, 2);
  } finally { ctx.cleanup(); }
});

test("same metadata with different PDF bytes receives a suffix without overwriting another copy", () => {
  const ctx = setup();
  try {
    const first = paper(ctx.store);
    const second = paper(ctx.store);
    ctx.store.addAttachment(first.id, "a.pdf", pdf("first"));
    ctx.store.addAttachment(second.id, "b.pdf", pdf("second"));
    const exportedFirst = preparePDFShare(ctx.store, first.id).files[0];
    const exportedSecond = preparePDFShare(ctx.store, second.id).files[0];
    assert.notEqual(exportedFirst.path, exportedSecond.path);
    assert.match(exportedSecond.filename, / - [a-f0-9]{10}\.pdf$/);
    assert.deepEqual(readFileSync(exportedFirst.path), pdf("first"));
    assert.deepEqual(readFileSync(exportedSecond.path), pdf("second"));
    assert.equal(preparePDFShare(ctx.store, second.id).files[0].path, exportedSecond.path);
  } finally { ctx.cleanup(); }
});

test("a user's existing different copy is never overwritten and identical bytes can be reused", () => {
  const ctx = setup();
  try {
    const current = paper(ctx.store);
    const attachment = ctx.store.addAttachment(current.id, "a.pdf", pdf("source"));
    const directory = path.join(ctx.dir, "share", "papers");
    mkdirSync(directory, { recursive: true });
    const name = pdfShareFilename(current, attachment);
    const existingPath = path.join(directory, name);
    writeFileSync(existingPath, pdf("user modified"));
    const result = preparePDFShare(ctx.store, current.id);
    assert.notEqual(result.files[0].path, existingPath);
    assert.deepEqual(readFileSync(existingPath), pdf("user modified"));
    assert.deepEqual(readFileSync(result.files[0].path), pdf("source"));
  } finally { ctx.cleanup(); }
});

test("whole-library preparation excludes recycled papers, counts papers without usable PDFs and warns about partial missing attachments", () => {
  const ctx = setup();
  try {
    const withPDF = paper(ctx.store);
    ctx.store.addAttachment(withPDF.id, "main.pdf", pdf("main"));
    const missingSupplement = ctx.store.addAttachment(withPDF.id, "supplement.pdf", pdf("missing supplement"));
    unlinkSync(ctx.store.attachmentPath(missingSupplement.id));
    const noPDF = paper(ctx.store);
    const missingPDF = paper(ctx.store);
    const missing = ctx.store.addAttachment(missingPDF.id, "missing.pdf", pdf("missing all"));
    unlinkSync(ctx.store.attachmentPath(missing.id));
    const recycled = paper(ctx.store);
    ctx.store.addAttachment(recycled.id, "recycled.pdf", pdf("recycled"));
    ctx.store.dispatch("paper.trash", { id: recycled.id, revision: recycled.revision });
    const result = preparePDFShare(ctx.store);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].paperId, withPDF.id);
    assert.equal(result.missingCount, 2);
    assert.match(result.warning ?? "", /2 个 PDF 附件/);
    assert.equal(preparePDFShare(ctx.store, noPDF.id).missingCount, 1);
    assert.throws(() => preparePDFShare(ctx.store, recycled.id), status(409));
    assert.throws(() => preparePDFShare(ctx.store, randomUUID()), status(404));
  } finally { ctx.cleanup(); }
});

test("changed PDF fingerprints are rejected before a misleading share copy is created", () => {
  const ctx = setup();
  try {
    const current = paper(ctx.store);
    const attachment = ctx.store.addAttachment(current.id, "main.pdf", pdf("original"));
    writeFileSync(ctx.store.attachmentPath(attachment.id), pdf("changed externally"));
    const before = ctx.store.snapshot();
    assert.throws(() => preparePDFShare(ctx.store, current.id), status(409));
    assert.deepEqual(ctx.store.snapshot(), before);
    assert.deepEqual(readdirSync(path.join(ctx.dir, "share", "papers")), []);
  } finally { ctx.cleanup(); }
});

test("a source PDF symbolic link is rejected even when it points to identical bytes", () => {
  const ctx = setup();
  try {
    const current = paper(ctx.store);
    const attachment = ctx.store.addAttachment(current.id, "main.pdf", pdf("original"));
    const original = ctx.store.attachmentPath(attachment.id);
    const outside = path.join(ctx.root, "outside.pdf");
    renameSync(original, outside);
    symlinkSync(outside, original);
    assert.throws(() => preparePDFShare(ctx.store, current.id), status(409));
    assert.deepEqual(readFileSync(outside), pdf("original"));
  } finally { ctx.cleanup(); }
});

test("an attachments directory symbolic link outside dataDir is rejected", () => {
  const ctx = setup();
  try {
    const current = paper(ctx.store);
    ctx.store.addAttachment(current.id, "main.pdf", pdf("original"));
    const outside = path.join(ctx.root, "outside-attachments");
    renameSync(path.join(ctx.dir, "attachments"), outside);
    symlinkSync(outside, path.join(ctx.dir, "attachments"), "dir");
    assert.throws(() => preparePDFShare(ctx.store, current.id), status(409));
    assert.equal(readdirSync(outside).length, 1);
  } finally { ctx.cleanup(); }
});

test("share and papers directory symbolic links never receive exported files", () => {
  for (const entry of ["share", "papers"]) {
    const ctx = setup();
    try {
      const current = paper(ctx.store);
      ctx.store.addAttachment(current.id, "main.pdf", pdf("original"));
      const outside = path.join(ctx.root, "outside");
      mkdirSync(outside);
      const link = entry === "share" ? path.join(ctx.dir, "share") : path.join(ctx.dir, "share", "papers");
      if (entry === "papers") mkdirSync(path.dirname(link));
      symlinkSync(outside, link, "dir");
      assert.throws(() => preparePDFShare(ctx.store, current.id), status(409));
      assert.deepEqual(readdirSync(outside), []);
    } finally { ctx.cleanup(); }
  }
});

test("an existing output symbolic link is rejected rather than reused or overwritten", () => {
  const ctx = setup();
  try {
    const current = paper(ctx.store);
    const attachment = ctx.store.addAttachment(current.id, "main.pdf", pdf("original"));
    const directory = path.join(ctx.dir, "share", "papers");
    mkdirSync(directory, { recursive: true });
    const outside = path.join(ctx.root, "outside.pdf");
    writeFileSync(outside, pdf("original"));
    symlinkSync(outside, path.join(directory, pdfShareFilename(current, attachment)));
    assert.throws(() => preparePDFShare(ctx.store, current.id), status(409));
    assert.deepEqual(readFileSync(outside), pdf("original"));
  } finally { ctx.cleanup(); }
});

test("an existing share hard link cannot be reused as an independently editable copy", () => {
  const ctx = setup();
  try {
    const current = paper(ctx.store);
    const attachment = ctx.store.addAttachment(current.id, "main.pdf", pdf("original"));
    const directory = path.join(ctx.dir, "share", "papers");
    mkdirSync(directory, { recursive: true });
    const original = ctx.store.attachmentPath(attachment.id);
    linkSync(original, path.join(directory, pdfShareFilename(current, attachment)));
    const result = preparePDFShare(ctx.store, current.id);
    assert.match(result.files[0].filename, / - [a-f0-9]{10}\.pdf$/);
    assert.notEqual(lstatSync(result.files[0].path).ino, lstatSync(original).ino);
    assert.deepEqual(readFileSync(original), pdf("original"));
  } finally { ctx.cleanup(); }
});

test("an attachment record cannot redirect sharing to an arbitrary file outside attachments", () => {
  const ctx = setup();
  try {
    const current = paper(ctx.store);
    const attachment = ctx.store.addAttachment(current.id, "main.pdf", pdf("original"));
    const outside = path.join(ctx.root, "outside.pdf");
    writeFileSync(outside, pdf("original"));
    ctx.store.db.prepare("UPDATE attachments SET relative_path=? WHERE id=?").run("../outside.pdf", attachment.id);
    assert.throws(() => preparePDFShare(ctx.store, current.id), status(409));
    assert.deepEqual(readFileSync(outside), pdf("original"));
  } finally { ctx.cleanup(); }
});

test("opening uses only a fixed platform executable and a single literal directory argument", async () => {
  const ctx = setup();
  try {
    const result = preparePDFShare(ctx.store);
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const opened = await openPDFShareFolder(result, { platform: "darwin", runner: async (command, args) => { calls.push({ command, args }); } });
    assert.equal(opened.opened, true);
    assert.deepEqual(calls, [{ command: "/usr/bin/open", args: [result.directory] }]);
    assert.deepEqual(folderOpenCommand(result.directory, "linux"), { command: "xdg-open", args: [result.directory] });
    assert.deepEqual(folderOpenCommand(result.directory, "win32"), { command: "explorer.exe", args: [result.directory] });
    assert.equal(folderOpenCommand(result.directory, "aix"), null);
    assert.equal(result.opened, false);
  } finally { ctx.cleanup(); }
});

test("folder opening failures retain prepared files and return an honest actionable warning", async () => {
  const ctx = setup();
  try {
    const current = paper(ctx.store);
    ctx.store.addAttachment(current.id, "main.pdf", pdf("original"));
    const prepared = preparePDFShare(ctx.store, current.id);
    const failed = await openPDFShareFolder(prepared, { runner: async () => { throw new Error("synthetic desktop unavailable"); } });
    assert.equal(failed.opened, false);
    assert.equal(failed.directory, prepared.directory);
    assert.deepEqual(failed.files, prepared.files);
    assert.match(failed.warning ?? "", /未能自动打开文件夹/);
    assert.deepEqual(readFileSync(failed.files[0].path), pdf("original"));
    let invoked = false;
    const unsafe = await openPDFShareFolder({ ...prepared, directory: ctx.root }, { runner: async () => { invoked = true; } });
    assert.equal(invoked, false);
    assert.equal(unsafe.opened, false);
  } finally { ctx.cleanup(); }
});

test("single-paper reveal selects only a verified share copy using fixed macOS arguments", async () => {
  const ctx = setup();
  try {
    const current = paper(ctx.store);
    ctx.store.addAttachment(current.id, "main.pdf", pdf("original"));
    const result = preparePDFShare(ctx.store, current.id);
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner = async (command: string, args: readonly string[]) => { calls.push({ command, args }); };
    assert.equal((await openPDFShareFolder(result, { platform: "darwin", reveal: true, runner })).opened, true);
    assert.deepEqual(calls, [{ command: "/usr/bin/open", args: ["-R", result.files[0].path] }]);
    calls.length = 0;
    assert.equal((await openPDFShareFolder(result, { platform: "linux", reveal: true, runner })).opened, true);
    assert.deepEqual(calls, [{ command: "xdg-open", args: [result.directory] }]);
    calls.length = 0;
    const unsafe = { ...result, files: [{ ...result.files[0], path: ctx.store.attachmentPath(result.files[0].attachmentId) }] };
    assert.equal((await openPDFShareFolder(unsafe, { platform: "darwin", reveal: true, runner })).opened, false);
    assert.equal(calls.length, 0);
    unlinkSync(result.files[0].path);
    symlinkSync(ctx.store.attachmentPath(result.files[0].attachmentId), result.files[0].path);
    assert.equal((await openPDFShareFolder(result, { platform: "darwin", reveal: true, runner })).opened, false);
    assert.equal(calls.length, 0);
  } finally { ctx.cleanup(); }
});
