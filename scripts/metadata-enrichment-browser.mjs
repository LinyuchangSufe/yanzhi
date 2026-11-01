/**
 * Isolated browser acceptance fixture; never target the user's library.
 * KB_BASE_URL=http://127.0.0.1:3121 KB_DATA_DIR=/private/tmp/kb-metadata-enrichment-browser-... \
 *   node --import tsx scripts/metadata-enrichment-browser.mjs seed|reader-checkpoint|preview|verify
 * Optional reader-checkpoint records the reader's initial position before lookup.
 * Browser actions happen between seed, preview (before Save), and verify (after Save).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const mode = process.argv[2];
assert.ok(["seed", "reader-checkpoint", "preview", "verify"].includes(mode), "Use seed|reader-checkpoint|preview|verify");
assert.ok(process.env.KB_BASE_URL, "KB_BASE_URL must explicitly target the isolated port 3121 server");
assert.ok(process.env.KB_DATA_DIR, "KB_DATA_DIR must explicitly identify the temporary fixture library");
const origin = new URL(process.env.KB_BASE_URL);
assert.equal(origin.protocol, "http:");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "Only a loopback HTTP server is allowed");
assert.equal(origin.port, "3121", "Only acceptance port 3121 is allowed; refusing user port 3000");
assert.ok(!origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash,
  "Supply a plain loopback origin without credentials, path, query or hash");
const base = origin.origin;
const dataDir = process.env.KB_DATA_DIR;
assert.match(dataDir, /^\/private\/tmp\/kb-metadata-enrichment-browser-[A-Za-z0-9_-]+$/,
  "Refusing a non-fixture data directory");
assert.equal(fs.realpathSync(dataDir), dataDir, "The fixture directory must exist and must not be a symlink");
const fixturePath = path.join(dataDir, "metadata-enrichment-browser-fixture.json");
const reportPath = path.resolve("test-results/metadata-enrichment-browser.json");
const title = "Loss of plasticity in deep continual learning";
const expectedDoi = "10.1038/s41586-024-07711-7";
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function request(route, options = {}) {
  const response = await fetch(base + route, {
    ...options, redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { Origin: base, ...options.headers },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response;
}
const json = async (route, options) => (await request(route, options)).json();
const post = (action, payload) => json("/api/kb", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }),
});
const config = await json("/api/kb/ai");
assert.equal(config.dataDir, dataDir, "Server configuration must match the explicitly supplied isolated directory");
assert.equal(config.provider, "none", "AI must be disabled for this metadata-only acceptance fixture");
const state = await json("/api/kb");
function save(report) {
  // This report contains only the isolated fixture and public bibliographic data.
  const body = JSON.stringify(report, null, 2) + "\n";
  fs.writeFileSync(`${fixturePath}.tmp`, body, { mode: 0o600 });
  fs.renameSync(`${fixturePath}.tmp`, fixturePath);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(`${reportPath}.tmp`, body, { mode: 0o600 });
  fs.renameSync(`${reportPath}.tmp`, reportPath);
}
async function pdfFingerprint(id) {
  return sha(Buffer.from(await (await request(`/api/kb/attachment?id=${encodeURIComponent(id)}`)).arrayBuffer()));
}
function tagLinks(relations) {
  return relations.filter((relation) => relation.purpose === "tag")
    .map(({ id: _id, createdAt: _createdAt, ...relation }) => relation)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
if (mode === "seed") {
  assert.ok(!fs.existsSync(fixturePath), "This fixture has already been seeded; use preview or verify");
  for (const [key, value] of Object.entries(state))
    if (Array.isArray(value)) assert.equal(value.length, 0, `Refusing nonempty fixture ${key}`);
  const created = await post("paper.create", { title, tags: ["TEST · 保留原有标签", "TEST · Metadata fixture"] });
  const paper = created.result;
  const note = created.state.notes.find((item) => item.purpose === "paper" &&
    created.state.relations.some((relation) => relation.fromType === "note" && relation.fromId === item.id && relation.toId === paper.id));
  assert.ok(note);
  const body = "## TEST：原创个人笔记\n\n这是独立软件验收材料，并非这篇真实论文的总结或研究结论。\n\n补全文献信息必须保留我的笔记和公式 $x_{t+1}=a x_t+u_t$。\n\n标记：METADATA_PREVIEW_MUST_NOT_WRITE_NOTE。";
  await post("note.update", { id: note.id, revision: note.revision, body });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("SYNTHETIC SOFTWARE ACCEPTANCE PDF", { x: 42, y: 780, size: 18, font });
  page.drawText("This is not the actual journal article.", { x: 42, y: 744, size: 12, font });
  page.drawText("Original synthetic content; no scientific claims or external text.", { x: 42, y: 720, size: 11, font });
  page.drawText("Metadata lookup must never replace this local PDF or personal notes.", { x: 42, y: 696, size: 11, font });
  const pdfBytes = await pdf.save();
  const upload = new FormData();
  upload.set("paperId", paper.id);
  upload.set("file", new Blob([pdfBytes], { type: "application/pdf" }), "TEST-synthetic-metadata-fixture.pdf");
  const attachment = (await json("/api/kb/attachment", { method: "POST", body: upload })).result;
  const baseline = await json("/api/kb");
  const original = baseline.papers.find((item) => item.id === paper.id);
  assert.equal(original.doi, "");
  assert.equal(original.sourceUrl, "");
  assert.equal(original.abstract, "");
  assert.deepEqual(original.authors, []);
  assert.equal(original.year, null);
  assert.equal(await pdfFingerprint(attachment.id), sha(pdfBytes));
  const report = {
    startedAtUTC: new Date().toISOString(), baseUrl: base, dataDir,
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    gitDirty: !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
    configuration: { ai: "disabled", provider: config.provider, maxTitleCandidates: 5, expectedDoi }, seed: null,
    fixturePolicy: "Only the public real paper title is used. Notes, PDF and tags are synthetic software test content; no model calls.",
    title, paperId: paper.id, noteId: note.id, attachmentId: attachment.id,
    noteBodySha256: sha(body), pdfSha256: sha(pdfBytes), baseline, checks: [],
  };
  save(report);
  console.log(JSON.stringify({ stage: "seed", result: "passed", paperId: paper.id, noteId: note.id, attachmentId: attachment.id, dataDir, fixturePath, reportPath }, null, 2));
} else {
  assert.ok(fs.existsSync(fixturePath), "Seed this isolated directory first");
  assert.equal(fs.realpathSync(fixturePath), fixturePath, "Refusing a symlink fixture report");
  const report = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  assert.equal(report.dataDir, dataDir);
  assert.equal(report.baseUrl, base);
  assert.equal(report.configuration.expectedDoi, expectedDoi);
  const currentPdfSha256 = await pdfFingerprint(report.attachmentId);
  assert.equal(currentPdfSha256, report.pdfSha256, "Public metadata lookup must preserve the local PDF byte-for-byte");
  assert.equal(sha(state.notes.find((item) => item.id === report.noteId)?.body ?? ""), report.noteBodySha256);
  if (mode === "reader-checkpoint") {
    assert.ok(!report.checks.some((check) => ["preview", "verify"].includes(check.stage)), "Record the reader checkpoint before metadata preview/save acceptance");
    const { readingPositions: initialReadingPositions, ...initialRecords } = report.baseline;
    const { readingPositions, ...currentRecords } = state;
    assert.deepEqual(currentRecords, initialRecords, "Opening the reader may change only its reading position; all library records must remain identical");
    assert.equal(readingPositions.length, 1, "Only the fixture attachment may have an initial reading position");
    const position = readingPositions[0];
    assert.equal(position.paperId, report.paperId);
    assert.equal(position.attachmentId, report.attachmentId);
    assert.equal(position.pageIndex, 0);
    assert.equal(position.scale, "page-width");
    assert.equal(position.rotation, 0);
    assert.ok(Number.isFinite(Date.parse(position.updatedAt)));
    report.initialReadingPositions ??= initialReadingPositions;
    report.readerCheckpoints ??= report.readerCheckpoint ? [report.readerCheckpoint] : [];
    const reason = process.argv[3]?.trim() || "Reader opened before metadata lookup";
    assert.ok(reason.length <= 300, "Keep the explicit checkpoint reason under 300 characters");
    report.readerCheckpoint = {
      recordedAtUTC: new Date().toISOString(),
      reason,
      readingPositions,
      explanation: "The existing UI opens the reader before exposing Edit. Opening the fixture PDF saved only its initial page-0/page-width position before metadata lookup; every other record and PDF hash was checked unchanged.",
    };
    report.readerCheckpoints.push(report.readerCheckpoint);
    report.baseline.readingPositions = readingPositions;
  } else if (mode === "preview") {
    assert.deepEqual(state, report.baseline, "Fetching, selecting and filling previews must not save any local records");
  } else {
    const paper = state.papers.find((item) => item.id === report.paperId);
    const original = report.baseline.papers.find((item) => item.id === report.paperId);
    assert.ok(paper);
    assert.equal(paper.title.toLowerCase(), title.toLowerCase());
    assert.equal(paper.doi, expectedDoi);
    assert.equal(paper.year, 2024);
    assert.equal(paper.authors.length, 6);
    assert.ok(paper.abstract.length > 500, "The selected registered abstract must be present after explicit Save");
    const source = new URL(paper.sourceUrl);
    assert.equal(source.protocol, "https:");
    assert.ok(["www.nature.com", "nature.com", "doi.org", "dx.doi.org"].includes(source.hostname));
    assert.ok(paper.sourceUrl.includes("s41586-024-07711-7"), "Source must identify the selected journal version");
    assert.equal(paper.arxivId, original.arxivId);
    assert.equal(paper.arxivVersion, original.arxivVersion);
    assert.equal(paper.readingStatus, original.readingStatus);
    assert.equal(paper.deletedAt, original.deletedAt);
    assert.equal(paper.createdAt, original.createdAt);
    assert.ok(paper.revision > original.revision, "An explicit Save must have updated the paper revision");
    assert.equal(state.papers.length, report.baseline.papers.length);
    for (const candidate of report.baseline.papers.filter((item) => item.id !== report.paperId))
      assert.deepEqual(state.papers.find((item) => item.id === candidate.id), candidate);
    for (const key of ["notes", "attachments", "annotations", "topics", "tags", "aiContents", "noteImages", "noteAssists", "noteRevisions", "readingPositions", "settings"])
      assert.deepEqual(state[key], report.baseline[key], `${key} must stay unchanged`);
    assert.deepEqual(tagLinks(state.relations), tagLinks(report.baseline.relations), "Same tags must stay attached to the same paper");
    assert.deepEqual(state.relations.filter((item) => item.purpose !== "tag"), report.baseline.relations.filter((item) => item.purpose !== "tag"));
    report.finalPaper = paper;
    report.finalAbstractSha256 = sha(paper.abstract);
    // Download through the same public backup endpoint, then exercise the
    // application's real restore implementation in a fresh temporary library.
    const archive = Buffer.from(await (await request("/api/kb/backup")).arrayBuffer());
    const { restoreBackup } = await import("../src/lib/archive.ts");
    const { KBStore } = await import("../src/lib/db.ts");
    const restoreParent = fs.mkdtempSync("/private/tmp/kb-metadata-enrichment-restore-");
    assert.match(restoreParent, /^\/private\/tmp\/kb-metadata-enrichment-restore-[A-Za-z0-9_-]+$/);
    assert.equal(fs.realpathSync(restoreParent), restoreParent);
    const archivePath = path.join(restoreParent, "metadata-fixture.kb.json.gz");
    fs.writeFileSync(archivePath, archive, { mode: 0o600, flag: "wx" });
    const restored = restoreBackup(archive, restoreParent);
    assert.equal(path.dirname(restored.restoredDirectory), restoreParent);
    assert.equal(fs.realpathSync(restored.restoredDirectory), restored.restoredDirectory);
    const reopened = new KBStore(restored.restoredDirectory);
    let restoredPdfSha256;
    let restoredNoteBodySha256;
    let noteMarkdownSha256;
    try {
      const restoredState = reopened.snapshot();
      assert.deepEqual(restoredState, state, "Complete backup restore must preserve every record and setting");
      restoredPdfSha256 = sha(fs.readFileSync(reopened.attachmentPath(report.attachmentId)));
      assert.equal(restoredPdfSha256, report.pdfSha256);
      restoredNoteBodySha256 = sha(restoredState.notes.find((item) => item.id === report.noteId)?.body ?? "");
      assert.equal(restoredNoteBodySha256, report.noteBodySha256);
      const sourceMarkdown = fs.readFileSync(path.join(dataDir, "notes", `${report.noteId}.md`));
      const restoredMarkdown = fs.readFileSync(path.join(restored.restoredDirectory, "notes", `${report.noteId}.md`));
      assert.deepEqual(restoredMarkdown, sourceMarkdown, "The original personal Markdown mirror must survive backup restore exactly");
      noteMarkdownSha256 = sha(restoredMarkdown);
    } finally {
      reopened.close();
    }
    assert.deepEqual(await json("/api/kb"), state, "Backup and isolated restore must not modify the source fixture library");
    assert.equal(await pdfFingerprint(report.attachmentId), report.pdfSha256);
    report.backupRoundTrip = {
      verifiedAtUTC: new Date().toISOString(), result: "passed", archivePath,
      backupSha256: sha(archive), backupBytes: archive.length,
      restoredDirectory: restored.restoredDirectory, restoredPdfSha256,
      restoredNoteBodySha256, noteMarkdownSha256,
      allRecordsAndSettingsEqual: true, sourceLibraryUnchanged: true,
      counts: Object.fromEntries(Object.entries(state).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])),
    };
  }
  const check = { stage: mode, result: "passed", verifiedAtUTC: new Date().toISOString(), pdfSha256: currentPdfSha256, noteBodySha256: report.noteBodySha256 };
  report.checks.push(check);
  save(report);
  console.log(JSON.stringify(check, null, 2));
}
