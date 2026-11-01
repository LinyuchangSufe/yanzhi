import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getStore, StoreError } from "../src/lib/db";
import { guideAction, guideActionSchema, guideJobs } from "../src/lib/guide/engine";
import { readGuideSources, splitGuideChunks, type SourceBlock } from "../src/lib/guide/sources";
import type { GuideEvidence, GuideJob } from "../src/lib/guide/types";
import type { Attachment, Paper } from "../src/lib/types";

// All model responses below are explicit transport fixtures, not research
// findings or real inference. Quotes are copied from the actual PDF.js blocks.
const fixture = readFileSync(path.resolve("tests/fixtures/reading-fixture.pdf"));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-guide-engine-"));
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  process.env.KB_DATA_DIR = root;
  process.env.KB_AI_PROVIDER = "ollama";
  process.env.KB_OLLAMA_URL = "http://127.0.0.1:11434";
  process.env.KB_OLLAMA_MODEL = "explicit-guide-test-model-no-inference";
  const store = getStore();
  const papers: Paper[] = [];
  function paper(title = "TEST ONLY - synthetic reading fixture") {
    const value = store.dispatch("paper.create", { title }) as Paper;
    papers.push(value);
    return value;
  }
  return {
    store, paper,
    async cleanup() {
      for (const value of papers) {
        for (const job of guideJobs(value.id)) {
          if (job.status === "running" || job.status === "queued") {
            guideAction({ action: "cancel", jobId: job.id });
            await terminal(value.id, job.id);
          }
        }
      }
      globalThis.fetch = previousFetch;
      store.close();
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function terminal(paperId: string, id: string): Promise<GuideJob> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const job = guideJobs(paperId).find((item) => item.id === id)!;
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await pause(10);
  }
  throw new Error("Guide transport fixture did not settle within ten seconds");
}

async function syntheticPdf(name: string, pages = 1, lines = 3) {
  const document = await PDFDocument.create();
  document.setTitle(`EXPLICIT TEST FIXTURE ${name}`);
  document.setCreationDate(new Date("2026-10-28T00:00:00Z"));
  document.setModificationDate(new Date("2026-10-28T00:00:00Z"));
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index++) {
    const page = document.addPage([600, 800]);
    for (let line = 0; line < lines; line++) {
      page.drawText(`TEST ONLY ${name} page ${index + 1} line ${line + 1}: This controlled source makes no academic claim and exists exclusively for reproducible parser verification.`,
        { x: 20, y: 775 - line * 13, size: 6, font });
    }
  }
  return Buffer.from(await document.save());
}

function parsePrompt(init?: RequestInit) {
  const body = JSON.parse(String(init?.body)) as {
    model: string; messages: { role: string; content: string }[];
  };
  assert.equal(body.model, "explicit-guide-test-model-no-inference");
  return body.messages.find((message) => message.role === "user")!.content;
}

function tagged<T>(prompt: string, tag: string): T {
  const value = prompt.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
  assert.ok(value, `expected ${tag} in model transport fixture`);
  return JSON.parse(value) as T;
}

function findings(blocks: SourceBlock[]) {
  const firstPerAttachment = blocks.filter((block, index) =>
    blocks.findIndex((other) => other.attachmentId === block.attachmentId) === index);
  return {
    notes: "显式测试传输：这是人工生成的阅读器验收材料，不包含真实科研结论。",
    findings: firstPerAttachment.map((block) => ({
      blockId: block.id,
      quote: block.text.trim().slice(0, 160),
      category: "method",
      title: "测试材料的来源说明",
      explanation: "此处仅验证原文摘录和定位的契约，不将测试字符串当作学术结论。",
    })),
  };
}

function report(evidence: GuideEvidence[]) {
  const refs = evidence.map((item) => item.id);
  return {
    overview: "显式测试导读：资料是合成的功能验收 PDF。",
    sections: [{ key: "source", title: "材料说明", body: "选定材料仅用于验证阅读流程。", basis: "author", evidenceIds: refs }],
    selectedEvidenceIds: refs,
    readingOrder: refs,
    questions: ["实际学术论文仍需要人工核对解释是否符合上下文。"],
  };
}

