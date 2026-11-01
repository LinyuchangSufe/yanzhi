// Read-only-navigation browser acceptance fixture. Start the isolated service
// separately on port 3124 with KB_AI_PROVIDER=none and a fresh guarded directory.
// Run `node scripts/navigation-smoke.mjs seed`, exercise the browser flow, then
// `node scripts/navigation-smoke.mjs verify`. Never contacts the user library.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const base = "http://127.0.0.1:3124";
const reportPath = "test-results/navigation-smoke.json";
const mode = process.argv[2];
assert.ok(["seed", "inspect", "verify"].includes(mode), "Use seed|inspect|verify");
assert.equal(new URL(base).hostname, "127.0.0.1");
assert.equal(new URL(base).port, "3124");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
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
const config = await json("/api/kb/ai");
assert.equal(config.provider, "none", "Model calls must remain disabled");
assert.match(config.dataDir, /^\/private\/tmp\/kb-navigation-[A-Za-z0-9_-]+$/);
assert.equal(fs.realpathSync(config.dataDir), config.dataDir, "Refusing symlinks to another library");
const state = await json("/api/kb");
function save(report) {
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}
async function verifyFiles(snapshot) {
  for (const attachment of snapshot.attachments) {
    const filename = path.resolve(config.dataDir, attachment.relativePath);
    assert.ok(filename.startsWith(config.dataDir + path.sep));
    assert.equal(sha(fs.readFileSync(filename)), attachment.sha256, "Stored original PDF changed");
    const served = Buffer.from(await (await request(`/api/kb/attachment?id=${attachment.id}`)).arrayBuffer());
    assert.equal(sha(served), attachment.sha256, "Served original PDF changed");
  }
  for (const note of snapshot.notes) {
    const body = fs.readFileSync(path.join(config.dataDir, "notes", `${note.id}.md`), "utf8");
    assert.equal(body, `<!-- kb-note:${note.id} revision:${note.revision} purpose:${note.purpose} -->\n# ${note.title}\n\n${note.body}\n`, "Personal Markdown mirror changed");
  }
}
if (mode === "seed") {
  for (const [key, value] of Object.entries(state)) {
    if (Array.isArray(value)) assert.equal(value.length, 0, `Refusing nonempty fixture: ${key}`);
  }
  const first = await post("paper.create", {
    title: "TEST · 导航 A · 较早收藏", authors: ["Synthetic Fixture Author"], year: 2026,
    abstract: "原创软件验收资料，不是真实研究出版物。",
    tags: ["TEST · 导航标签 A"], readingStatus: "reading", inReadingList: true,
  });
  const firstPaper = first.result;
  const firstNote = first.state.notes[0];
  await post("note.update", {
    id: firstNote.id, revision: firstNote.revision,
    body: "# TEST · 导航不修改原稿\n\n独特短语：纸舟导航验收。\n\n我的公式 $x_t^2$、阅读状态和待阅读成员应保持原样。",
  });
  const secondPaper = (await post("paper.create", {
    title: "TEST · 导航 B · 中间收藏", tags: ["TEST · 导航标签 A"], readingStatus: "unread",
  })).result;
  const pdfPaper = (await post("paper.create", {
    title: "TEST · 导航 C · 最新收藏与三页 PDF", tags: ["TEST · 导航标签 B"], readingStatus: "read",
  })).result;
  assert.ok(firstPaper.createdAt < secondPaper.createdAt && secondPaper.createdAt < pdfPaper.createdAt,
    "Fixture must have distinct sequential creation timestamps");
  const pdf = fs.readFileSync("tests/fixtures/reading-fixture.pdf");
  const fixture = JSON.parse(fs.readFileSync("tests/fixtures/reading-fixture.json", "utf8"));
  assert.equal(fixture.physicalPages, 3);
  assert.equal(sha(pdf), fixture.sha256, "Use only the original synthetic fixture PDF");
  const form = new FormData();
  form.set("paperId", pdfPaper.id);
  form.set("file", new Blob([pdf], { type: "application/pdf" }), "TEST-navigation-original-three-pages.pdf");
  const attachment = (await json("/api/kb/attachment", { method: "POST", body: form })).result;
  const topic = (await post("topic.create", {
    title: "TEST · 导航研究问题", description: "原创软件验收：工具入口和资料筛选应各有明确作用。",
  })).result;
  await post("link.set", { fromType: "paper", fromId: firstPaper.id, toType: "topic", toId: topic.id });
  const idea = (await post("note.create", {
    title: "TEST · 导航我的想法", purpose: "idea", paperIds: [firstPaper.id], topicIds: [topic.id],
    body: `原创验收想法，禁止自动修改。\n\n[已有论文](kb://paper/${firstPaper.id})\n\n$\\alpha+\\beta$`,
  })).result;
  const baseline = await json("/api/kb");
  assert.equal(baseline.papers.length, 3);
  assert.deepEqual(baseline.readingPositions, [], "Open a no-PDF fixture to avoid creating reading positions");
  await verifyFiles(baseline);
  const report = {
    createdAtUTC: new Date().toISOString(), base, dataDir: config.dataDir,
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    policy: "Fixed loopback port 3124; guarded temporary directory; AI disabled; synthetic data only. Never contacts port 3000. Open the no-PDF A/B records for browser history checks, and leave C unopened to keep reading positions unchanged.",
    seed: null, ai: "disabled", firstPaperId: firstPaper.id, secondPaperId: secondPaper.id, pdfPaperId: pdfPaper.id,
    noteId: firstNote.id, attachmentId: attachment.id, topicId: topic.id, ideaId: idea.id,
    tagAId: baseline.tags.find((tag) => tag.name === "TEST · 导航标签 A").id,
    tagBId: baseline.tags.find((tag) => tag.name === "TEST · 导航标签 B").id,
    pdfSha256: sha(pdf), baseline, checks: [],
  };
  save(report);
  console.log(JSON.stringify({ result: "seeded", base, dataDir: config.dataDir,
    firstPaperId: firstPaper.id, secondPaperId: secondPaper.id, pdfPaperId: pdfPaper.id,
    expectedDefaultOrder: [pdfPaper.id, secondPaper.id, firstPaper.id],
    expectedAfterOpeningFirst: [firstPaper.id, pdfPaper.id, secondPaper.id],
    tagAId: report.tagAId, tagBId: report.tagBId }, null, 2));
} else {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.base, base);
  assert.equal(report.dataDir, config.dataDir, "Fixture changed since seeding");
  if (mode === "inspect") {
    console.log(JSON.stringify({ base, dataDir: config.dataDir, papers: state.papers,
      tags: state.tags, lastCheck: report.checks.at(-1) }, null, 2));
  } else {
    assert.deepEqual(state, report.baseline, "Navigation, sorting, filtering and opening tools must not modify any library record");
    await verifyFiles(state);
    const check = {
      stage: "verify", result: "passed", verifiedAtUTC: new Date().toISOString(),
      scopes: ["all library entities and settings exactly unchanged", "reading status and reading-list membership unchanged",
        "original stored and served PDF SHA-256 unchanged", "personal Markdown mirrors unchanged", "no reading positions created"],
      limit: "This script verifies persisted-data integrity. The browser separately verifies visible row order, filters, menus, tool return and localStorage history.",
    };
    report.checks.push(check);
    save(report);
    console.log(JSON.stringify(check, null, 2));
  }
}
