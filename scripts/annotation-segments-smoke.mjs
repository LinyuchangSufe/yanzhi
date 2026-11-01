// Original synthetic browser fixture. No model, real paper, user note, or external request.
// Seed:   node --import tsx scripts/annotation-segments-smoke.mjs seed
// Verify: node --import tsx scripts/annotation-segments-smoke.mjs verify
// Serve the reported dataDir on port 3117 yourself; this script never starts a server.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { KBStore } from "../src/lib/db.ts";
import { restoreBackup } from "../src/lib/archive.ts";
import { aggregateTextSegments } from "../src/lib/annotation-segments.ts";
import { findUniqueQuote } from "../src/lib/guide/anchors.ts";

const cwd = fileURLToPath(new URL("..", import.meta.url));
process.chdir(cwd);
const resultDir = path.join(cwd, "test-results");
const reportPath = path.join(resultDir, "multi-highlight-browser.json");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const command = process.argv[2];
assert.ok(["seed", "verify"].includes(command), "Choose seed or verify");
const baseUrl = "http://127.0.0.1:3117";
const firstText = "First passage: keep the assumption and its context.";
const secondText = "Second passage: attach this separate result to one comment.";
const gapText = "GAP TEXT: this middle sentence must stay unselected.";
const gapText2 = "GAP TEXT: this other middle line is also unselected.";
const guideLines = [
  "The synthetic guide highlights one complete sentence.",
  "Its pale background should keep every letter readable.",
];
const guideQuote = guideLines.join(" ");
const assumptionText = "Assumption fixture: all variables are finite for this test.";
const comment = "TEST: these two separated passages share one comment.";

function safeDirectory(input, allowAbsent = false) {
  const resolved = path.resolve(input);
  assert.match(resolved, /^\/private\/tmp\/kb-multi-highlight-[A-Za-z0-9._-]+$/,
    "Only a named /private/tmp/kb-multi-highlight-* fixture directory is allowed");
  assert.equal(fs.realpathSync(path.dirname(resolved)), "/private/tmp");
  if (fs.existsSync(resolved)) {
    assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false, "Refusing a directory symlink");
    assert.equal(fs.realpathSync(resolved), resolved);
  } else assert.ok(allowAbsent, "The fixture directory must exist");
  return resolved;
}

async function readablePdf() {
  const doc = await PDFDocument.create();
  doc.setTitle("TEST - Discontinuous Highlight Fixture");
  doc.setAuthor("Synthetic Acceptance Fixture");
  doc.setSubject("Original deterministic layout; no real paper or research findings");
  doc.setCreationDate(new Date("2026-10-29T00:00:00.000Z"));
  doc.setModificationDate(new Date("2026-10-29T00:00:00.000Z"));
  const normal = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const page = doc.addPage([612, 792]);
  const text = (value, x, y, size = 16, font = normal, color = rgb(0.08, 0.1, 0.09)) =>
    page.drawText(value, { x, y, size, font, color });
  text("SYNTHETIC HIGHLIGHT TEST", 56, 736, 21, bold);
  text("Original fixture - no model and no research claims", 56, 707, 12);
  text("Select the first and second passages, leaving the gap alone.", 56, 679, 13);
  text(firstText, 56, 644);
  text(gapText, 56, 604, 14, normal, rgb(0.4, 0.44, 0.41));
  text(gapText2, 56, 580, 14, normal, rgb(0.4, 0.44, 0.41));
  text(secondText, 56, 536);
  text("AI DISPLAY FIXTURE - no model was run", 56, 459, 14, bold);
  text(guideLines[0], 56, 426);
  text(guideLines[1], 56, 402);
  text("Formula typography fixture (separate selectable glyphs):", 56, 351, 14);
  text("x", 84, 310, 23, italic); text("t", 96, 304, 13, italic); text("2", 98, 322, 13);
  text("+", 118, 310, 23); text("y", 147, 310, 23, italic);
  text("t+1", 159, 304, 13, italic); text("2", 161, 322, 13);
  text("= 1", 193, 310, 23);
  text(assumptionText, 56, 246, 15);
  text("All highlights are app overlays; the original PDF bytes stay intact.", 56, 183, 13);
  text("Physical page 1 / 2", 248, 40, 11);
  const secondPage = doc.addPage([612, 792]);
  for (const [value, y, size, font] of [
    ["SYNTHETIC SECOND PAGE", 736, 21, bold],
    ["Attachment identity and physical page indices remain stable.", 682, 16, normal],
    ["There should be no human annotation on this second page.", 650, 16, normal],
    ["The first page contains every selected passage in this browser test.", 616, 14, normal],
    ["Physical page 2 / 2", 40, 11, normal],
  ]) secondPage.drawText(value, { x: 56, y, size, font });
  const bytes = Buffer.from(await doc.save());
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: true });
  let pageTexts;
  try {
    const pdf = await task.promise;
    assert.equal(pdf.numPages, 2);
    pageTexts = await Promise.all([1, 2].map(async (number) => {
      const content = await (await pdf.getPage(number)).getTextContent();
      return content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" ");
    }));
    for (const quote of [firstText, secondText, guideQuote, assumptionText])
      assert.equal(findUniqueQuote(pageTexts[0], quote).status, "matched", `Real PDF.js must uniquely find: ${quote}`);
  } finally { await task.destroy(); }
  return { bytes, pageTexts };
}