type TransportHooks = {
  extract?: (blocks: SourceBlock[], call: number) => unknown | Promise<unknown>;
  reduce?: (material: { notes: { notes: string; evidenceIds: string[] }[]; evidence: GuideEvidence[] }, call: number) => unknown | Promise<unknown>;
  synthesize?: (evidence: GuideEvidence[], call: number) => unknown | Promise<unknown>;
};
function transport(hooks: TransportHooks = {}) {
  const calls = {
    extraction: [] as SourceBlock[][], synthesis: [] as GuideEvidence[][],
    reductions: [] as { notes: { notes: string; evidenceIds: string[] }[]; evidence: GuideEvidence[] }[],
    prompts: [] as string[],
  };
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "http://127.0.0.1:11434/api/chat");
    assert.equal(init?.redirect, "error");
    const prompt = parsePrompt(init);
    calls.prompts.push(prompt);
    let response: unknown;
    if (prompt.includes("阶段:extract")) {
      const blocks = tagged<SourceBlock[]>(prompt, "source_blocks");
      calls.extraction.push(blocks);
      response = hooks.extract ? await hooks.extract(blocks, calls.extraction.length) : findings(blocks);
    } else if (prompt.includes("阶段:reduce")) {
      const material = tagged<{ notes: { notes: string; evidenceIds: string[] }[]; evidence: GuideEvidence[] }>(prompt, "materials");
      calls.reductions.push(material);
      response = hooks.reduce ? await hooks.reduce(material, calls.reductions.length) : {
        notes: `显式测试压缩笔记。${material.notes.map((value) => value.notes.match(/CHUNK-\d+/g)?.join(" ") ?? "").join(" ")}`,
        evidenceIds: material.evidence.map((value) => value.id).slice(0, 12),
      };
    } else {
      assert.match(prompt, /阶段:synthesize/);
      const { evidence } = tagged<{ evidence: GuideEvidence[] }>(prompt, "materials");
      calls.synthesis.push(evidence);
      response = hooks.synthesize ? await hooks.synthesize(evidence, calls.synthesis.length) : report(evidence);
    }
    if (response instanceof Response) return response;
    return Response.json({ message: { content: JSON.stringify(response) } });
  };
  return calls;
}

function start(paper: Paper, attachments: Attachment[], otherPapers?: Paper[]) {
  return guideAction(guideActionSchema.parse({
    action: "start", paperId: paper.id,
    mode: otherPapers ? "comparison" : "guide",
    attachmentIds: attachments.map((item) => item.id),
    ...(otherPapers ? { paperIds: [paper.id, ...otherPapers.map((item) => item.id)] } : {}),
  }));
}

test("real PDF guide sources cover all physical pages and preserve printed labels", async () => {
  const context = setup();
  try {
    const paper = context.paper();
    const attachment = context.store.addAttachment(paper.id, "reading-fixture.pdf", fixture);
    const [source] = await readGuideSources([attachment.id]);
    assert.equal(source.source.pageCount, 3);
    assert.deepEqual(source.pageLabels, ["i", "1", "2"]);
    assert.deepEqual(source.source.parsedPages, [0, 1, 2]);
    assert.deepEqual(source.source.emptyPages, []);
    assert.equal(source.source.attachmentSha256, attachment.sha256);
    assert.equal(source.source.characterCount, source.pages.reduce((sum, page) => sum + page.length, 0));
    for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
      assert.equal(source.blocks.filter((block) => block.pageIndex === pageIndex).map((block) => block.text).join(""), source.pages[pageIndex]);
    }
    const chunks = splitGuideChunks([source], 1000);
    assert.deepEqual(chunks.flat(), source.blocks, "chunk boundaries must never drop or reorder a source block");
    assert.ok(chunks.length > 1);
  } finally { await context.cleanup(); }
});

