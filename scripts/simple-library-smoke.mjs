// Staged acceptance for a library with optional reading-list membership only.
// Start an isolated service separately on 3126 with KB_AI_PROVIDER=none and a
// fresh /private/tmp/kb-simple-library-* directory. This never contacts 3000.
// Seed, exercise add/remove in the browser, then verify the persisted records.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const base = "http://127.0.0.1:3126";
const reportPath = "test-results/simple-library-smoke.json";
const stage = process.argv[2];
assert.ok(["seed", "inspect", "added", "removed", "arm-conflict", "verify"].includes(stage),
  "Use seed|inspect|added|removed|arm-conflict|verify");
assert.equal(new URL(base).hostname, "127.0.0.1");
assert.equal(new URL(base).port, "3126");
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function request(route, options = {}, expectedStatus = 200) {
  assert.ok(route.startsWith("/api/kb") && !route.startsWith("//"));
  const response = await fetch(base + route, {
    ...options, redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { Origin: base, ...options.headers },
  });
  assert.equal(response.status, expectedStatus, await response.clone().text());
  return response;
}
const json = async (route, options, status) => (await request(route, options, status)).json();
const post = (action, payload, status) => json("/api/kb", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action, payload }),
}, status);
const config = await json("/api/kb/ai");
assert.equal(config.provider, "none", "AI and model invocations must remain disabled");
assert.match(config.dataDir, /^\/private\/tmp\/kb-simple-library-[A-Za-z0-9_-]+$/);
assert.equal(fs.realpathSync(config.dataDir), config.dataDir, "Refusing a symlink to another library");
const state = await json("/api/kb");
function save(report) {
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}
const byId = (papers, id) => {
  const paper = papers.find((item) => item.id === id);
  assert.ok(paper, `Missing fixture paper ${id}`);
  return paper;
};
const queueIds = (snapshot) => snapshot.papers
  .filter((paper) => !paper.deletedAt && paper.inReadingList).map((paper) => paper.id).sort();
async function verifyFiles(snapshot) {
  for (const attachment of snapshot.attachments) {
    const filename = path.resolve(config.dataDir, attachment.relativePath);
    assert.ok(filename.startsWith(config.dataDir + path.sep));
    assert.equal(fs.realpathSync(filename), filename, "Refusing a symlinked attachment");
    assert.equal(sha(fs.readFileSync(filename)), attachment.sha256, "Original PDF bytes changed");
    const served = Buffer.from(await (await request(`/api/kb/attachment?id=${attachment.id}`)).arrayBuffer());
    assert.equal(sha(served), attachment.sha256, "Served PDF differs from its original");
  }
  for (const note of snapshot.notes) {
    const filename = path.join(config.dataDir, "notes", `${note.id}.md`);
    assert.equal(fs.realpathSync(filename), filename, "Refusing a symlinked note");
    assert.equal(fs.readFileSync(filename, "utf8"),
      `<!-- kb-note:${note.id} revision:${note.revision} purpose:${note.purpose} -->\n# ${note.title}\n\n${note.body}\n`,
      "Personal Markdown mirror changed");
  }
}
function verifyOnlyMembershipChanges(before, after, changedIds, revisionDelta = 1) {
  assert.equal(after.papers.length, 3, "Reading-list controls must neither add nor delete papers");
  const changes = new Set(changedIds);
  const expected = structuredClone(before);
  for (const paper of expected.papers) {
    const current = byId(after.papers, paper.id);
    if (changes.has(paper.id)) {
      assert.equal(current.revision, paper.revision + revisionDelta,
        "Only the selected row should receive the expected revision increment");
      assert.ok(current.updatedAt > paper.updatedAt, "Selected row must receive a newer timestamp");
      paper.inReadingList = current.inReadingList;
      paper.revision = current.revision;
      paper.updatedAt = current.updatedAt;
    }
  }
  // snapshot() orders papers by updatedAt, so a legitimate membership write can
  // reorder the array. Compare exact records by ID; row sorting is a UI check.
  const actual = { ...after, papers: [...after.papers].sort((a, b) => a.id.localeCompare(b.id)) };
  expected.papers.sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(actual, expected,
    "Unexpected change: metadata, historical readingStatus, private notes, annotations, relations, attachments and all other entities must remain exact");
}
function pass(report, name, extra = {}) {
  report.checks.push({ stage: name, result: "passed", verifiedAtUTC: new Date().toISOString(), ...extra });
  save(report);
  console.log(JSON.stringify(report.checks.at(-1), null, 2));
}

