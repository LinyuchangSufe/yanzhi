// Isolated browser acceptance: public journal metadata and synthetic library records.
// This script refuses the user library; it never invokes an AI provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const base = "http://127.0.0.1:3119";
const reportPath = "test-results/tag-import-smoke.json";
const journalUrl = "https://www.tandfonline.com/doi/full/10.1080/01621459.2026.2674413";
const title = "TEST · 期刊链接与标签";
const sha = (value) => createHash("sha256").update(value).digest("hex");

async function request(route, options = {}) {
  const response = await fetch(base + route, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(45000),
    headers: { Origin: base, ...options.headers },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response;
}
const json = async (route, options) => (await request(route, options)).json();
const post = (action, payload) => json("/api/kb", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action, payload }),
});
const config = await json("/api/kb/ai");
assert.equal(config.provider, "none", "AI must be disabled for this acceptance library");
assert.match(config.dataDir, /^\/private\/tmp\/kb-tag-import-browser-[A-Za-z0-9_-]+$/);
assert.equal(fs.realpathSync(config.dataDir), config.dataDir);
const state = await json("/api/kb");
const mode = process.argv[2];
function save(report) {
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}

if (mode === "seed") {
  for (const key of ["papers", "notes", "topics", "tags", "attachments", "aiContents"])
    assert.equal(state[key].length, 0, `Refusing to seed nonempty ${key}`);
  const first = await post("paper.create", {
    title: "TEST · 已有标签 A", tags: ["在线学习", "统计理论", "SGD"],
  });
  const second = await post("paper.create", {
    title: "TEST · 已有标签 B", tags: ["时间序列", "Online Learning"],
  });
  const original = await json("/api/kb");
  save({
    createdAtUTC: new Date().toISOString(), base, dataDir: config.dataDir,
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    ai: "disabled; no model executed", seed: null, journalUrl,
    fixturePolicy: "Synthetic library records; public DOI metadata may be fetched without uploading user papers.",
    baselinePaperIds: [first.result.id, second.result.id],
    baselineTagIds: original.tags.map((tag) => tag.id),
    baselineNotes: original.notes,
    expectedBrowserPaperTitle: title,
  });
  console.log(JSON.stringify({ result: "seeded", tags: original.tags.map((tag) => tag.name), title }));
} else if (mode === "verify") {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.dataDir, config.dataDir);
  const paper = state.papers.find((item) => item.title === title);
  assert.ok(paper, "Create the synthetic paper through the browser first");
  assert.equal(paper.sourceUrl, journalUrl);
  assert.equal(paper.doi, "10.1080/01621459.2026.2674413");
  const selectedTags = state.relations
    .filter((item) => item.fromId === paper.id && item.toType === "tag" && item.purpose === "tag")
    .map((item) => state.tags.find((tag) => tag.id === item.toId).name).sort();
  assert.deepEqual(selectedTags, ["在线学习", "时间序列", "随机优化"].sort(), "Check editing, unchecking and a newly typed label");
  for (const tagId of report.baselineTagIds)
    assert.ok(state.tags.some((tag) => tag.id === tagId), "Existing label IDs must be reused and retained");
  assert.equal(state.tags.filter((tag) => tag.name === "随机优化").length, 1);
  assert.equal(state.tags.some((tag) => /不应保存|取消的标签/.test(tag.name)), false);
  for (const original of report.baselineNotes)
    assert.deepEqual(state.notes.find((note) => note.id === original.id), original);
  assert.equal(state.aiContents.length, 0);
  assert.equal(state.noteAssists.length, 0);
  const backup = Buffer.from(await (await request("/api/kb/backup")).arrayBuffer());
  // Full restore exercises actual schema and retains tag IDs/relations, in a fresh directory.
  const { restoreBackup } = await import("../src/lib/archive.ts");
  const { KBStore } = await import("../src/lib/db.ts");
  const restoreRoot = fs.mkdtempSync("/private/tmp/kb-tag-import-restore-");
  const restored = restoreBackup(backup, restoreRoot);
  const reopened = new KBStore(restored.restoredDirectory);
  try { assert.deepEqual(reopened.snapshot(), state); } finally { reopened.close(); }
  report.verification = {
    result: "passed", verifiedAtUTC: new Date().toISOString(), paperId: paper.id,
    selectedTags, existingTagIdsPreserved: true, baselineNotesUnchanged: true,
    cancelledLabelAbsent: true, fullBackupRoundtrip: true, backupSha256: sha(backup),
  };
  save(report);
  console.log(JSON.stringify(report.verification, null, 2));
} else {
  throw new Error("Usage: node --import tsx scripts/tag-import-smoke.mjs seed|verify");
}