test("single-paper guide joins main PDF and supplement, saves exact sources, and preserves personal notes", async () => {
  const context = setup();
  try {
    const paper = context.paper();
    const main = context.store.addAttachment(paper.id, "main.pdf", fixture);
    const supplement = context.store.addAttachment(paper.id, "supplement.pdf", await syntheticPdf("SUPPLEMENT"));
    const note = context.store.snapshot().notes.find((value) => context.store.snapshot().relations.some((relation) => relation.fromId === value.id && relation.toId === paper.id))!;
    context.store.dispatch("note.update", { id: note.id, revision: note.revision, body: "PRIVATE HUMAN NOTE - AI must not transmit or overwrite this text" });
    const notesBefore = context.store.snapshot().notes;
    const annotationsBefore = context.store.snapshot().annotations;
    const calls = transport();
    const job = start(paper, [main, supplement]);
    const completed = await terminal(paper.id, job.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.completedChunks, completed.totalChunks);
    const saved = context.store.snapshot().aiContents.find((value) => value.id === completed.resultId)!;
    assert.equal(saved.kind, "guide");
    assert.equal(saved.provider, "ollama");
    assert.equal(saved.sourceScope, "full_text");
    assert.deepEqual(saved.sourcePageIndices, [0, 1, 2]);
    assert.deepEqual(saved.guideData!.sources.map((value) => value.attachmentId), [main.id, supplement.id]);
    assert.deepEqual(new Set(saved.guideData!.evidence.map((value) => value.attachmentId)), new Set([main.id, supplement.id]));
    assert.ok(saved.guideData!.evidence.every((value) => value.matched));
    assert.equal(saved.guideData!.evidence.find((value) => value.attachmentId === main.id)?.pageLabel, "i");
    assert.deepEqual(context.store.snapshot().notes, notesBefore);
    assert.deepEqual(context.store.snapshot().annotations, annotationsBefore);
    assert.doesNotMatch(calls.prompts.join("\n"), /PRIVATE HUMAN NOTE/);
    assert.match(saved.body, /AI 论文导读/);
    assert.match(saved.body, /supplement\.pdf/);
    const row = context.store.db.prepare("SELECT payload FROM guide_jobs WHERE id=?").get(completed.id) as { payload: string };
    const cache = JSON.parse(row.payload) as { documents?: unknown; chunks: unknown[]; digests: Record<string, unknown> };
    assert.equal(cache.documents, undefined, "completed jobs must not retain full parsed PDF pages");
    assert.deepEqual(cache.chunks, [], "completed extraction notes are released after saving the report");
    assert.deepEqual(cache.digests, {});
  } finally { await context.cleanup(); }
});

test("two-paper comparison requires evidence from both real PDF source sets", async () => {
  const context = setup();
  try {
    const first = context.paper("TEST ONLY first source");
    const second = context.paper("TEST ONLY second source");
    const main = context.store.addAttachment(first.id, "first.pdf", fixture);
    const related = context.store.addAttachment(second.id, "second.pdf", await syntheticPdf("RELATED"));
    transport();
    const completed = await terminal(first.id, start(first, [main, related], [second]).id);
    assert.equal(completed.status, "completed", completed.error);
    const saved = context.store.snapshot().aiContents.find((value) => value.id === completed.resultId)!;
    assert.equal(saved.kind, "comparison");
    assert.deepEqual(saved.guideData!.paperIds, [first.id, second.id]);
    const section = saved.guideData!.sections[0];
    assert.deepEqual(new Set(section.evidenceIds.map((id) => saved.guideData!.evidence.find((value) => value.id === id)!.paperId)), new Set([first.id, second.id]));
    assert.match(saved.body, /AI 关联分析/);

    transport({ synthesize: (evidence) => ({ ...report(evidence), sections: [{ ...report(evidence).sections[0], evidenceIds: [evidence[0].id] }] }) });
    const rejected = await terminal(first.id, start(first, [main, related], [second]).id);
    assert.equal(rejected.status, "failed");
    assert.match(rejected.error, /双方原文证据/);
    assert.equal(context.store.snapshot().aiContents.length, 1);

    transport({ synthesize: (evidence) => ({ ...report(evidence), sections: [{ ...report(evidence).sections[0], basis: "analysis", evidenceIds: [] }] }) });
    const ungrounded = await terminal(first.id, start(first, [main, related], [second]).id);
    assert.equal(ungrounded.status, "failed");
    assert.match(ungrounded.error, /双方原文证据/);
    assert.equal(context.store.snapshot().aiContents.length, 1, "AI analysis must not bypass comparison evidence requirements");
  } finally { await context.cleanup(); }
});

