// Browser acceptance fixture for list-row actions. Never points at the real library.
// Start the isolated service separately, then run with: node --import tsx scripts/library-actions-smoke.mjs seed
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const base = "http://127.0.0.1:3122";
const reportPath = "test-results/library-actions-smoke.json";
const mode = process.argv[2];
const stages = ["seed", "inspect", "edited", "linked", "uploaded", "cancel", "trashed", "restored"];
assert.ok(stages.includes(mode), `Use ${stages.join("|")}`);
assert.equal(new URL(base).port, "3122");
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
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action, payload }),
});
const config = await json("/api/kb/ai");
assert.equal(config.provider, "none", "Real model calls must be disabled");
assert.match(config.dataDir, /^\/private\/tmp\/kb-library-actions-[A-Za-z0-9_-]+$/);
assert.equal(fs.realpathSync(config.dataDir), config.dataDir, "Do not accept a symlink to a user library");
const state = await json("/api/kb");
function save(report) {
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}
const byId = (items, id) => {
  const value = items.find((item) => item.id === id);
  assert.ok(value, `Missing fixture entity ${id}`);
  return value;
};
function relationMatches(relation, aType, aId, bType, bId) {
  return relation.purpose === "manual" && (
    (relation.fromType === aType && relation.fromId === aId && relation.toType === bType && relation.toId === bId) ||
    (relation.toType === aType && relation.toId === aId && relation.fromType === bType && relation.fromId === bId)
  );
}
async function verifyPdf(id, digest) {
  const bytes = Buffer.from(await (await request(`/api/kb/attachment?id=${id}`)).arrayBuffer());
  assert.equal(sha(bytes), digest, "Original PDF bytes changed");
}
if (mode === "seed") {
  for (const key of ["papers", "notes", "attachments", "topics", "annotations", "aiContents", "tags", "relations"])
    assert.equal(state[key].length, 0, `Refusing a nonempty fixture: ${key}`);
  const first = await post("paper.create", {
    title: "TEST · 列表操作 A", authors: ["Synthetic Fixture Author"], year: 2026,
    sourceUrl: "https://example.com/ailib-synthetic-fixture",
    tags: ["列表验收"], abstract: "原创软件验收材料，不是真实研究出版物。",
  });
  const paper = first.result;
  const note = first.state.notes[0];
  await post("note.update", {
    id: note.id, revision: note.revision,
    body: "# TEST · 列表操作原稿\n\n独特短语：纸舟列表验收。\n\n我的想法与公式 $x_t^2$ 应完整保留。",
  });
  const pdf = fs.readFileSync("tests/fixtures/reading-fixture.pdf");
  const form = new FormData();
  form.set("paperId", paper.id);
  form.set("file", new Blob([pdf], { type: "application/pdf" }), "TEST-list-original.pdf");
  const attachment = (await json("/api/kb/attachment", { method: "POST", body: form })).result;
  const annotation = (await post("annotation.create", {
    paperId: paper.id, attachmentId: attachment.id, kind: "region", pageIndex: 0,
    rects: [{ x: 0.1, y: 0.4, width: 0.3, height: 0.1 }],
    comment: "TEST · 列表操作不应改变已有批注",
  })).result;
  const other = (await post("paper.create", { title: "TEST · 列表操作 B · 无来源待上传" })).result;
  const existingTopic = (await post("topic.create", { title: "TEST · 已有关联研究问题" })).result;
  const targetTopic = (await post("topic.create", { title: "TEST · 列表新增研究问题" })).result;
  await post("link.set", { fromType: "paper", fromId: paper.id, toType: "topic", toId: existingTopic.id });
  const existingIdea = (await post("note.create", {
    title: "TEST · 已有关联想法", purpose: "idea", paperIds: [paper.id], body: "原创夹具，不含模型输出。",
  })).result;
  const targetIdea = (await post("note.create", {
    title: "TEST · 列表新增想法", purpose: "idea", body: "通过列表菜单关联此想法。",
  })).result;
  const revised = await PDFDocument.load(pdf);
  revised.setSubject("TEST LIST UPLOAD - original synthetic attachment for paper B");
  revised.setCreationDate(new Date("2026-10-28T00:00:00Z"));
  revised.setModificationDate(new Date("2026-10-28T00:00:00Z"));
  const uploadPdf = await revised.save({ useObjectStreams: false });
  const uploadFilename = "TEST-list-upload-B.pdf";
  const uploadFile = path.join(config.dataDir, uploadFilename);
  fs.writeFileSync(uploadFile, uploadPdf);
  const baseline = await json("/api/kb");
  const report = {
    createdAtUTC: new Date().toISOString(), base, dataDir: config.dataDir,
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    policy: "Explicit loopback port 3122, guarded temporary directory, AI disabled, original synthetic data only. Does not contact port 3000.",
    seed: null, paperId: paper.id, otherPaperId: other.id, noteId: note.id,
    attachmentId: attachment.id, annotationId: annotation.id,
    existingTopicId: existingTopic.id, existingIdeaId: existingIdea.id,
    targetTopicId: targetTopic.id, targetIdeaId: targetIdea.id,
    pdfSha256: sha(pdf), uploadSha256: sha(uploadPdf), uploadFilename, uploadFile,
    expectedEdit: { title: "TEST · 列表操作 A · 已编辑", authors: ["Synthetic Acceptance Author"], year: 2025 },
    baseline, checkpoint: baseline, checks: [],
  };
  save(report);
  console.log(JSON.stringify({ result: "seeded", ...Object.fromEntries(Object.entries(report).filter(([key]) => !["baseline", "checkpoint"].includes(key))) }, null, 2));
} else {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.dataDir, config.dataDir, "Fixture changed since seeding");
  if (mode === "inspect") {
    console.log(JSON.stringify({ base, dataDir: config.dataDir, papers: state.papers, relations: state.relations, attachments: state.attachments, lastPassedStage: report.checks.at(-1)?.stage }, null, 2));
  } else {
    const original = report.baseline;
    assert.deepEqual(state.readingPositions, [], "List actions must not require opening a PDF reader");
    const currentPaper = byId(state.papers, report.paperId);
    const originalPaper = byId(original.papers, report.paperId);
    for (const key of ["notes", "annotations", "topics", "tags", "aiContents", "noteImages", "noteAssists", "noteRevisions", "settings"])
      assert.deepEqual(state[key], original[key], `${key} must survive every row action unchanged`);
    assert.deepEqual(byId(state.papers, report.otherPaperId), byId(original.papers, report.otherPaperId), "Editing A must not edit B");
    assert.equal(state.papers.length, 2, "No extra paper may be created by row actions");
    for (const key of Object.keys(originalPaper).filter((key) => !["title", "authors", "year", "revision", "updatedAt", "deletedAt"].includes(key)))
      assert.deepEqual(currentPaper[key], originalPaper[key], `Unexpected paper change: ${key}`);
    for (const [key, value] of Object.entries(report.expectedEdit)) assert.deepEqual(currentPaper[key], value, `Expected list edit ${key}`);
    assert.equal(Boolean(currentPaper.deletedAt), mode === "trashed");
    await verifyPdf(report.attachmentId, report.pdfSha256);
    if (mode === "cancel") {
      assert.deepEqual(state, report.checkpoint, "Cancelled deletion changed stored content");
    } else if (mode === "trashed" || mode === "restored") {
      const previous = report.checkpoint;
      const previousPaper = byId(previous.papers, report.paperId);
      assert.equal(Boolean(previousPaper.deletedAt), mode === "restored");
      assert.equal(currentPaper.revision, previousPaper.revision + 1, "Trash/restore should change exactly one revision");
      for (const key of Object.keys(state).filter((key) => key !== "papers"))
        assert.deepEqual(state[key], previous[key], `${key} changed during trash/restore`);
      assert.deepEqual(state.papers.filter((item) => item.id !== report.paperId), previous.papers.filter((item) => item.id !== report.paperId));
    } else {
      assert.equal(currentPaper.revision, originalPaper.revision + 1, "Editing the row should update A exactly once");
      const expectedExtra = mode === "edited" ? 0 : 2;
      // Existing metadata saving recreates tag relation IDs, so compare tag membership.
      // All manually linked notes, topics and ideas must preserve their actual records.
      const tags = (snapshot) => snapshot.relations.filter((relation) => relation.purpose === "tag")
        .map(({ fromType, fromId, toType, toId }) => [fromType, fromId, toType, toId].join(":" )).sort();
      assert.deepEqual(tags(state), tags(original), "Existing tag membership changed");
      const originalManual = original.relations.filter((relation) => relation.purpose !== "tag");
      const oldIds = new Set(originalManual.map((relation) => relation.id));
      for (const relation of originalManual) assert.deepEqual(byId(state.relations, relation.id), relation, "Existing association changed");
      const added = state.relations.filter((relation) => relation.purpose !== "tag" && !oldIds.has(relation.id));
      assert.equal(added.length, expectedExtra, "Unexpected added associations");
      if (expectedExtra) {
        assert.ok(added.some((relation) => relationMatches(relation, "paper", report.paperId, "topic", report.targetTopicId)));
        assert.ok(added.some((relation) => relationMatches(relation, "paper", report.paperId, "note", report.targetIdeaId)));
      }
      assert.deepEqual(state.attachments.filter((item) => item.paperId === report.paperId), original.attachments, "B's PDF must never be attached to A");
      if (mode === "uploaded") {
        const addedAttachments = state.attachments.filter((item) => item.paperId === report.otherPaperId);
        assert.equal(addedAttachments.length, 1, "Only B should receive the uploaded PDF");
        const addedAttachment = addedAttachments[0];
        assert.equal(addedAttachment.filename, report.uploadFilename);
        assert.equal(addedAttachment.sha256, report.uploadSha256);
        await verifyPdf(addedAttachment.id, report.uploadSha256);
        report.uploadedAttachmentId = addedAttachment.id;
      } else assert.deepEqual(state.attachments, original.attachments);
    }
    if (mode === "restored") {
      const archive = Buffer.from(await (await request("/api/kb/backup")).arrayBuffer());
      const { restoreBackup } = await import("../src/lib/archive.ts");
      const { KBStore } = await import("../src/lib/db.ts");
      const target = fs.mkdtempSync("/private/tmp/kb-library-actions-restore-");
      const restored = restoreBackup(archive, target);
      const reopened = new KBStore(restored.restoredDirectory);
      try { assert.deepEqual(reopened.snapshot(), state, "Complete backup must round-trip every field"); }
      finally { reopened.close(); }
      report.backupSha256 = sha(archive);
      report.restoredDirectory = restored.restoredDirectory;
    }
    const result = { stage: mode, result: "passed", verifiedAtUTC: new Date().toISOString() };
    report.checks.push(result);
    report.checkpoint = state;
    save(report);
    console.log(JSON.stringify(result));
  }
}
