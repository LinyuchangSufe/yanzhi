// Isolated, staged browser acceptance. Never seed or mutate the real port 3000 library.
// Start the production service separately with PORT=3123, KB_AI_PROVIDER=none and a
// fresh /private/tmp/kb-reading-list-* directory, then use node --import tsx ... seed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const base = "http://127.0.0.1:3123";
const reportPath = "test-results/reading-list-smoke.json";
const mode = process.argv[2];
const stages = ["seed", "inspect", "added", "removed", "read", "refreshed"];
assert.ok(stages.includes(mode), `Use ${stages.join("|")}`);
assert.equal(new URL(base).hostname, "127.0.0.1");
assert.equal(new URL(base).port, "3123");
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function request(route, options = {}) {
  assert.ok(route.startsWith("/api/kb") && !route.startsWith("//"));
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
assert.match(config.dataDir, /^\/private\/tmp\/kb-reading-list-[A-Za-z0-9_-]+$/);
assert.equal(fs.realpathSync(config.dataDir), config.dataDir, "Refusing a symlink to another library");
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
const queuedIds = (snapshot) => snapshot.papers.filter((paper) => !paper.deletedAt && paper.inReadingList)
  .map((paper) => paper.id).sort();
async function verifyFiles(snapshot, directory = config.dataDir) {
  for (const attachment of snapshot.attachments) {
    const bytes = fs.readFileSync(path.join(directory, attachment.relativePath));
    assert.equal(sha(bytes), attachment.sha256, "Original attachment bytes changed");
    if (directory === config.dataDir) {
      const served = Buffer.from(await (await request(`/api/kb/attachment?id=${attachment.id}`)).arrayBuffer());
      assert.equal(sha(served), attachment.sha256, "Served attachment differs from stored PDF");
    }
  }
  for (const note of snapshot.notes) {
    const mirror = fs.readFileSync(path.join(directory, "notes", `${note.id}.md`), "utf8");
    assert.equal(mirror, `<!-- kb-note:${note.id} revision:${note.revision} purpose:${note.purpose} -->\n# ${note.title}\n\n${note.body}\n`, "Personal Markdown mirror changed");
  }
}
if (mode === "seed") {
  for (const key of ["papers", "notes", "attachments", "topics", "annotations", "aiContents", "tags", "relations"])
    assert.equal(state[key].length, 0, `Refusing a nonempty fixture: ${key}`);
  const { actionSchemas } = await import("../src/lib/validation.ts");
  assert.ok(actionSchemas["paper.reading-list"], "Wait for the new reading-list backend before seeding");
  const first = await post("paper.create", {
    title: "TEST · 阅读清单 A", authors: ["Synthetic Fixture Author"], year: 2026,
    abstract: "原创软件验收资料，不是真实学术文献。", tags: ["阅读清单验收"],
  });
  const paper = first.result;
  assert.equal(paper.readingStatus, "unread");
  assert.equal(paper.inReadingList, false, "New imports must not automatically enter the reading list");
  const note = first.state.notes[0];
  await post("note.update", {
    id: note.id, revision: note.revision,
    body: "# TEST · 阅读清单不修改原稿\n\n独特短语：纸舟阅读清单验收。\n\n我的公式 $x_t^2$ 与原文记录应保留。",
  });
  const pdf = fs.readFileSync("tests/fixtures/reading-fixture.pdf");
  const form = new FormData();
  form.set("paperId", paper.id);
  form.set("file", new Blob([pdf], { type: "application/pdf" }), "TEST-reading-list-original.pdf");
  const attachment = (await json("/api/kb/attachment", { method: "POST", body: form })).result;
  const annotation = (await post("annotation.create", {
    paperId: paper.id, attachmentId: attachment.id, kind: "region", pageIndex: 0,
    rects: [{ x: 0.1, y: 0.4, width: 0.3, height: 0.1 }],
    comment: "TEST · 加入、移出或标已读均不改变已有批注",
  })).result;
  const other = (await post("paper.create", { title: "TEST · 阅读清单 B", tags: ["阅读清单验收"] })).result;
  const readPaper = (await post("paper.create", { title: "TEST · 原本已读 C", readingStatus: "read" })).result;
  assert.equal(other.inReadingList, false);
  assert.equal(readPaper.inReadingList, false);
  const topic = (await post("topic.create", { title: "TEST · 阅读计划与资料相互独立" })).result;
  await post("link.set", { fromType: "paper", fromId: paper.id, toType: "topic", toId: topic.id });
  const idea = (await post("note.create", {
    title: "TEST · 阅读清单验收想法", purpose: "idea", paperIds: [paper.id, other.id], topicIds: [topic.id],
    body: `原创测试内容。\n\n[已有论文](kb://paper/${paper.id})\n[已有批注](kb://annotation/${annotation.id})`,
  })).result;
  const baseline = await json("/api/kb");
  assert.deepEqual(queuedIds(baseline), [], "Only selected papers should enter the reading list");
  await verifyFiles(baseline);
  const report = {
    createdAtUTC: new Date().toISOString(), base, dataDir: config.dataDir,
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    policy: "Fixed loopback port 3123; strict temporary-directory guard; AI disabled; synthetic data and original fixture PDF only. Never contacts port 3000.",
    seed: null, ai: "disabled", paperId: paper.id, otherPaperId: other.id, readPaperId: readPaper.id,
    noteId: note.id, attachmentId: attachment.id, annotationId: annotation.id, topicId: topic.id, ideaId: idea.id,
    pdfSha256: sha(pdf), baseline, checkpoint: baseline, checks: [],
  };
  save(report);
  console.log(JSON.stringify({ result: "seeded", base, dataDir: config.dataDir, paperId: paper.id, otherPaperId: other.id, readPaperId: readPaper.id }, null, 2));
} else {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.dataDir, config.dataDir, "Fixture changed since seeding");
  if (mode === "inspect") {
    console.log(JSON.stringify({ base, dataDir: config.dataDir, papers: state.papers, queuedIds: queuedIds(state), lastPassedStage: report.checks.at(-1)?.stage }, null, 2));
  } else {
    const expectedPrevious = { added: undefined, removed: "added", read: "removed", refreshed: "read" }[mode];
    assert.equal(report.checks.at(-1)?.stage, expectedPrevious, "Run acceptance stages in order");
    const original = report.baseline;
    const previous = report.checkpoint;
    assert.equal(state.papers.length, 3, "No paper may be added or deleted by reading-list controls");
    for (const key of Object.keys(original).filter((key) => key !== "papers"))
      assert.deepEqual(state[key], original[key], `${key} changed during a reading-list action`);
    const expectedQueue = mode === "added" ? [report.paperId, report.otherPaperId].sort()
      : mode === "removed" ? [report.otherPaperId] : [];
    assert.deepEqual(queuedIds(state), expectedQueue, "Reading-list membership differs from the selected rows");
    for (const paper of state.papers) {
      const before = byId(original.papers, paper.id);
      const checkpointPaper = byId(previous.papers, paper.id);
      for (const key of Object.keys(before).filter((key) => !["readingStatus", "inReadingList", "revision", "updatedAt"].includes(key)))
        assert.deepEqual(paper[key], before[key], `Metadata or ownership unexpectedly changed: ${paper.id}.${key}`);
      assert.equal(paper.readingStatus, paper.id === report.readPaperId || (paper.id === report.otherPaperId && ["read", "refreshed"].includes(mode)) ? "read" : "unread");
      const touched = mode === "added" ? paper.id !== report.readPaperId
        : mode === "removed" ? paper.id === report.paperId
          : mode === "read" ? paper.id === report.otherPaperId : false;
      if (touched) assert.equal(paper.revision, checkpointPaper.revision + 1, "Selected row should be updated exactly once");
      else assert.deepEqual(paper, checkpointPaper, "Unselected row or refreshed state changed");
    }
    await verifyFiles(state);
    if (mode === "refreshed") {
      assert.deepEqual(state, previous, "Browser refresh must persist the saved reading list and statuses");
      const archive = Buffer.from(await (await request("/api/kb/backup")).arrayBuffer());
      const { restoreBackup } = await import("../src/lib/archive.ts");
      const { KBStore } = await import("../src/lib/db.ts");
      const target = fs.mkdtempSync("/private/tmp/kb-reading-list-restore-");
      const restored = restoreBackup(archive, target);
      const reopened = new KBStore(restored.restoredDirectory);
      try { assert.deepEqual(reopened.snapshot(), state, "Complete backup must round-trip every field"); }
      finally { reopened.close(); }
      await verifyFiles(state, restored.restoredDirectory);
      assert.deepEqual(await json("/api/kb"), state, "Restoring elsewhere must not mutate the source library");
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
