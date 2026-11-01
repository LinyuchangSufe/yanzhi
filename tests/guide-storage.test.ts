import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { KBStore } from "../src/lib/db";
import { createBackup, exportAIMarkdown, exportMarkdown, restoreBackup } from "../src/lib/archive";
import { aiSchema } from "../src/lib/validation";
import type { AIContent, Attachment, KBState, Paper } from "../src/lib/types";
import type { GuideData, GuideSource } from "../src/lib/guide/types";

// Explicit storage fixtures: these bytes and reports do not represent research findings.
const fixture = Buffer.from("%PDF-1.7\nGuide storage test fixture only\n%%EOF");
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-guide-storage-"));
  const store = new KBStore(path.join(root, "source"));
  return { root, store, cleanup() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function createPaper(store: KBStore, title = "导读存储测试论文") {
  return store.dispatch("paper.create", { title }) as Paper;
}
function source(paper: Paper, attachment: Attachment): GuideSource {
  return { paperId: paper.id, paperTitle: paper.title, attachmentId: attachment.id,
    attachmentSha256: attachment.sha256, filename: attachment.filename, pageCount: 3,
    parsedPages: [0, 1], emptyPages: [2], characterCount: 100 };
}
function guideInput(paper: Paper, attachment: Attachment, extra: GuideSource[] = []): Omit<AIContent, "id" | "createdAt"> & { guideData: GuideData } {
  const sources = [source(paper, attachment), ...extra];
  const paperIds = [...new Set(sources.map(item => item.paperId))];
  const mode = paperIds.length > 1 ? "comparison" : "guide";
  const evidence = sources.map((item, index) => ({ id: `evidence-${index + 1}`, paperId: item.paperId,
    attachmentId: item.attachmentId, attachmentSha256: item.attachmentSha256, pageIndex: 1,
    pageLabel: "ii", blockId: `block-${index + 1}`, quote: `Explicit quoted test passage ${index + 1}`,
    category: "method" as const, title: "示例重点", explanation: "仅验证存储与引用", matched: true }));
  return { paperId: paper.id, kind: mode, body: "Explicit complete guided reading test report",
    provider: "test-only", model: "no-real-inference", sourceScope: "full_text",
    sourceAttachmentId: attachment.id, sourcePageIndices: [0, 1], sourceText: "Input provenance fixture",
    status: "completed", guideData: { version: 1, mode, overview: "用于测试的总览",
      sections: [{ key: "methods", title: "方法与比较", body: "仅为测试结构化段落", basis: "analysis", evidenceIds: evidence.map(item => item.id) }],
      evidence, readingOrder: evidence.map(item => item.id), questions: ["测试问题"], sources,
      warnings: ["测试附件没有实际可读论文"], paperIds } };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
function checksum(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex"); }

test("legacy SQLite migrates additively and old AI records acquire null guide data", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-guide-migration-"));
  let store: KBStore | undefined;
  try {
    const old = new DatabaseSync(path.join(root, "knowledge.sqlite"));
    old.exec(readFileSync(path.resolve("migrations/001.sql"), "utf8"));
    old.prepare("INSERT INTO papers(id,title,reading_status,created_at,updated_at) VALUES(?,?,?,?,?)")
      .run("00000000-0000-4000-8000-000000000001", "旧库论文", "unread", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    old.prepare("INSERT INTO ai_contents(id,paper_id,kind,body,provider,model,source_scope,source_attachment_id,source_page_indices,source_text,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001", "summary", "Old summary remains intact", "fixture", "fixture", "abstract", null, "[]", "Old abstract", "completed", "2026-01-01T00:00:00.000Z");
    old.close();
    store = new KBStore(root);
    assert.equal(store.snapshot().aiContents[0].guideData, null);
    assert.equal(store.snapshot().aiContents[0].body, "Old summary remains intact");
    assert.ok(store.db.prepare("PRAGMA table_info(ai_contents)").all().some(column => column.name === "guide_data"));
    store.close(); store = new KBStore(root);
    assert.equal(store.snapshot().aiContents.length, 1);
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("guide and supplement evidence survive backup while personal notes and marks remain unchanged", () => {
  const ctx = setup(); let restored: KBStore | undefined;
  try {
    const paper = createPaper(ctx.store);
    const main = ctx.store.addAttachment(paper.id, "main.pdf", fixture);
    const supplement = ctx.store.addAttachment(paper.id, "supplement.pdf", Buffer.from("%PDF-1.7\nSupplement test fixture\n%%EOF"));
    const note = ctx.store.snapshot().notes[0];
    ctx.store.dispatch("note.update", { id: note.id, revision: note.revision, body: "我的独立笔记，不能被 AI 改写。" });
    ctx.store.dispatch("annotation.create", { paperId: paper.id, attachmentId: main.id, kind: "highlight", pageIndex: 0,
      rects: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.1 }], comment: "我的标记" });
    const before = ctx.store.snapshot();
    const mirror = readFileSync(path.join(ctx.store.dataDir, "notes", `${note.id}.md`), "utf8");
    const saved = ctx.store.saveAI(guideInput(paper, main, [source(paper, supplement)]));
    assert.deepEqual(ctx.store.snapshot().notes, before.notes);
    assert.deepEqual(ctx.store.snapshot().annotations, before.annotations);
    assert.equal(readFileSync(path.join(ctx.store.dataDir, "notes", `${note.id}.md`), "utf8"), mirror);
    assert.equal(ctx.store.snapshot("complete guided reading").searchResults?.[0].id, saved.id);
    const report = restoreBackup(createBackup(ctx.store), ctx.root);
    restored = new KBStore(report.restoredDirectory);
    assert.deepEqual(restored.snapshot(), ctx.store.snapshot());
    assert.equal(restored.snapshot().aiContents[0].guideData?.evidence[1].attachmentId, supplement.id);
  } finally { restored?.close(); ctx.cleanup(); }
});

test("comparison preserves evidence from selected papers without creating associations or changing notes", () => {
  const ctx = setup();
  try {
    const first = createPaper(ctx.store, "论文 A"), second = createPaper(ctx.store, "论文 B");
    const a = ctx.store.addAttachment(first.id, "a.pdf", fixture);
    const b = ctx.store.addAttachment(second.id, "b.pdf", Buffer.from("%PDF-1.7\nOther comparison fixture\n%%EOF"));
    const before = ctx.store.snapshot();
    const saved = ctx.store.saveAI(guideInput(first, a, [source(second, b)]));
    assert.equal(saved.kind, "comparison");
    assert.equal(saved.guideData?.evidence[1].paperId, second.id);
    assert.deepEqual(ctx.store.snapshot().relations, before.relations);
    assert.deepEqual(ctx.store.snapshot().notes, before.notes);
    assert.throws(() => ctx.store.saveAI({ ...guideInput(first, a), kind: "comparison" }), /类型与导读数据/);
    assert.throws(() => ctx.store.saveAI({ ...guideInput(first, a), kind: "summary" }), /类型与导读数据/);
  } finally { ctx.cleanup(); }
});

test("guide validation rejects cross-paper attachments, forged fingerprints and unknown evidence references", () => {
  const ctx = setup();
  try {
    const paper = createPaper(ctx.store), other = createPaper(ctx.store, "其他论文");
    const attachment = ctx.store.addAttachment(paper.id, "main.pdf", fixture);
    const foreign = ctx.store.addAttachment(other.id, "other.pdf", Buffer.from("%PDF-1.7\nForeign fixture\n%%EOF"));
    const cases: Array<(input: ReturnType<typeof guideInput>) => void> = [
      input => { input.guideData.sources[0].attachmentId = foreign.id; input.guideData.sources[0].attachmentSha256 = foreign.sha256; input.guideData.sources[0].filename = foreign.filename; input.guideData.evidence[0].attachmentId = foreign.id; input.guideData.evidence[0].attachmentSha256 = foreign.sha256; input.sourceAttachmentId = foreign.id; },
      input => { input.guideData.sources[0].attachmentSha256 = "a".repeat(64); input.guideData.evidence[0].attachmentSha256 = "a".repeat(64); },
      input => { input.guideData.sources[0].filename = "forged-source-label.pdf"; },
      input => { input.guideData.sections[0].evidenceIds = ["missing-evidence"]; },
      input => { input.guideData.readingOrder = ["missing-evidence"]; },
      input => { input.guideData.evidence[0].pageIndex = 2; },
      input => { input.guideData.evidence[0].attachmentSha256 = "b".repeat(64); },
      input => { input.guideData.sources[0].parsedPages.push(3); },
    ];
    for (const mutate of cases) {
      const input = guideInput(paper, attachment); mutate(input);
      assert.throws(() => ctx.store.saveAI(input));
      assert.equal(ctx.store.snapshot().aiContents.length, 0);
    }
    assert.equal(aiSchema.parse({ paperId: paper.id, kind: "summary", body: "Legacy", provider: "fixture", model: "fixture",
      sourceScope: "abstract", sourceAttachmentId: null, sourcePageIndices: [], sourceText: "Abstract", status: "completed" }).guideData, null);
  } finally { ctx.cleanup(); }
});

test("snapshot import validates guide source records after schema checks and rolls back forged references", () => {
  const ctx = setup(); const target = new KBStore(path.join(ctx.root, "target"));
  try {
    const paper = createPaper(ctx.store);
    const attachment = ctx.store.addAttachment(paper.id, "main.pdf", fixture);
    ctx.store.saveAI(guideInput(paper, attachment));
    const corrupted = structuredClone(ctx.store.snapshot());
    corrupted.aiContents[0].guideData!.sources[0].attachmentSha256 = "a".repeat(64);
    corrupted.aiContents[0].guideData!.evidence[0].attachmentSha256 = "a".repeat(64);
    assert.throws(() => target.importSnapshot(corrupted), /指纹/);
    assert.equal(target.snapshot().papers.length, 0);
    assert.equal(target.snapshot().aiContents.length, 0);
    assert.equal(readdirSync(path.join(target.dataDir, "notes")).length, 0);
  } finally { target.close(); ctx.cleanup(); }
});

test("finished reports require original evidence and substantive comparisons require both papers", () => {
  const ctx = setup();
  try {
    const paper = createPaper(ctx.store), other = createPaper(ctx.store, "比较论文");
    const attachment = ctx.store.addAttachment(paper.id, "main.pdf", fixture);
    const foreign = ctx.store.addAttachment(other.id, "comparison.pdf", Buffer.from("%PDF-1.7\nComparison evidence guard fixture\n%%EOF"));
    const noEvidence = guideInput(paper, attachment);
    noEvidence.guideData.evidence = [];
    noEvidence.guideData.sections[0].evidenceIds = [];
    noEvidence.guideData.readingOrder = [];
    assert.throws(() => ctx.store.saveAI(noEvidence));

    const uncitedFact = guideInput(paper, attachment);
    uncitedFact.guideData.sections[0].basis = "author";
    uncitedFact.guideData.sections[0].evidenceIds = [];
    assert.throws(() => ctx.store.saveAI(uncitedFact), /原文陈述必须保留证据/);

    const comparison = () => guideInput(paper, attachment, [source(other, foreign)]);
    for (const references of [[], ["evidence-1"]]) {
      for (const basis of ["author", "analysis"] as const) {
        const unsupported = comparison();
        unsupported.guideData.sections[0].basis = basis;
        unsupported.guideData.sections[0].evidenceIds = references;
        assert.throws(() => ctx.store.saveAI(unsupported), /必须保留双方证据/);
      }
    }
    const missingPaper = comparison();
    missingPaper.guideData.evidence.pop();
    missingPaper.guideData.sections = [];
    missingPaper.guideData.readingOrder = ["evidence-1"];
    assert.throws(() => ctx.store.saveAI(missingPaper), /缺少参与文献的最终原文证据/);

    const valid = comparison();
    valid.guideData.sections.push({ key: "question", title: "待探索", body: "仅作探索建议", basis: "question", evidenceIds: [] },
      { key: "not-stated", title: "材料未提供", body: "不推断缺失事实", basis: "not-stated", evidenceIds: [] });
    ctx.store.saveAI(valid);
    assert.equal(ctx.store.snapshot().aiContents.length, 1);
  } finally { ctx.cleanup(); }
});

test("a correctly checksummed archive cannot bypass final-report evidence requirements", () => {
  const ctx = setup();
  try {
    const paper = createPaper(ctx.store);
    const attachment = ctx.store.addAttachment(paper.id, "main.pdf", fixture);
    ctx.store.saveAI(guideInput(paper, attachment));
    const archive = JSON.parse(gunzipSync(createBackup(ctx.store)).toString("utf8"));
    archive.snapshot.aiContents[0].guideData.sections[0].basis = "author";
    archive.snapshot.aiContents[0].guideData.sections[0].evidenceIds = [];
    archive.snapshotSha256 = checksum(archive.snapshot);
    const before = readdirSync(ctx.root).sort();
    assert.throws(() => restoreBackup(gzipSync(JSON.stringify(archive)), ctx.root), /原文陈述必须保留证据/);
    assert.deepEqual(readdirSync(ctx.root).sort(), before);
  } finally { ctx.cleanup(); }
});

test("real legacy gzip checksums are verified before new defaults and continue to reject tampering", () => {
  const ctx = setup(); let restored: KBStore | undefined;
  try {
    const paper = createPaper(ctx.store);
    ctx.store.saveAI({ paperId: paper.id, kind: "summary", body: "Legacy fixture", provider: "fixture", model: "fixture",
      sourceScope: "abstract", sourceAttachmentId: null, sourcePageIndices: [], sourceText: "Legacy input", status: "completed" });
    const archive = JSON.parse(gunzipSync(createBackup(ctx.store)).toString("utf8"));
    // Reconstruct an actual old-format archive, including its old canonical checksum.
    delete archive.snapshot.settings.codexModel;
    delete archive.snapshot.aiContents[0].guideData;
    archive.snapshotSha256 = checksum(archive.snapshot);
    const report = restoreBackup(gzipSync(JSON.stringify(archive)), ctx.root);
    restored = new KBStore(report.restoredDirectory);
    assert.equal(restored.snapshot().settings.codexModel, "");
    assert.equal(restored.snapshot().aiContents[0].guideData, null);
    assert.equal(restored.snapshot().aiContents[0].body, "Legacy fixture");
    archive.snapshot.aiContents[0].body = "Corrupted";
    assert.throws(() => restoreBackup(gzipSync(JSON.stringify(archive)), ctx.root), /快照校验/);
  } finally { restored?.close(); ctx.cleanup(); }
});

test("guide restore canonicalizes corrected paper titles without trusting forged archive labels", () => {
  const ctx = setup(); let restored: KBStore | undefined;
  try {
    const paper = createPaper(ctx.store);
    const attachment = ctx.store.addAttachment(paper.id, "main.pdf", fixture);
    const input = guideInput(paper, attachment);
    input.guideData.sources[0].paperTitle = "Untrusted display label";
    const saved = ctx.store.saveAI(input);
    assert.equal(saved.guideData?.sources[0].paperTitle, paper.title);
    ctx.store.dispatch("paper.update", { id: paper.id, revision: paper.revision, title: "更正后的论文名" });
    const report = restoreBackup(createBackup(ctx.store), ctx.root);
    restored = new KBStore(report.restoredDirectory);
    assert.equal(restored.snapshot().aiContents[0].guideData?.sources[0].paperTitle, "更正后的论文名");
  } finally { restored?.close(); ctx.cleanup(); }
});

test("Markdown export includes complete independent guide records and leaves single-note export personal", () => {
  const ctx = setup();
  try {
    const paper = createPaper(ctx.store);
    const attachment = ctx.store.addAttachment(paper.id, "main.pdf", fixture);
    const saved = ctx.store.saveAI(guideInput(paper, attachment));
    const state: KBState = ctx.store.snapshot();
    const document = exportAIMarkdown(saved, state);
    assert.match(document, /AI 导读/);
    assert.match(document, /Explicit quoted test passage 1/);
    assert.match(document, /物理页 2；显示页码 ii/);
    assert.match(document, /AI 分析判断/);
    assert.match(document, /无可解析文字页 3/);
    assert.match(document, new RegExp(attachment.sha256));
    assert.match(document, /测试附件没有实际可读论文/);
    assert.match(exportMarkdown(state), /stable-ai-id/);
    assert.doesNotMatch(exportMarkdown(state, state.notes[0].id), /stable-ai-id/);
    assert.deepEqual(ctx.store.snapshot().notes, state.notes);
  } finally { ctx.cleanup(); }
});