test("invented quotes and foreign blocks are discarded, unknown synthesis IDs reject the report", async () => {
  const context = setup();
  try {
    const paper = context.paper();
    const attachment = context.store.addAttachment(paper.id, "source.pdf", fixture);
    transport({ extract: (blocks) => {
      const valid = findings(blocks);
      return { ...valid, findings: [...valid.findings,
        { ...valid.findings[0], quote: "This entirely invented sentence is absent from the real PDF source." },
        { ...valid.findings[0], blockId: "unselected-foreign-block" },
      ] };
    } });
    const completed = await terminal(paper.id, start(paper, [attachment]).id);
    assert.equal(completed.status, "completed", completed.error);
    const saved = context.store.snapshot().aiContents.find((value) => value.id === completed.resultId)!;
    assert.equal(saved.guideData!.evidence.length, 1);
    assert.ok(saved.guideData!.warnings.some((warning) => /2 条/.test(warning)));
    assert.doesNotMatch(saved.sourceText, /entirely invented/);

    const calls = transport({ synthesize: (evidence) => ({ ...report(evidence), readingOrder: ["model-invented-evidence-id"] }) });
    const rejected = await terminal(paper.id, start(paper, [attachment]).id);
    assert.equal(rejected.status, "failed");
    assert.match(rejected.error, /不存在的证据/);
    assert.equal(rejected.resultId, null);
    assert.equal(context.store.snapshot().aiContents.length, 1);
    assert.equal(calls.extraction.length, 1);
  } finally { await context.cleanup(); }
});

test("resume reuses completed extraction chunks instead of reading them again", async () => {
  const context = setup();
  try {
    const paper = context.paper("TEST ONLY long synthetic source");
    const attachment = context.store.addAttachment(paper.id, "long-source.pdf", await syntheticPdf("LONG", 8, 48));
    const documents = await readGuideSources([attachment.id]);
    const chunks = splitGuideChunks(documents);
    assert.ok(chunks.length >= 3, "fixture must exercise multiple real extraction chunks");
    const firstCalls = transport({ extract: (blocks, call) => call === 2 ? new Response("explicit fixture failure", { status: 503 }) : findings(blocks) });
    const started = start(paper, [attachment]);
    const failed = await terminal(paper.id, started.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.completedChunks, 1);
    assert.equal(firstCalls.extraction.length, 2);
    assert.equal(context.store.snapshot().aiContents.length, 0);
    const resumedCalls = transport();
    guideAction({ action: "resume", jobId: failed.id });
    const completed = await terminal(paper.id, failed.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(resumedCalls.extraction.length, chunks.length - 1);
    assert.deepEqual(resumedCalls.extraction[0].map((block) => block.id), chunks[1].map((block) => block.id));
    assert.equal(resumedCalls.synthesis.length, 1);
    assert.equal(context.store.snapshot().aiContents.length, 1);
  } finally { await context.cleanup(); }
});

test("cancel aborts in-flight model transport without saving a partial report and concurrent start returns 409", async () => {
  const context = setup();
  try {
    const paper = context.paper();
    const attachment = context.store.addAttachment(paper.id, "source.pdf", fixture);
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    globalThis.fetch = async (_url, init) => {
      entered();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Explicit fixture cancellation", "AbortError"));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const job = start(paper, [attachment]);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([waiting, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("model transport did not start")), 3000);
      })]);
    } finally { clearTimeout(deadline); }
    assert.throws(() => start(paper, [attachment]), (error) => error instanceof StoreError && error.status === 409);
    context.store.dispatch("paper.trash", { id: paper.id, revision: paper.revision });
    guideAction({ action: "cancel", jobId: job.id });
    const cancelled = await terminal(paper.id, job.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.resultId, null);
    assert.equal(context.store.snapshot().aiContents.length, 0);
    assert.equal(guideJobs(paper.id).length, 1, "rejected concurrent start creates no queued task");
  } finally { await context.cleanup(); }
});

test("recycled guide sources reject start and resume before creating tasks or transmitting another model stage", async () => {
  const context = setup();
  try {
    const paper = context.paper(), other = context.paper("TEST comparison partner");
    const main = context.store.addAttachment(paper.id, "main.pdf", fixture);
    const related = context.store.addAttachment(other.id, "related.pdf", await syntheticPdf("TRASHED-PARTNER"));
    const existing = context.store.saveAI({ paperId: paper.id, kind: "summary", body: "EXPLICIT previously saved test content", provider: "test-only", model: "no-model", sourceScope: "abstract", sourceAttachmentId: null, sourcePageIndices: [], sourceText: "", status: "completed" });
    const calls = transport();
    const recycledOther = context.store.dispatch("paper.trash", { id: other.id, revision: other.revision }) as Paper;
    const recycled = (error: unknown) => error instanceof StoreError && error.status === 409 && /回收站/.test(error.message);
    assert.throws(() => start(paper, [main, related], [other]), recycled);
    assert.throws(() => start(other, [related]), recycled);
    assert.equal(guideJobs(paper.id).length, 0);
    assert.equal(guideJobs(other.id).length, 0);
    assert.equal(calls.prompts.length, 0);
    context.store.dispatch("paper.restore", { id: other.id, revision: recycledOther.revision });
    const liveCalls = transport({ extract: (blocks) => {
      // Simulate a second window moving the source to trash while one request is in flight.
      context.store.dispatch("paper.trash", { id: paper.id, revision: paper.revision });
      return findings(blocks);
    } });
    const job = start(paper, [main]);
    const failed = await terminal(paper.id, job.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /回收站/);
    assert.equal(liveCalls.extraction.length, 1);
    assert.equal(liveCalls.synthesis.length, 0, "recycled source cannot proceed to another model request");
    assert.deepEqual(context.store.snapshot().aiContents.map((item) => item.id), [existing.id]);
    const beforeResume = guideJobs(paper.id);
    assert.throws(() => guideAction({ action: "resume", jobId: failed.id }), recycled);
    assert.deepEqual(guideJobs(paper.id), beforeResume);
    assert.equal(liveCalls.prompts.length, 1);
    assert.equal(guideAction({ action: "cancel", jobId: failed.id }).id, failed.id);
    assert.equal(readFileSync(context.store.attachmentPath(main.id)).compare(fixture), 0);
  } finally { await context.cleanup(); }
});