if (stage === "seed") {
  for (const [key, value] of Object.entries(state)) {
    if (Array.isArray(value)) assert.equal(value.length, 0, `Refusing a nonempty fixture: ${key}`);
  }
  const first = await post("paper.create", {
    title: "TEST · 简洁文献 A · 保留历史状态与私人原稿", authors: ["Synthetic Fixture Author"],
    year: 2026, abstract: "原创软件验收资料，不是真实研究出版物。",
    tags: ["TEST · 简洁文献"], readingStatus: "read", inReadingList: false,
  });
  const paperA = first.result;
  const note = first.state.notes[0];
  await post("note.update", {
    id: note.id, revision: note.revision,
    body: "# TEST · 我的私人原稿\n\n独特短语：纸舟简洁文献验收。\n\n只修改待阅读成员，不修改我的批注、原稿及历史字段。\n\n$\\alpha + \\beta = 1$",
  });
  const paperB = (await post("paper.create", {
    title: "TEST · 简洁文献 B · 原有待阅读", readingStatus: "reading", inReadingList: true,
    tags: ["TEST · 简洁文献"],
  })).result;
  const paperC = (await post("paper.create", {
    title: "TEST · 简洁文献 C · 未加入计划", readingStatus: "unread", inReadingList: false,
  })).result;
  const pdf = fs.readFileSync("tests/fixtures/reading-fixture.pdf");
  const fixture = JSON.parse(fs.readFileSync("tests/fixtures/reading-fixture.json", "utf8"));
  assert.equal(fixture.kind, "synthetic-test-fixture");
  assert.equal(fixture.physicalPages, 3);
  assert.equal(sha(pdf), fixture.sha256, "Use only the original synthetic three-page PDF");
  const form = new FormData();
  form.set("paperId", paperA.id);
  form.set("file", new Blob([pdf], { type: "application/pdf" }), "TEST-simple-library-original.pdf");
  const attachment = (await json("/api/kb/attachment", { method: "POST", body: form })).result;
  const annotation = (await post("annotation.create", {
    paperId: paperA.id, attachmentId: attachment.id, kind: "region", pageIndex: 0,
    rects: [{ x: 0.1, y: 0.4, width: 0.3, height: 0.1 }],
    comment: "TEST · 待阅读成员的改变不得改动这条私人批注",
  })).result;
  const topic = (await post("topic.create", {
    title: "TEST · 简洁文献研究问题", description: "资料收藏与阅读计划分别管理。",
  })).result;
  await post("link.set", { fromType: "paper", fromId: paperA.id, toType: "topic", toId: topic.id });
  const idea = (await post("note.create", {
    title: "TEST · 简洁文献想法", purpose: "idea", paperIds: [paperA.id], topicIds: [topic.id],
    body: `原创验收想法。\n\n[已有文献](kb://paper/${paperA.id})\n\n[私人批注](kb://annotation/${annotation.id})`,
  })).result;
  const baseline = await json("/api/kb");
  assert.deepEqual(queueIds(baseline), [paperB.id]);
  assert.deepEqual(baseline.papers.map((paper) => paper.readingStatus).sort(), ["read", "reading", "unread"]);
  assert.deepEqual(baseline.readingPositions, [], "Do not open A's PDF during the list-only acceptance");
  await verifyFiles(baseline);
  const report = {
    createdAtUTC: new Date().toISOString(), base, dataDir: config.dataDir,
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    policy: "Fixed loopback port 3126; realpath-guarded empty temporary directory; AI disabled; synthetic records and original fixture PDF only. Never contacts port 3000. Browser checks use list selections and menus, not PDF reading.",
    seed: null, ai: "disabled", paperAId: paperA.id, paperBId: paperB.id, paperCId: paperC.id,
    noteId: note.id, attachmentId: attachment.id, annotationId: annotation.id, topicId: topic.id, ideaId: idea.id,
    pdfSha256: sha(pdf), baseline, checkpoint: baseline, checks: [],
  };
  pass(report, "seed", { queueIds: [paperB.id] });
  console.log(JSON.stringify({ base, dataDir: config.dataDir, paperAId: paperA.id, paperBId: paperB.id, paperCId: paperC.id }, null, 2));
} else {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.base, base);
  assert.equal(report.dataDir, config.dataDir, "Refusing a different fixture from the seeded library");
  if (stage === "inspect") {
    console.log(JSON.stringify({ base, dataDir: config.dataDir, papers: state.papers,
      queueIds: queueIds(state), lastStage: report.checks.at(-1)?.stage }, null, 2));
  } else if (stage === "arm-conflict") {
    assert.equal(report.checks.at(-1)?.stage, "removed", "Arm the conflict after normal add/remove acceptance");
    assert.deepEqual(state, report.checkpoint, "No unrecorded changes may precede conflict preparation");
    // Load C in the browser before this step. Two membership writes restore its
    // exact membership while making the browser's old revision deliberately stale.
    const before = byId(state.papers, report.paperCId);
    assert.equal(before.inReadingList, false);
    const added = await post("paper.reading-list", {
      papers: [{ id: before.id, revision: before.revision }], operation: "add",
    });
    const intermediate = byId(added.state.papers, before.id);
    await post("paper.reading-list", {
      papers: [{ id: before.id, revision: intermediate.revision }], operation: "remove",
    });
    const current = await json("/api/kb");
    verifyOnlyMembershipChanges(state, current, [before.id], 2);
    assert.deepEqual(queueIds(current), [report.paperBId]);
    assert.equal(byId(current.papers, before.id).inReadingList, false);
    await verifyFiles(current);
    report.conflict = { paperId: before.id, staleRevision: before.revision,
      currentRevision: byId(current.papers, before.id).revision };
    report.checkpoint = current;
    pass(report, stage, { conflict: report.conflict,
      next: "Without reloading the old browser list, select C and add it. Its 409 error should remain visible after more than five seconds. Then run verify." });
  } else if (stage === "verify") {
    assert.ok(["removed", "arm-conflict"].includes(report.checks.at(-1)?.stage));
    assert.deepEqual(state, report.checkpoint, "Waiting, stale requests and refresh must not mutate any record");
    assert.deepEqual(queueIds(state), [report.paperBId]);
    if (report.conflict) {
      const result = await post("paper.reading-list", {
        papers: [{ id: report.conflict.paperId, revision: report.conflict.staleRevision }], operation: "add",
      }, 409);
      assert.match(result.error, /其他窗口更新/);
      assert.deepEqual(await json("/api/kb"), state, "A rejected stale action must not partially save anything");
    }
    await verifyFiles(state);
    pass(report, stage, { scopes: ["Exactly three original papers remain", "Only B remains in the reading list",
      "Historical read/reading/unread fields remain exactly unchanged", "Private Markdown, annotations, relationships and all other state unchanged",
      "Stored and HTTP-served original PDF SHA-256 unchanged", ...(report.conflict ? ["Stale revision rejected with 409 and zero partial writes"] : [])],
      limit: "Persisted-data checks only. Browser observation separately verifies hidden reading-state UI, absence of duplicate menu actions, success-toast timing and persistent error visibility." });
  } else {
    const expectedPrevious = stage === "added" ? "seed" : "added";
    assert.equal(report.checks.at(-1)?.stage, expectedPrevious, "Run added then removed after their browser actions");
    verifyOnlyMembershipChanges(report.checkpoint, state, [report.paperAId]);
    assert.deepEqual(queueIds(state), (stage === "added" ? [report.paperAId, report.paperBId] : [report.paperBId]).sort());
    assert.equal(byId(state.papers, report.paperAId).inReadingList, stage === "added");
    await verifyFiles(state);
    report.checkpoint = state;
    pass(report, stage, { queueIds: queueIds(state) });
  }
}
