// Disposable browser-acceptance data only. This script never starts a service,
// contacts port 3000, reads the user's library, or invokes an actual model.
// Usage: node scripts/selection-ai-smoke.mjs prepare
//        node scripts/selection-ai-smoke.mjs seed|verify /private/tmp/kb-selection-ai-XXXXXX
//        node scripts/selection-ai-smoke.mjs verify /private/tmp/kb-selection-ai-XXXXXX --expect-markdown 2
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";

const cwd = fileURLToPath(new URL("..", import.meta.url));
process.chdir(cwd);
const base = "http://127.0.0.1:3126";
const modelBase = "http://127.0.0.1:3128";
const model = "synthetic-selection-fixture";
const markerName = ".selection-ai-fixture.json";
const baselineName = ".selection-ai-baseline.json";
const mode = process.argv[2];
assert.ok(["prepare", "seed", "verify"].includes(mode), "Use prepare|seed|verify");
const expectedMarkdown = process.argv.length === 6 ? Number(process.argv[5]) : undefined;
if (expectedMarkdown !== undefined) {
  assert.equal(mode, "verify");
  assert.equal(process.argv[4], "--expect-markdown");
  assert.ok(Number.isSafeInteger(expectedMarkdown) && expectedMarkdown >= 1);
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtureSentences = [
  "Gradient descent updates the model parameters.",
  "Unbiased noise has zero conditional expectation.",
];
const fixturePages = [
  [
    "[TEST MOCK] Original software acceptance fixture - page 1",
    ...fixtureSentences,
    "This example studies a synthetic scalar quadratic objective.",
    "The terms refer only to this original test document.",
  ],
  [
    "[TEST MOCK] Original software acceptance fixture - page 2",
    "Context: the noise term is conditioned on the current parameter history.",
    "For this fictional example, its conditional mean is assumed to be zero.",
    "No real experiment, published theorem, citation, or research result is claimed.",
  ],
  [
    "[TEST MOCK] Original software acceptance fixture - page 3",
    "Limitations: this synthetic document exists only to test reading software.",
    "It is not evidence for a real optimization method or benchmark.",
    "Any AI response is a predefined mock, not an actual research analysis.",
  ],
];

function guardDirectory(value) {
  assert.equal(typeof value, "string");
  assert.match(value, /^\/private\/tmp\/kb-selection-ai-[A-Za-z0-9_-]+$/);
  assert.equal(fs.realpathSync(value), value, "Refusing symlinks or a different library");
  assert.ok(fs.lstatSync(value).isDirectory() && !fs.lstatSync(value).isSymbolicLink());
  const markerPath = path.join(value, markerName);
  assert.ok(fs.lstatSync(markerPath).isFile() && !fs.lstatSync(markerPath).isSymbolicLink());
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.equal(marker.type, "TEST MOCK selection AI fixture");
  assert.equal(marker.base, base);
  assert.equal(marker.modelBase, modelBase);
  assert.equal(marker.model, model);
  return marker;
}
function fileInFixture(dataDir, relativePath) {
  const result = path.resolve(dataDir, relativePath);
  assert.ok(result.startsWith(dataDir + path.sep), "Fixture file escaped guarded directory");
  assert.equal(fs.realpathSync(result), result, "Refusing symlink fixture files");
  assert.ok(fs.lstatSync(result).isFile() && !fs.lstatSync(result).isSymbolicLink());
  return result;
}
function writeExclusive(filename, value) {
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
function reportPath(dataDir) {
  return path.join(cwd, "test-results", `selection-ai-${path.basename(dataDir)}.json`);
}
function saveReport(dataDir, report) {
  fs.mkdirSync(path.join(cwd, "test-results"), { recursive: true });
  const target = reportPath(dataDir);
  if (fs.existsSync(target)) {
    assert.ok(fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink());
  }
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + "\n");
}
async function request(route, options = {}) {
  assert.ok(route.startsWith("/api/kb") && !route.startsWith("//"));
  const response = await fetch(base + route, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: { Origin: base, ...options.headers },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response;
}
const json = async (route, options) => (await request(route, options)).json();
const post = (action, payload) => json("/api/kb", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action, payload }),
});

