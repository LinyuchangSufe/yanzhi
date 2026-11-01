import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { extractPages, generateAI, generationSchema } from "../src/lib/ai";
import { getStore, KBStore, StoreError } from "../src/lib/db";
import { createBackup, exportAIMarkdown, restoreBackup } from "../src/lib/archive";
import type { Note, Paper } from "../src/lib/types";

// Both extractor and model are explicit transport fixtures. No inference runs,
// credentials, or scientific findings are involved in these boundary checks.
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-selection-ai-"));
  const previous = { ...process.env }, originalFetch = globalThis.fetch;
  const extractor = path.join(root, "fixture extractor.mjs");
  const modeFile = path.join(root, "mode.txt"), callsFile = path.join(root, "calls.jsonl");
  const pagesFile = path.join(root, "pages.json");
  writeFileSync(modeFile, "pages");
  writeFileSync(pagesFile, JSON.stringify(Array.from({ length: 5 }, (_, index) => `EXPLICIT TEST PDF PAGE ${index + 1}`)));
  writeFileSync(extractor, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({args, pid:process.pid}) + '\\n');
const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8');
if (mode === 'error') process.exit(1);
if (mode === 'hang') setInterval(() => {}, 1000);
else {
  const pages = JSON.parse(fs.readFileSync(${JSON.stringify(pagesFile)}, 'utf8'));
  const first = args.includes('-f') ? Number(args[args.indexOf('-f') + 1]) : 1;
  const last = args.includes('-l') ? Number(args[args.indexOf('-l') + 1]) : pages.length;
  if (first > pages.length) process.exit(1);
  process.stdout.write(pages.slice(first - 1, last).join('\\f') + '\\f');
}
`);
  chmodSync(extractor, 0o755);
  process.env.KB_DATA_DIR = root;
  process.env.KB_AI_PROVIDER = "ollama";
  process.env.KB_OLLAMA_URL = "http://127.0.0.1:11434";
  process.env.KB_OLLAMA_MODEL = "explicit-selection-fixture-no-inference";
  process.env.KB_PDFTOTEXT = extractor;
  const store = getStore();
  const paper = store.dispatch("paper.create", {
    title: "EXPLICIT TEST PAPER TITLE",
    abstract: "EXPLICIT TEST ABSTRACT: context disambiguates a selected term.",
  }) as Paper;
  const attachment = store.addAttachment(paper.id, "selected.pdf", Buffer.from("%PDF-1.7\nEXPLICIT EXTRACTOR FIXTURE\n%%EOF"));
  const note = store.dispatch("note.create", { purpose: "idea", title: "Private note", body: "PRIVATE NOTE MUST NOT ENTER MODEL" }) as Note;
  const prompts: string[] = [];
  globalThis.fetch = async (_url, init) => {
    prompts.push(String(init?.body));
    return Response.json({ message: { content: "EXPLICIT TRANSPORT RESULT, NOT MODEL INFERENCE" } });
  };
  return {
    root, store, paper, attachment, note, prompts,
    mode(value: string) { writeFileSync(modeFile, value); },
    pages(value: string[]) { writeFileSync(pagesFile, JSON.stringify(value)); },
    calls(): Array<{ args: string[]; pid: number }> {
      return existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    },
    cleanup() {
      globalThis.fetch = originalFetch;
      store.close();
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const cancelled = (error: unknown) => error instanceof StoreError && error.status === 499;

test("translation reads only the current page while explanation adds neighbouring pages with bounded provenance", async () => {
  const ctx = setup();
  try {
    const beforeNotes = ctx.store.snapshot().notes;
    for (const kind of ["translation", "explanation"] as const) {
      const result = await generateAI({ paperId: ctx.paper.id, kind, selection: "selected technical term", attachmentId: ctx.attachment.id, pageIndex: 2 });
      assert.equal(result.kind, kind);
      assert.equal(result.sourceScope, "selection_context");
      assert.equal(result.sourceAttachmentId, ctx.attachment.id);
      assert.deepEqual(result.sourcePageIndices, kind === "translation" ? [2] : [1, 2, 3]);
      assert.match(result.sourceText, /EXPLICIT TEST PAPER TITLE/);
      assert.match(result.sourceText, /EXPLICIT TEST ABSTRACT/);
      assert.match(result.sourceText, /selected technical term/);
      for (const page of kind === "translation" ? [3] : [2, 3, 4]) assert.match(result.sourceText, new RegExp(`EXPLICIT TEST PDF PAGE ${page}`));
      assert.doesNotMatch(result.sourceText, /EXPLICIT TEST PDF PAGE [15]/);
      if (kind === "translation") assert.doesNotMatch(result.sourceText, /EXPLICIT TEST PDF PAGE [24]/);
    }
    assert.match(ctx.prompts[0], /翻译成中文/);
    assert.match(ctx.prompts[1], /论证作用/);
    assert.doesNotMatch(ctx.prompts.join("\n"), /PRIVATE NOTE/);
    assert.deepEqual(ctx.calls()[0].args.slice(0, 5), ["-layout", "-f", "3", "-l", "3"]);
    assert.deepEqual(ctx.calls()[1].args.slice(0, 5), ["-layout", "-f", "2", "-l", "4"]);
    assert.deepEqual(ctx.store.snapshot().notes, beforeNotes);
  } finally { ctx.cleanup(); }
});

test("quick translation bounds metadata and centres its page excerpt around a literal selection without truncating the selection itself", async () => {
  const ctx = setup();
  try {
    ctx.store.dispatch("paper.update", { id: ctx.paper.id, revision: ctx.paper.revision, abstract: "A".repeat(7000) });
    const selection = "EXPLICIT SELECTED TECHNICAL TERM";
    const page = "P".repeat(4500) + selection + "S".repeat(4500);
    ctx.pages([page]);
    const result = await generateAI({ paperId: ctx.paper.id, kind: "translation", selection, attachmentId: ctx.attachment.id, pageIndex: 0 });
    const abstract = result.sourceText.match(/\[论文摘要[^\]]*\]\n([\s\S]*?)\n\n/)?.[1];
    const excerpt = result.sourceText.match(/\[PDF 上下文[^\]]*\]\n([\s\S]*)/)?.[1];
    assert.ok(abstract && excerpt);
    assert.equal(abstract.length + ctx.paper.title.length, 2000);
    assert.equal(excerpt.length, 3000);
    assert.match(excerpt, /EXPLICIT SELECTED TECHNICAL TERM/);
    assert.ok(excerpt.startsWith("P") && excerpt.endsWith("S"));
    assert.match(result.sourceText, /本页已截取/);
    assert.deepEqual(result.sourcePageIndices, [0]);
    const longSelection = "COMPLETE USER SELECTION ".repeat(200);
    const full = await generateAI({ paperId: ctx.paper.id, kind: "translation", selection: longSelection, attachmentId: ctx.attachment.id, pageIndex: 0 });
    assert.ok(full.sourceText.includes(longSelection), "the independent selected text is never reduced to the context budget");
  } finally { ctx.cleanup(); }
});

test("missing text context falls back explicitly and foreign attachment claims never reach the model", async () => {
  const ctx = setup();
  try {
    ctx.mode("error");
    const unavailable = await generateAI({ paperId: ctx.paper.id, kind: "explanation", selection: "test excerpt", attachmentId: ctx.attachment.id, pageIndex: 99 });
    assert.deepEqual(unavailable.sourcePageIndices, []);
    assert.match(unavailable.sourceText, /PDF 上下文不可用/);
    assert.match(unavailable.sourceText, /不推断全文/);
    const noPage = await generateAI({ paperId: ctx.paper.id, kind: "translation", selection: "test term" });
    assert.equal(noPage.sourceAttachmentId, null);
    assert.deepEqual(noPage.sourcePageIndices, []);
    assert.match(noPage.sourceText, /未读取任何 PDF 页面/);
    rmSync(ctx.store.attachmentPath(ctx.attachment.id));
    const missing = await generateAI({ paperId: ctx.paper.id, kind: "translation", selection: "test term", attachmentId: ctx.attachment.id, pageIndex: 0 });
    assert.deepEqual(missing.sourcePageIndices, []);
    assert.match(missing.sourceText, /附件缺失/);
    const priorCount = ctx.prompts.length;
    const foreignPaper = ctx.store.dispatch("paper.create", { title: "FOREIGN SOURCE" }) as Paper;
    const foreign = ctx.store.addAttachment(foreignPaper.id, "foreign.pdf", Buffer.from("%PDF-1.7\nFOREIGN FIXTURE\n%%EOF"));
    for (const attachmentId of [foreign.id, randomUUID()]) {
      await assert.rejects(generateAI({ paperId: ctx.paper.id, kind: "translation", selection: "test", attachmentId, pageIndex: 0 }), /附件与文献不匹配/);
    }
    await assert.rejects(generateAI({ paperId: ctx.paper.id, kind: "explanation", selection: "  " }), /请先选择/);
    assert.equal(ctx.prompts.length, priorCount);
    assert.equal(generationSchema.safeParse({ paperId: ctx.paper.id, kind: "translation", selection: "test", pageIndex: 0 }).success, false);
    assert.equal(generationSchema.safeParse({ paperId: ctx.paper.id, kind: "translation", selection: "test", injectedContext: "untrusted" }).success, false);
  } finally { ctx.cleanup(); }
});

test("selection page labels stay physical at the first and last page and reject a known out-of-range current page", async () => {
  const ctx = setup();
  try {
    const input = { paperId: ctx.paper.id, kind: "explanation" as const, selection: "test excerpt", attachmentId: ctx.attachment.id };
    assert.deepEqual((await generateAI({ ...input, pageIndex: 0 })).sourcePageIndices, [0, 1]);
    assert.deepEqual((await generateAI({ ...input, pageIndex: 4 })).sourcePageIndices, [3, 4]);
    const before = ctx.prompts.length;
    await assert.rejects(generateAI({ ...input, pageIndex: 5 }), /超出附件页数/);
    assert.equal(ctx.prompts.length, before);
  } finally { ctx.cleanup(); }
});

test("cancel aborts extraction and model transport without deleting saved results or notes", async () => {
  const ctx = setup();
  try {
    await generateAI({ paperId: ctx.paper.id, kind: "translation", selection: "saved first" });
    const before = ctx.store.snapshot();
    const already = new AbortController();
    already.abort();
    await assert.rejects(generateAI({ paperId: ctx.paper.id, kind: "translation", selection: "never started" }, already.signal), cancelled);
    ctx.mode("hang");
    const extraction = new AbortController();
    const pending = extractPages(ctx.store.attachmentPath(ctx.attachment.id), extraction.signal);
    const failure = assert.rejects(pending, cancelled);
    const deadline = Date.now() + 5000;
    while (!ctx.calls().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(ctx.calls().length, "extractor fixture started");
    extraction.abort();
    await failure;
    const pid = ctx.calls().at(-1)!.pid;
    const exitDeadline = Date.now() + 3000;
    let running = true;
    while (running && Date.now() < exitDeadline) {
      try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 10)); }
      catch { running = false; }
    }
    assert.equal(running, false, "cancel terminates the extractor child");
    const model = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    globalThis.fetch = async (_url, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Explicit fixture cancellation", "AbortError"));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const request = generateAI({ paperId: ctx.paper.id, kind: "translation", selection: "cancelled request" }, model.signal);
    const rejected = assert.rejects(request, cancelled);
    await ready;
    model.abort();
    await rejected;
    const late = new AbortController();
    globalThis.fetch = async () => {
      late.abort();
      // A transport may resolve just as the user cancels; never save its result.
      return Response.json({ message: { content: "LATE RESULT MUST NOT SAVE" } });
    };
    await assert.rejects(generateAI({ paperId: ctx.paper.id, kind: "translation", selection: "late response" }, late.signal), cancelled);
    assert.deepEqual(ctx.store.snapshot(), before);
  } finally { ctx.cleanup(); }
});

test("translation and legacy selection results survive backup restore and export separately from personal notes", async () => {
  const ctx = setup();
  let restored: KBStore | undefined;
  try {
    const legacy = ctx.store.saveAI({ paperId: ctx.paper.id, kind: "explanation", body: "LEGACY EXPLICIT FIXTURE", provider: "fixture", model: "none", sourceScope: "selection", sourceAttachmentId: null, sourcePageIndices: [], sourceText: "old selected text", status: "completed" });
    const translation = await generateAI({ paperId: ctx.paper.id, kind: "translation", selection: "new selected text" });
    assert.match(exportAIMarkdown(translation, ctx.store.snapshot()), /^# AI 选段翻译/);
    assert.match(exportAIMarkdown(legacy, ctx.store.snapshot()), /^# AI 选段解释/);
    const report = restoreBackup(createBackup(ctx.store), ctx.root);
    restored = new KBStore(report.restoredDirectory);
    assert.deepEqual(restored.snapshot(), ctx.store.snapshot());
    assert.equal(restored.snapshot().notes.find((note) => note.id === ctx.note.id)?.body, "PRIVATE NOTE MUST NOT ENTER MODEL");
  } finally { restored?.close(); ctx.cleanup(); }
});

test("identical quick translations reuse a completed record, while regeneration and changed source or model run afresh", async () => {
  const ctx = setup();
  try {
    const beforeNotes = ctx.store.snapshot().notes;
    const input = { paperId: ctx.paper.id, kind: "translation" as const, selection: "contextual term",
      attachmentId: ctx.attachment.id, pageIndex: 0 };
    const first = await generateAI(input);
    assert.equal((await generateAI({ ...input })).id, first.id);
    assert.equal(ctx.prompts.length, 1, "an identical request does not invoke the model again");
    assert.equal(ctx.store.snapshot().aiContents.length, 1, "reuse does not append a duplicate result");
    const fresh = await generateAI({ ...input, force: true });
    assert.notEqual(fresh.id, first.id);
    assert.equal((await generateAI(input)).id, fresh.id, "explicit regeneration replaces only the cache index");
    assert.equal(ctx.prompts.length, 2);
    assert.equal(generationSchema.safeParse({ ...input, force: true }).success, true);
    assert.equal(generationSchema.safeParse({ ...input, force: "yes" }).success, false);
    ctx.pages(["CHANGED EXACT PAGE TEXT"]);
    assert.notEqual((await generateAI(input)).id, fresh.id);
    assert.equal(ctx.prompts.length, 3);
    const paper = ctx.store.snapshot().papers.find((item) => item.id === ctx.paper.id)!;
    ctx.store.dispatch("paper.update", { id: paper.id, revision: paper.revision, abstract: "CHANGED METADATA CONTEXT" });
    await generateAI(input); assert.equal(ctx.prompts.length, 4);
    await generateAI({ ...input, pageIndex: 1 }); assert.equal(ctx.prompts.length, 5);
    process.env.KB_OLLAMA_MODEL = "another-explicit-fixture-model";
    await generateAI(input); assert.equal(ctx.prompts.length, 6);
    process.env.KB_OLLAMA_URL = "http://127.0.0.1:11435";
    await generateAI(input); assert.equal(ctx.prompts.length, 7);
    const anotherAttachment = ctx.store.addAttachment(ctx.paper.id, "other-version.pdf", Buffer.from("%PDF-1.7\nANOTHER EXPLICIT SOURCE VERSION\n%%EOF"));
    await generateAI({ ...input, attachmentId: anotherAttachment.id }); assert.equal(ctx.prompts.length, 8);
    await generateAI({ ...input, kind: "explanation" });
    await generateAI({ ...input, kind: "explanation" });
    assert.equal(ctx.prompts.length, 10, "analysis retains fresh generation semantics");
    assert.deepEqual(ctx.store.snapshot().notes, beforeNotes);
    assert.doesNotMatch(ctx.prompts.join("\n"), /PRIVATE NOTE/);
  } finally { ctx.cleanup(); }
});

test("quick-result reuse respects cancellation, deleted records, expiry and trashed papers", async () => {
  const ctx = setup();
  const originalNow = Date.now;
  try {
    const input = { paperId: ctx.paper.id, kind: "translation" as const, selection: "cache lifecycle fixture" };
    const first = await generateAI(input);
    const cancelledRequest = new AbortController(); cancelledRequest.abort();
    await assert.rejects(generateAI(input, cancelledRequest.signal), cancelled);
    assert.equal(ctx.prompts.length, 1);
    ctx.store.db.prepare("DELETE FROM ai_contents WHERE id=?").run(first.id);
    const second = await generateAI(input);
    assert.notEqual(second.id, first.id);
    assert.equal(ctx.prompts.length, 2, "a missing result is never resurrected from cache");
    ctx.store.db.prepare("UPDATE ai_contents SET body=? WHERE id=?").run("CHANGED EXISTING RESPONSE", second.id);
    const changed = await generateAI(input);
    assert.notEqual(changed.id, second.id);
    assert.equal(ctx.prompts.length, 3, "a modified historical result is not returned as the cached completion");
    Date.now = () => originalNow() + 16 * 60 * 1000;
    const expired = await generateAI(input);
    assert.notEqual(expired.id, changed.id);
    assert.equal(ctx.prompts.length, 4);
    Date.now = originalNow;
    const paper = ctx.store.snapshot().papers.find((item) => item.id === ctx.paper.id)!;
    ctx.store.dispatch("paper.trash", { id: paper.id, revision: paper.revision });
    await assert.rejects(generateAI(input), /回收站/);
    assert.equal(ctx.prompts.length, 4);
  } finally { Date.now = originalNow; ctx.cleanup(); }
});