test("source selection rejects duplicate or foreign attachments and bounded request schemas", async () => {
  const context = setup();
  try {
    const paper = context.paper();
    const foreignPaper = context.paper("Unselected foreign source");
    const attachment = context.store.addAttachment(paper.id, "source.pdf", fixture);
    const foreign = context.store.addAttachment(foreignPaper.id, "foreign.pdf", await syntheticPdf("FOREIGN"));
    const invalid = (attachments: Attachment[]) => assert.throws(() => start(paper, attachments), (error) => error instanceof StoreError && error.status === 400);
    invalid([attachment, attachment]);
    invalid([foreign]);
    assert.equal(guideJobs(paper.id).length, 0);
    const base = { action: "start", paperId: paper.id, mode: "guide", attachmentIds: [attachment.id] };
    assert.equal(guideActionSchema.safeParse({ ...base, attachmentIds: [] }).success, false);
    assert.equal(guideActionSchema.safeParse({ ...base, attachmentIds: Array.from({ length: 13 }, () => randomUUID()) }).success, false);
    assert.equal(guideActionSchema.safeParse({ ...base, injectedPrompt: "untrusted" }).success, false);
    assert.equal(guideActionSchema.safeParse({ action: "resume", jobId: "not-an-id" }).success, false);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(readGuideSources([attachment.id], controller.signal), (error) => error instanceof DOMException && error.name === "AbortError");

    const tooLong = await PDFDocument.create();
    for (let index = 0; index < 1001; index++) tooLong.addPage([100, 100]);
    const hugeAttachment = context.store.addAttachment(paper.id, "over-page-limit.pdf", await tooLong.save());
    await assert.rejects(readGuideSources([hugeAttachment.id]), (error) => error instanceof StoreError && error.status === 413);
  } finally { await context.cleanup(); }
});

