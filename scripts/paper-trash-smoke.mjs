// Isolated browser acceptance for reversible paper deletion; never target the user library.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const base = "http://127.0.0.1:3120";
const reportPath = "test-results/paper-trash-smoke.json";
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
assert.equal(config.provider, "none");
assert.match(config.dataDir, /^\/private\/tmp\/kb-paper-trash-browser-[A-Za-z0-9_-]+$/);
assert.equal(fs.realpathSync(config.dataDir), config.dataDir);
const mode = process.argv[2];
const state = await json("/api/kb");
function save(report) {
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}
if (mode === "seed") {
  for (const key of ["papers", "notes", "attachments", "topics", "annotations", "aiContents"])
    assert.equal(state[key].length, 0, `Refusing nonempty fixture ${key}`);
  const first = await post("paper.create", {
    title: "TEST · 可恢复的文献", doi: "10.1234/trash-fixture", tags: ["测试标签"],
    abstract: "原创软件验收材料，不是科研结论。",
  });
  const paper = first.result;
  const note = first.state.notes[0];
  await post("note.update", {
    id: note.id, revision: note.revision,
    body: "独特短语：纸鹤回收测试。\n\n原稿中的公式 $x_t^2$ 必须保留。",
  });
  const pdf = fs.readFileSync("tests/fixtures/reading-fixture.pdf");
  const upload = new FormData();
  upload.set("paperId", paper.id);
  upload.set("file", new Blob([pdf], { type: "application/pdf" }), "TEST-reading-fixture.pdf");
  const attachment = (await json("/api/kb/attachment", { method: "POST", body: upload })).result;
  const annotation = (await post("annotation.create", {
    paperId: paper.id, attachmentId: attachment.id, kind: "region",
    pageIndex: 0, pageLabel: "i", rects: [{ x: 0.1, y: 0.4, width: 0.3, height: 0.1 }],
    comment: "TEST：回收后批注仍保留",
  })).result;
  const other = (await post("paper.create", { title: "TEST · 保留的另一篇文献" })).result;
  const topic = (await post("topic.create", { title: "TEST · 研究问题" })).result;
  await post("link.set", { fromType: "paper", fromId: paper.id, toType: "topic", toId: topic.id });
  await post("note.create", {
    title: "TEST · 独立想法", purpose: "idea", paperIds: [paper.id, other.id], topicIds: [topic.id],
    body: `独立想法不随文献回收。\n\n[原文](kb://paper/${paper.id})\n[批注](kb://annotation/${annotation.id})`,
  });
  const baseline = await json("/api/kb");
  save({
    createdAtUTC: new Date().toISOString(), base, dataDir: config.dataDir,
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    fixturePolicy: "Only synthetic personal content and an original synthetic PDF; no real model or user data.",
    ai: "disabled", seed: null, paperId: paper.id, otherPaperId: other.id,
    noteId: note.id, annotationId: annotation.id, attachmentId: attachment.id,
    pdfSha256: sha(pdf), baseline,
  });
  console.log(JSON.stringify({ result: "seeded", paperId: paper.id, title: paper.title }));
} else {
  assert.ok(["cancel", "trashed", "restored"].includes(mode), "Use seed|cancel|trashed|restored");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.dataDir, config.dataDir);
  if (mode === "cancel") {
    assert.deepEqual(state, report.baseline);
  } else {
    const paper = state.papers.find((p) => p.id === report.paperId);
    assert.ok(paper);
    assert.equal(Boolean(paper.deletedAt), mode === "trashed");
    for (const key of ["notes", "attachments", "annotations", "relations", "topics", "tags", "aiContents", "noteImages", "noteAssists", "noteRevisions"])
      assert.deepEqual(state[key], report.baseline[key], `${key} must survive unchanged`);
    assert.deepEqual(state.papers.find((p) => p.id === report.otherPaperId), report.baseline.papers.find((p) => p.id === report.otherPaperId));
    const original = report.baseline.papers.find((p) => p.id === report.paperId);
    for (const key of Object.keys(original).filter((key) => !["deletedAt", "revision", "updatedAt"].includes(key)))
      assert.deepEqual(paper[key], original[key]);
    const pdf = Buffer.from(await (await request(`/api/kb/attachment?id=${report.attachmentId}`)).arrayBuffer());
    assert.equal(sha(pdf), report.pdfSha256);
    const search = await json(`/api/kb?q=${encodeURIComponent("纸鹤回收测试")}`);
    assert.equal(search.searchResults.some((item) => item.id === report.noteId), mode === "restored");
    const archive = Buffer.from(await (await request("/api/kb/backup")).arrayBuffer());
    const { restoreBackup } = await import("../src/lib/archive.ts");
    const { KBStore } = await import("../src/lib/db.ts");
    const target = fs.mkdtempSync("/private/tmp/kb-paper-trash-restore-");
    const restored = restoreBackup(archive, target);
    const reopened = new KBStore(restored.restoredDirectory);
    try { assert.deepEqual(reopened.snapshot(), state); } finally { reopened.close(); }
    report[`${mode}BackupSha256`] = sha(archive);
  }
  report.checks ??= [];
  const result = { stage: mode, result: "passed", verifiedAtUTC: new Date().toISOString() };
  report.checks.push(result);
  save(report);
  console.log(JSON.stringify(result));
}