if (mode === "prepare") {
  assert.equal(process.argv.length, 3, "prepare does not accept a directory or service URL");
  const dataDir = fs.mkdtempSync("/private/tmp/kb-selection-ai-");
  assert.equal(fs.realpathSync(dataDir), dataDir);
  const marker = {
    type: "TEST MOCK selection AI fixture", runId: randomUUID(),
    createdAtUTC: new Date().toISOString(), base, modelBase, model,
  };
  writeExclusive(path.join(dataDir, markerName), marker);
  const output = {
    result: "prepared", ...marker, dataDir,
    mockLog: path.join(dataDir, "mock-events.jsonl"),
    mockCommand: `node scripts/selection-ai-mock.mjs --log '${dataDir}/mock-events.jsonl'`,
    serviceCommand: `PORT=3126 KB_DATA_DIR='${dataDir}' KB_AI_PROVIDER=ollama KB_OLLAMA_URL=${modelBase} KB_OLLAMA_MODEL=${model} npm start`,
    seedCommand: `node scripts/selection-ai-smoke.mjs seed '${dataDir}'`,
    verifyCommand: `node scripts/selection-ai-smoke.mjs verify '${dataDir}'`,
    policy: "Only fixed loopback ports 3126/3128, a fresh marked temporary library, and predefined TEST MOCK model output. No service was started.",
  };
  saveReport(dataDir, output);
  console.log(JSON.stringify(output, null, 2));
} else {
  assert.ok(process.argv.length === 4 || (mode === "verify" && expectedMarkdown !== undefined),
    "seed|verify requires its prepared directory; verify optionally accepts --expect-markdown COUNT");
  const dataDir = process.argv[3];
  const marker = guardDirectory(dataDir);
  // Check both server data isolation and fake-model configuration before any write.
  const config = await json("/api/kb/ai");
  assert.equal(config.dataDir, dataDir);
  guardDirectory(config.dataDir);
  assert.equal(config.provider, "ollama");
  assert.equal(config.endpoint, modelBase);
  assert.equal(config.model, model);
  assert.equal(config.configured, true);
  const state = await json("/api/kb");
  async function verifyFiles(snapshot) {
    for (const attachment of snapshot.attachments) {
      const stored = fileInFixture(dataDir, attachment.relativePath);
      assert.equal(sha(fs.readFileSync(stored)), attachment.sha256, "Stored original PDF changed");
      const served = Buffer.from(await (await request(`/api/kb/attachment?id=${attachment.id}`)).arrayBuffer());
      assert.equal(sha(served), attachment.sha256, "Served original PDF changed");
    }
    for (const note of snapshot.notes) {
      const stored = fileInFixture(dataDir, `notes/${note.id}.md`);
      assert.equal(fs.readFileSync(stored, "utf8"),
        `<!-- kb-note:${note.id} revision:${note.revision} purpose:${note.purpose} -->\n# ${note.title}\n\n${note.body}\n`,
        "Personal Markdown mirror changed");
    }
  }
  if (mode === "seed") {
    assert.ok(!fs.existsSync(path.join(dataDir, baselineName)), "Refusing to reseed a fixture");
    for (const [key, value] of Object.entries(state)) {
      if (Array.isArray(value)) assert.equal(value.length, 0, `Refusing nonempty library: ${key}`);
    }
    const primary = await post("paper.create", {
      title: "TEST · English selection and context fixture",
      authors: ["Synthetic Fixture Author"], year: 2026,
      abstract: "[TEST MOCK] Original software acceptance material. A fictional scalar-quadratic example defines parameter updates and conditionally unbiased noise. It reports no real research findings.",
      readingStatus: "reading", inReadingList: true,
    });
    const paper = primary.result;
    const paperNote = primary.state.notes.find((note) => note.purpose === "paper");
    assert.ok(paperNote);
    await post("note.update", {
      id: paperNote.id, revision: paperNote.revision,
      body: "[TEST MOCK] ORIGINAL NOTE: selection translation, analysis, cancellation and navigation MUST NOT MODIFY this personal text.\n\n原稿保护验收：保留公式 $x_t^2$ 与我的判断。",
    });
    const other = await post("paper.create", {
      title: "TEST · Navigation target without PDF",
      abstract: "[TEST MOCK] No attachment; use this paper to test navigation during an AI request.",
    });
    const otherNote = other.state.notes.find((note) => note.purpose === "paper" && note.id !== paperNote.id);
    assert.ok(otherNote);
    await post("note.update", {
      id: otherNote.id, revision: otherNote.revision,
      body: "[TEST MOCK] SECOND ORIGINAL NOTE: returning from AI work must preserve this text exactly.",
    });
    const document = await PDFDocument.create();
    document.setTitle("TEST MOCK original English selection fixture");
    document.setAuthor("Synthetic software acceptance fixture");
    document.setCreator("selection-ai-smoke.mjs");
    document.setProducer("pdf-lib synthetic fixture");
    document.setCreationDate(new Date("2026-01-01T00:00:00Z"));
    document.setModificationDate(new Date("2026-01-01T00:00:00Z"));
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (const lines of fixturePages) {
      const page = document.addPage([612, 792]);
      lines.forEach((line, index) => page.drawText(line, {
        x: 42, y: 734 - index * 46, font, size: index === 0 ? 11 : 12,
      }));
    }
    const pdf = Buffer.from(await document.save());
    const pdfPath = path.join(dataDir, "TEST-MOCK-original-three-pages.pdf");
    fs.writeFileSync(pdfPath, pdf, { flag: "wx" });
    const form = new FormData();
    form.set("paperId", paper.id);
    form.set("file", new Blob([pdf], { type: "application/pdf" }), "TEST-MOCK-original-three-pages.pdf");
    const attachment = (await json("/api/kb/attachment", { method: "POST", body: form })).result;
    const topic = (await post("topic.create", {
      title: "TEST · Immutable research question",
      description: "[TEST MOCK] This original question must remain untouched by selection assistance.",
    })).result;
    await post("link.set", { fromType: "paper", fromId: paper.id, toType: "topic", toId: topic.id });
    const idea = (await post("note.create", {
      title: "TEST · Immutable personal idea", purpose: "idea",
      body: "[TEST MOCK] ORIGINAL IDEA: model generation must not rewrite this content.",
      paperIds: [paper.id], topicIds: [topic.id],
    })).result;
    const baseline = await json("/api/kb");
    assert.equal(baseline.papers.length, 2);
    assert.equal(baseline.attachments.length, 1);
    assert.equal(baseline.aiContents.length, 0);
    await verifyFiles(baseline);
    const report = {
      result: "seeded", runId: marker.runId, seededAtUTC: new Date().toISOString(),
      base, modelBase, model, dataDir,
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      workingTreeDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
      fixture: "Original three-page English PDF; deterministic text and fixed metadata; no real research input or inference.",
      seed: null, paperId: paper.id, otherPaperId: other.result.id,
      noteId: paperNote.id, otherNoteId: otherNote.id,
      attachmentId: attachment.id, topicId: topic.id, ideaId: idea.id,
      sourceIds: { paperId: paper.id, attachmentId: attachment.id, pageIndex: 0 },
      selectionSentences: fixtureSentences, physicalPages: 3, pdfSha256: sha(pdf),
      baseline, checks: [],
    };
    writeExclusive(path.join(dataDir, baselineName), report);
    saveReport(dataDir, report);
    console.log(JSON.stringify({ ...report, baseline: undefined }, null, 2));
  } else {
    const report = JSON.parse(fs.readFileSync(fileInFixture(dataDir, baselineName), "utf8"));
    assert.equal(report.runId, marker.runId);
    assert.equal(report.dataDir, dataDir);
    for (const [key, value] of Object.entries(report.baseline)) {
      if (["aiContents", "readingPositions", "noteAssists", "noteRevisions"].includes(key)) continue;
      assert.deepEqual(state[key], value, `Selection assistance changed original library data: ${key}`);
    }
    await verifyFiles(state);
    assert.equal(sha(fs.readFileSync(fileInFixture(dataDir, "TEST-MOCK-original-three-pages.pdf"))), report.pdfSha256);
    for (const position of state.readingPositions) {
      assert.equal(position.paperId, report.paperId);
      assert.equal(position.attachmentId, report.attachmentId);
      assert.ok(position.pageIndex >= 0 && position.pageIndex < 3);
    }
    for (const content of state.aiContents) {
      assert.ok(["translation", "explanation", "markdown"].includes(content.kind), "Unexpected model task saved");
      assert.equal(content.paperId, report.paperId);
      assert.equal(content.provider, "ollama");
      assert.equal(content.model, model);
      assert.equal(content.status, "completed");
      assert.match(content.body, /\[TEST MOCK\]/, "A real model result entered this fake-only fixture");
      assert.equal(content.sourceAttachmentId, report.attachmentId);
      if (content.kind === "markdown") {
        assert.ok(["page_image", "selection_image"].includes(content.sourceScope));
        assert.equal(content.sourcePageIndices.length, 1);
        const pageIndex = content.sourcePageIndices[0];
        assert.ok(Number.isSafeInteger(pageIndex) && pageIndex >= 0 && pageIndex < 3);
        assert.match(content.sourceText, new RegExp(`\\[PDF 图像识别 · 物理页 ${pageIndex + 1} ·`));
        assert.ok(content.sourceText.includes(`附件：${report.attachmentId}；SHA-256：${report.pdfSha256}`));
        assert.ok(content.sourceText.includes(content.sourceScope === "page_image" ? "整页" : "选区外接矩形"));
        assert.match(content.sourceText, /视觉识别不是原始 LaTeX 源码/);
        assert.match(content.sourceText, /未读取个人笔记/);
        assert.match(content.body, /\$x_t\$/);
        assert.match(content.body, /\$\$\nx_\{t\+1\} = x_t - \\eta g_t\n\$\$/);
        assert.doesNotMatch(content.sourceText, /ORIGINAL NOTE|ORIGINAL IDEA/);
        continue;
      }
      assert.equal(content.sourceScope, "selection_context");
      assert.deepEqual(content.sourcePageIndices, content.kind === "translation" ? [0] : [0, 1]);
      assert.match(content.sourceText, /\[论文标题（文献元数据）\]/);
      assert.match(content.sourceText, /\[论文摘要（文献元数据/);
      const selected = content.sourceText.match(/\[待处理选段[^\]]*\]\s*\n([\s\S]*?)(?=\n\[PDF 上下文|$)/)?.[1]?.trim();
      assert.ok(selected && selected.length >= 3, "Missing explicit selected-source snapshot");
      const normalizedSelection = selected.replace(/\s+/g, " ");
      const normalizedPage = fixturePages[0].join(" ").replace(/\s+/g, " ");
      assert.ok(normalizedPage.includes(normalizedSelection), "Selected source is not original page-one fixture text");
      assert.match(content.sourceText, /\[PDF 上下文 · 物理页 1/);
      if (content.kind === "explanation") assert.match(content.sourceText, /\[PDF 上下文 · 物理页 2/);
    }
    for (const key of ["noteAssists", "noteRevisions"]) {
      const original = report.baseline[key] || [];
      for (const record of original)
        assert.deepEqual(state[key].find((item) => item.id === record.id), record, `Existing ${key} record changed`);
    }
    for (const record of state.noteRevisions || []) {
      if (report.baseline.noteRevisions?.some((item) => item.id === record.id)) continue;
      const note = report.baseline.notes.find((item) => item.id === record.noteId);
      assert.ok(note, "AI history belongs to a foreign note");
      assert.equal(record.reason, "ai-start", "Browser acceptance must not apply or restore a suggestion");
      assert.equal(record.noteRevision, note.revision);
      assert.equal(record.title, note.title);
      assert.equal(record.body, note.body);
    }
    for (const record of state.noteAssists || []) {
      if (report.baseline.noteAssists?.some((item) => item.id === record.id)) continue;
      const note = report.baseline.notes.find((item) => item.id === record.noteId);
      assert.ok(note);
      assert.equal(record.baseTitle, note.title);
      assert.equal(record.baseBody, note.body);
      assert.equal(record.baseRevision, note.revision);
      assert.equal(record.lastAppliedRevision, note.revision);
      assert.deepEqual(record.appliedEdits, [], "Browser acceptance must leave suggestions unapplied");
      assert.equal(record.provider, "ollama");
      assert.equal(record.model, model);
      assert.match(record.result.overview, /\[TEST MOCK\]/);
      assert.ok(state.noteRevisions.some((item) => item.noteId === note.id && item.reason === "ai-start" && item.body === note.body));
      const original = record.selection?.text || note.body;
      if (record.selection) assert.equal(note.body.slice(record.selection.from, record.selection.to), original);
      for (const source of record.sources) {
        if (source.kind === "note") {
          assert.equal(source.noteId, note.id);
          assert.equal(source.text, original);
        } else if (source.kind === "topic") {
          const topic = report.baseline.topics.find((item) => `topic:${item.id}` === source.id);
          assert.ok(topic);
          assert.equal(source.text, topic.description);
        } else if (source.kind === "paper-abstract") {
          assert.ok(record.paperIds.includes(source.paperId));
          const paper = report.baseline.papers.find((item) => item.id === source.paperId);
          assert.ok(paper);
          assert.equal(source.text, paper.abstract);
        } else if (source.kind === "idea") {
          assert.ok(record.ideaIds.includes(source.noteId));
          const idea = report.baseline.notes.find((item) => item.id === source.noteId && item.purpose === "idea");
          assert.ok(idea);
          assert.equal(source.text, idea.body);
        } else assert.fail("No guide PDF evidence exists in this synthetic fixture");
      }
    }
    assert.ok(state.aiContents.some((item) => item.kind === "translation"), "Complete a translation in the browser first");
    assert.ok(state.aiContents.some((item) => item.kind === "explanation"), "Complete an analysis after the cancellation check");
    const logFile = fileInFixture(dataDir, "mock-events.jsonl");
    const events = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.event === "aborted" && event.kind === "explanation"), "No real upstream cancellation recorded");
    assert.ok(events.some((event) => event.event === "completed" && event.kind === "translation"));
    assert.ok(events.some((event) => event.event === "completed" && event.kind === "explanation"));
    const markdown = state.aiContents.filter((item) => item.kind === "markdown");
    if (expectedMarkdown !== undefined) assert.equal(markdown.length, expectedMarkdown);
    const markdownEvents = events.filter((event) => event.event === "completed" && event.kind === "markdown");
    assert.equal(markdownEvents.length, markdown.length, "Rendered-image results must match completed fake-provider requests");
    for (const event of markdownEvents) {
      assert.equal(event.imageCount, 1);
      assert.equal(event.imageByteLengths.length, 1);
      assert.ok(event.imageByteLengths[0] > 0 && event.imageByteLengths[0] <= 12 * 1024 * 1024);
      assert.ok(markdown.some((item) => item.sourceScope === event.sourceScope && item.sourcePageIndices[0] + 1 === event.physicalPage));
      assert.ok(!("images" in event) && !("image" in event) && !("base64" in event), "Never log image payloads");
    }
    const noteAssists = state.noteAssists?.length || 0;
    if (noteAssists) assert.ok(events.some((event) => event.event === "completed" && event.kind === "note-assist"));
    const check = {
      result: "passed", verifiedAtUTC: new Date().toISOString(),
      counts: { translations: state.aiContents.filter((item) => item.kind === "translation").length,
        analyses: state.aiContents.filter((item) => item.kind === "explanation").length,
        markdownConversions: markdown.length, noteAssists,
        upstreamAborts: events.filter((event) => event.event === "aborted").length },
      scopes: ["all original records and settings unchanged", "original PDF hash and note Markdown mirrors unchanged",
        "only explicit TEST MOCK reading-assistance additions", "actual selected text, context scope and physical pages preserved",
        "upstream analysis cancellation recorded", "completed translation and analysis recorded",
        ...(markdown.length ? ["Markdown image recognition requests carried one PNG each; no image payloads logged"] : []),
        ...(noteAssists ? ["paper-note suggestions and original snapshots remain separate and unapplied"] : [])],
      limitation: "Only synthetic fixed responses test interface behavior and provenance. Translation/analysis/transcription quality is not evaluated and no real research result is claimed.",
    };
    report.checks.push(check);
    report.result = "passed";
    saveReport(dataDir, report);
    console.log(JSON.stringify({ ...check, reportPath: reportPath(dataDir) }, null, 2));
  }
}