test("a corrupt persisted job rejects resume with 422 and does not block a new analysis", async () => {
  const context = setup();
  try {
    const paper = context.paper();
    const attachment = context.store.addAttachment(paper.id, "source.pdf", fixture);
    transport({ extract: () => new Response("explicit transport fixture failure", { status: 503 }) });
    const failed = await terminal(paper.id, start(paper, [attachment]).id);
    assert.equal(failed.status, "failed");
    context.store.db.prepare("UPDATE guide_jobs SET payload=? WHERE id=?").run("{invalid-cache-json", failed.id);
    assert.throws(() => guideAction({ action: "resume", jobId: failed.id }), (error) => error instanceof StoreError && error.status === 422);
    transport();
    const completed = await terminal(paper.id, start(paper, [attachment]).id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(context.store.snapshot().aiContents.length, 1);
  } finally { await context.cleanup(); }
});

test("a no-evidence response clears extraction cache so the same task can be retried", async () => {
  const context = setup();
  try {
    const paper = context.paper();
    const attachment = context.store.addAttachment(paper.id, "source.pdf", fixture);
    const emptyCalls = transport({ extract: () => ({ notes: "显式测试：这次故意不返回可核对证据。", findings: [] }) });
    const failed = await terminal(paper.id, start(paper, [attachment]).id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /无可核对的原文证据/);
    assert.equal(failed.completedChunks, 0);
    assert.equal(emptyCalls.extraction.length, 1);
    assert.equal(emptyCalls.synthesis.length, 0);
    assert.equal(context.store.snapshot().aiContents.length, 0);
    const row = context.store.db.prepare("SELECT payload FROM guide_jobs WHERE id=?").get(failed.id) as { payload: string };
    assert.deepEqual(JSON.parse(row.payload).chunks, []);
    const retriedCalls = transport();
    guideAction({ action: "resume", jobId: failed.id });
    const completed = await terminal(paper.id, failed.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(retriedCalls.extraction.length, 1, "resume must obtain fresh evidence rather than reuse a known-empty chunk");
    assert.equal(retriedCalls.synthesis.length, 1);
  } finally { await context.cleanup(); }
});

test("long PDFs use bounded hierarchical notes from every chunk and reuse digest caches on resume", async () => {
  const context = setup();
  try {
    const paper = context.paper("TEST ONLY hierarchical reading source");
    const attachment = context.store.addAttachment(paper.id, "hierarchical.pdf", await syntheticPdf("HIERARCHICAL", 24, 48));
    const documents = await readGuideSources([attachment.id]);
    const chunks = splitGuideChunks(documents);
    assert.ok(chunks.length >= 10, "fixture must require enough notes to exercise hierarchical reduction");
    const calls = transport({
      extract: (blocks, call) => ({ ...findings(blocks), notes: `CHUNK-${call} ${"explicit synthetic reading checkpoint; ".repeat(95)}` }),
      synthesize: () => new Response("explicit final synthesis failure after digest persistence", { status: 503 }),
    });
    const failed = await terminal(paper.id, start(paper, [attachment]).id);
    assert.equal(failed.status, "failed");
    assert.ok(calls.reductions.length > 1, "long report must be reduced in multiple bounded groups");
    assert.equal(calls.extraction.length, chunks.length);
    assert.deepEqual(calls.extraction.flat().map((block) => block.id), documents.flatMap((document) => document.blocks.map((block) => block.id)));
    const covered = new Set(calls.reductions.flatMap((material) => material.notes.flatMap((node) => node.notes.match(/CHUNK-\d+/g) ?? [])));
    assert.deepEqual(covered, new Set(chunks.map((_chunk, index) => `CHUNK-${index + 1}`)), "every extraction chunk must participate in the hierarchy");
    for (const prompt of calls.prompts.filter((value) => value.includes("阶段:reduce"))) {
      assert.ok(prompt.length < 20000, `reduction prompt should remain bounded, got ${prompt.length}`);
    }
    const finalPrompt = calls.prompts.find((value) => value.includes("阶段:synthesize"))!;
    assert.ok(finalPrompt.length < 34000, `final synthesis prompt should remain bounded, got ${finalPrompt.length}`);
    const finalMaterials = tagged<{ notes: { notes: string }[] }>(finalPrompt, "materials");
    const finalMarkers = new Set(finalMaterials.notes.flatMap((node) => node.notes.match(/CHUNK-\d+/g) ?? []));
    assert.deepEqual(finalMarkers, covered, "the explicit digest fixture retains all chunk participation markers");
    const row = context.store.db.prepare("SELECT payload FROM guide_jobs WHERE id=?").get(failed.id) as { payload: string };
    const cache = JSON.parse(row.payload);
    assert.equal(cache.documents, undefined, "full PDF pages must not be copied into persisted retry state");
    assert.equal(cache.chunks.length, chunks.length);
    assert.equal(Object.keys(cache.digests).length, calls.reductions.length);
    assert.equal(context.store.snapshot().aiContents.length, 0);

    const resumedCalls = transport();
    guideAction({ action: "resume", jobId: failed.id });
    const completed = await terminal(paper.id, failed.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(resumedCalls.extraction.length, 0, "completed original chunks are reused");
    assert.equal(resumedCalls.reductions.length, 0, "content-addressed digest caches are reused");
    assert.equal(resumedCalls.synthesis.length, 1);
    const saved = context.store.snapshot().aiContents.find((value) => value.id === completed.resultId)!;
    assert.ok(saved.guideData!.warnings.some((warning) => /分层汇总/.test(warning)));
    const finishedRow = context.store.db.prepare("SELECT payload FROM guide_jobs WHERE id=?").get(completed.id) as { payload: string };
    const finishedCache = JSON.parse(finishedRow.payload);
    assert.deepEqual(finishedCache.chunks, []);
    assert.deepEqual(finishedCache.digests, {});
  } finally { await context.cleanup(); }
});