if (command === "seed") {
  const requested = process.argv[3];
  const dataDir = requested
    ? safeDirectory(requested, true)
    : safeDirectory(fs.mkdtempSync("/private/tmp/kb-multi-highlight-browser-"));
  if (fs.existsSync(dataDir)) assert.equal(fs.readdirSync(dataDir).length, 0, "Refusing any nonempty fixture directory");
  else fs.mkdirSync(dataDir, { mode: 0o700 });
  const { bytes, pageTexts } = await readablePdf();
  const store = new KBStore(dataDir);
  let report;
  try {
    const paper = store.dispatch("paper.create", {
      title: "TEST · Discontinuous Highlights and Pale AI Marks",
      authors: ["Synthetic Acceptance Fixture"], year: 2026, readingStatus: "reading",
      abstract: "Original UI fixture only; no research finding or model output.",
    });
    const attachment = store.addAttachment(paper.id, "synthetic-highlights.pdf", bytes);
    const note = store.snapshot().notes[0];
    store.dispatch("note.update", { id: note.id, revision: note.revision,
      body: "TEST · Original personal note. This text must remain intact during annotation and synthetic guide display." });
    const evidence = [
      { id: "synthetic-method", quote: guideQuote, category: "method", title: "透明连续底色测试", explanation: "原创界面夹具：整句跨两行显示，无真实模型推断。" },
      { id: "synthetic-assumption", quote: assumptionText, category: "assumption", title: "第二种底色测试", explanation: "仅验证浅色批注覆盖，不代表学术结论。" },
    ].map((item, index) => ({
      ...item, paperId: paper.id, attachmentId: attachment.id, attachmentSha256: attachment.sha256,
      pageIndex: 0, pageLabel: "1", blockId: `synthetic-page-1-block-${index + 1}`, matched: true,
    }));
    const ai = store.saveAI({
      paperId: paper.id, kind: "guide", body: "SYNTHETIC UI FIXTURE. No AI model was called. Pale contiguous text overlays are tested on original source sentences.",
      provider: "synthetic-fixture", model: "no-model-executed", sourceScope: "full_text",
      sourceAttachmentId: attachment.id, sourcePageIndices: [0, 1], sourceText: pageTexts.join("\n\n"), status: "completed",
      guideData: { version: 1, mode: "guide", overview: "原创显示夹具：仅用于核对底色透明度、逐行连贯和来源回跳。未运行模型。",
        sections: [{ key: "method", title: "界面测试导读", body: "这份内容由测试脚本写入，用于验证连续浅色高亮；没有实际 AI 结论。", basis: "analysis", evidenceIds: evidence.map((item) => item.id) }],
        evidence, readingOrder: evidence.map((item) => item.id), questions: ["两行原文是否清楚可读？"],
        sources: [{ paperId: paper.id, paperTitle: paper.title, attachmentId: attachment.id, attachmentSha256: attachment.sha256,
          filename: attachment.filename, pageCount: 2, parsedPages: [0, 1], emptyPages: [], characterCount: pageTexts.join("").length }],
        warnings: ["SYNTHETIC UI FIXTURE: no model executed; no real paper or research finding."], paperIds: [paper.id] },
    });
    assert.equal(store.snapshot().annotations.length, 0, "Seed must not pre-create human annotations");
    report = {
      createdAtUTC: new Date().toISOString(), baseUrl, dataDir, paperId: paper.id, attachmentId: attachment.id,
      noteId: note.id, aiId: ai.id, fixturePolicy: "Synthetic original selectable PDF; no real papers, no model call, no experimental results.",
      aiStatus: { provider: ai.provider, model: ai.model, actualAIExecuted: false, source: "deterministic test script" },
      baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      config: { port: 3117, pageCount: 2, modelSeed: null, deterministicFixture: true, pageSize: { width: 612, height: 792 } },
      pdf: { sha256: sha256(bytes), byteSize: bytes.length, filename: attachment.filename },
      selection: { firstText, secondText, gapText, gapText2, expectedComment: comment,
        pageIndex: 0, x: 56, fontSize: 16, firstBaselineY: 644, secondBaselineY: 536,
        coordinateSystem: "PDF points, bottom-left origin. At viewport scale s, DOM x=56*s and baseline top=(792-y)*s.",
        firstApproxWidth: 323, secondApproxWidth: 381 },
      guide: { quote: guideQuote, lines: guideLines, baselineY: [426, 402], assumptionText, assumptionBaselineY: 246 },
      verification: null,
    };
    fs.mkdirSync(resultDir, { recursive: true });
    fs.writeFileSync(path.join(resultDir, "multi-highlight-fixture.pdf"), bytes);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  } finally { store.close(); }
  console.log(JSON.stringify(report, null, 2));
} else {
  const seed = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const dataDir = safeDirectory(seed.dataDir);
  assert.match(seed.fixturePolicy, /^Synthetic/);
  assert.equal(seed.baseUrl, baseUrl);
  assert.equal(seed.aiStatus.actualAIExecuted, false);
  const endpoint = new URL(process.argv[3] || baseUrl);
  assert.equal(endpoint.origin, baseUrl, "Only the isolated acceptance service on 127.0.0.1:3117 is allowed");
  assert.equal(endpoint.href, baseUrl + "/", "Supply the exact plain acceptance origin");
  async function request(route, options = {}) {
    assert.ok(route.startsWith("/api/kb") && !route.startsWith("//"));
    const response = await fetch(baseUrl + route, { ...options, headers: { Origin: baseUrl, ...options.headers },
      redirect: "error", signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, await response.clone().text());
    return response;
  }
  const json = async (route, options) => (await request(route, options)).json();
  const configuration = await json("/api/kb/ai");
  assert.equal(fs.realpathSync(configuration.dataDir), dataDir, "Refusing an unexpected live library");
  const initial = await json("/api/kb");
  assert.equal(initial.papers.length, 1);
  assert.equal(initial.papers[0].id, seed.paperId);
  assert.equal(initial.settings.aiProvider, "none");
  assert.equal(initial.aiContents.length, 1);
  assert.equal(initial.aiContents[0].id, seed.aiId);
  assert.equal(initial.aiContents[0].provider, "synthetic-fixture");
  assert.equal(initial.annotations.length, 1, "Save exactly one annotation after selecting both passages");
  const annotation = initial.annotations[0];
  assert.equal(annotation.kind, "highlight");
  assert.equal(annotation.paperId, seed.paperId);
  assert.equal(annotation.attachmentId, seed.attachmentId);
  assert.equal(annotation.pageIndex, 0);
  assert.equal(annotation.textSegments.length, 2);
  const normalize = (text) => text.toLowerCase().replace(/\s+/g, " ").trim();
  assert.match(normalize(annotation.textSegments[0].selectedText), /keep the assumption and its context/);
  assert.match(normalize(annotation.textSegments[1].selectedText), /attach this separate result to one comment/);
  assert.doesNotMatch(annotation.selectedText, /GAP TEXT|middle sentence|also unselected/i);
  assert.equal(annotation.comment, comment);
  assert.deepEqual({ rects: annotation.rects, selectedText: annotation.selectedText }, aggregateTextSegments(annotation.textSegments));
  const centers = annotation.textSegments.map((segment) => segment.rects.reduce((sum, rect) => sum + rect.y + rect.height / 2, 0) / segment.rects.length);
  assert.ok(centers[0] - centers[1] > 0.08, "The excerpts must remain physically disconnected");
  const rawPdf = Buffer.from(await (await request(`/api/kb/attachment?id=${seed.attachmentId}`)).arrayBuffer());
  assert.equal(sha256(rawPdf), seed.pdf.sha256);
  const note = initial.notes.find((item) => item.id === seed.noteId);
  assert.ok(note.body.includes("Original personal note. This text must remain intact"));
  const reference = `kb://annotation/${annotation.id}`;
  if (!note.body.includes(reference)) await json("/api/kb", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "note.update", payload: { id: note.id, revision: note.revision,
      body: note.body + `\n\n[Two separated original passages](${reference})` } }) });
  const state = await json("/api/kb");
  assert.equal(state.annotations.length, 1);
  assert.deepEqual(state.annotations[0], annotation);
  assert.deepEqual(state.aiContents, initial.aiContents, "No model record was produced or rewritten");
  assert.ok(state.relations.some((item) => item.fromId === seed.noteId && item.toId === annotation.id && item.purpose === "reference"));
  const markdown = await (await request(`/api/kb/export?noteId=${seed.noteId}`)).text();
  for (const needle of ["Original personal note", "keep the assumption and its context", "attach this separate result to one comment", "物理页 1", annotation.id])
    assert.ok(markdown.includes(needle), `Markdown missing ${needle}`);
  const backup = Buffer.from(await (await request("/api/kb/backup")).arrayBuffer());
  const restoreRoot = safeDirectory(fs.mkdtempSync("/private/tmp/kb-multi-highlight-restore-"));
  const restoredReport = restoreBackup(backup, restoreRoot);
  assert.ok(restoredReport.restoredDirectory.startsWith(restoreRoot + "/"));
  const restored = new KBStore(restoredReport.restoredDirectory);
  try {
    assert.deepEqual(restored.snapshot(), state);
    assert.equal(sha256(fs.readFileSync(restored.attachmentPath(seed.attachmentId))), seed.pdf.sha256);
  } finally { restored.close(); }
  assert.deepEqual(await json("/api/kb"), state, "Verification may not mutate the source after its deliberate synthetic reference link");
  seed.verification = { verifiedAtUTC: new Date().toISOString(), result: "passed", annotationId: annotation.id,
    segments: 2, comment, selectedSourceGapsExcluded: true, sourcePhysicalPageIndex: 0,
    attachmentBytesUnchanged: true, originalNotePreserved: true, syntheticGuideUnchanged: true,
    markdownReferenceAndBothQuotes: true, fullBackupRoundtrip: true, restoredDirectory: restoredReport.restoredDirectory,
    actualAIExecuted: false, browserSteps: "Performed separately by the agent in the real PDF.js browser UI; this script checks persisted and exported state." };
  fs.writeFileSync(reportPath, JSON.stringify(seed, null, 2) + "\n");
  console.log(JSON.stringify(seed.verification, null, 2));
}
