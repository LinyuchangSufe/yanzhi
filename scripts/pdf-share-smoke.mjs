// Isolated PDF-sharing acceptance. Start the production service separately on
// port 3125 with KB_AI_PROVIDER=none and a fresh /private/tmp/kb-pdf-share-* dir.
// `seed` writes synthetic fixtures only; `verify` never opens Finder. After the
// browser clicks the folder button once, `browser` verifies data integrity again.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const base = "http://127.0.0.1:3125";
const reportPath = "test-results/pdf-share-smoke.json";
const mode = process.argv[2];
assert.ok(["seed", "inspect", "verify", "browser"].includes(mode), "Use seed|inspect|verify|browser");
assert.equal(new URL(base).hostname, "127.0.0.1");
assert.equal(new URL(base).port, "3125");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function response(route, options = {}) {
  assert.ok(route.startsWith("/api/kb") && !route.startsWith("//"));
  return fetch(base + route, {
    ...options, redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { Origin: base, ...options.headers },
  });
}
async function json(route, options) {
  const result = await response(route, options);
  assert.equal(result.status, 200, await result.clone().text());
  return result.json();
}
const post = (action, payload) => json("/api/kb", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action, payload }),
});
const share = (payload = {}) => json("/api/kb/pdf-share", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ open: false, ...payload }),
});
const config = await json("/api/kb/ai");
assert.equal(config.provider, "none", "Model calls must remain disabled");
assert.match(config.dataDir, /^\/private\/tmp\/kb-pdf-share-[A-Za-z0-9_-]+$/);
assert.equal(fs.realpathSync(config.dataDir), config.dataDir, "Refusing symlinks to another library");
const state = await json("/api/kb");
function save(report) {
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}
function inside(relative) {
  const filename = path.resolve(config.dataDir, relative);
  assert.ok(filename.startsWith(config.dataDir + path.sep), "Fixture path escaped temporary library");
  return filename;
}
async function fixture(label) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Original software test fixture: ${label}`);
  pdf.setAuthor("Synthetic Fixture Author");
  pdf.setSubject("Original QA material; not an academic publication");
  const date = new Date("2026-10-29T00:00:00.000Z");
  pdf.setCreationDate(date); pdf.setModificationDate(date);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595.28, 841.89]);
  page.drawText("TEST - PDF sharing original fixture", { x: 50, y: 780, size: 18, font });
  page.drawText(label, { x: 50, y: 740, size: 12, font });
  page.drawText("This is synthetic software verification material, not a research result.", {
    x: 50, y: 700, size: 10, font,
  });
  return Buffer.from(await pdf.save());
}
async function upload(paperId, label, filename) {
  const bytes = await fixture(label);
  const form = new FormData();
  form.set("paperId", paperId);
  form.set("file", new Blob([bytes], { type: "application/pdf" }), filename);
  return (await json("/api/kb/attachment", { method: "POST", body: form })).result;
}
function markdownSnapshot() {
  const directory = inside("notes");
  return Object.fromEntries(fs.readdirSync(directory).filter((name) => name.endsWith(".md")).sort()
    .map((name) => [name, fs.readFileSync(path.join(directory, name), "utf8")]));
}
async function verifyOriginals(snapshot) {
  for (const attachment of snapshot.attachments) {
    if (attachment.status === "missing") {
      assert.equal(fs.existsSync(inside(attachment.relativePath)), false, "Missing fixture unexpectedly restored");
      continue;
    }
    assert.equal(sha(fs.readFileSync(inside(attachment.relativePath))), attachment.sha256, "Stored original PDF changed");
    const served = await response(`/api/kb/attachment?id=${attachment.id}`);
    assert.equal(served.status, 200);
    assert.equal(sha(Buffer.from(await served.arrayBuffer())), attachment.sha256, "Served original PDF changed");
  }
  for (const note of snapshot.notes) {
    assert.equal(fs.readFileSync(inside(`notes/${note.id}.md`), "utf8"),
      `<!-- kb-note:${note.id} revision:${note.revision} purpose:${note.purpose} -->\n# ${note.title}\n\n${note.body}\n`,
      "Personal Markdown mirror changed");
  }
}
function expectedAttachments(snapshot, paperId) {
  const active = new Set(snapshot.papers.filter((paper) => !paper.deletedAt && (!paperId || paper.id === paperId))
    .map((paper) => paper.id));
  return snapshot.attachments.filter((attachment) => active.has(attachment.paperId) && attachment.status === "available");
}
function verifyOutput(result, expected) {
  assert.equal(result.directory, inside("share/papers"));
  assert.equal(result.opened, false, "Script must never open Finder");
  assert.ok(Array.isArray(result.files));
  assert.deepEqual(result.files.map((file) => file.attachmentId).sort(), expected.map((item) => item.id).sort());
  assert.equal(new Set(result.files.map((file) => file.path)).size, expected.length, "Distinct PDFs must have distinct destinations");
  for (const file of result.files) {
    const source = expected.find((item) => item.id === file.attachmentId);
    assert.equal(file.paperId, source.paperId);
    assert.equal(path.dirname(file.path), result.directory);
    assert.equal(path.basename(file.path), file.filename);
    assert.ok(Buffer.byteLength(file.filename, "utf8") <= 220, "Filename exceeds sharing component limit");
    assert.match(file.filename, /\.pdf$/i);
    assert.match(file.filename, /2026/);
    assert.match(file.filename, /TEST Fixture Author/);
    assert.match(file.filename, /PDF 分享/);
    assert.doesNotMatch(file.filename, /[\x00-\x1f/\\]/);
    assert.equal(sha(fs.readFileSync(file.path)), source.sha256, "Share copy differs from its original PDF");
    assert.equal(fs.lstatSync(file.path).isSymbolicLink(), false);
  }
}
async function unchanged(report) {
  assert.deepEqual(await json("/api/kb"), report.baseline, "Sharing must not change any library entity, revision, status or relationship");
  assert.deepEqual(markdownSnapshot(), report.markdown, "Sharing changed a Markdown file");
  await verifyOriginals(report.baseline);
}
if (mode === "seed") {
  for (const [key, value] of Object.entries(state)) {
    if (Array.isArray(value)) assert.equal(value.length, 0, `Refusing nonempty fixture: ${key}`);
  }
  const a = await post("paper.create", {
    title: "TEST · PDF 分享 A / 原件与补充材料", authors: ["TEST Fixture Author"], year: 2026,
    abstract: "原创软件验收资料，不是真实研究出版物。", tags: ["TEST · PDF 分享"],
    readingStatus: "reading", inReadingList: true,
  });
  const aPaper = a.result;
  const aNote = a.state.notes.find((note) => note.purpose === "paper");
  assert.ok(aNote);
  await post("note.update", { id: aNote.id, revision: aNote.revision,
    body: "# TEST · 分享不能修改原稿\n\n独特短语：纸舟分享验收。\n\n我的公式 $x_t^2$、个人评论、引用和阅读进度均应保持。" });
  const aMain = await upload(aPaper.id, "Paper A main PDF", "3da2f085.pdf");
  const aSupplement = await upload(aPaper.id, "Paper A supplementary PDF with distinct bytes", "supplement.pdf");
  const bPaper = (await post("paper.create", {
    title: "TEST · PDF 分享 B : 不覆盖原件", authors: ["TEST Fixture Author"], year: 2026,
    tags: ["TEST · PDF 分享"], readingStatus: "read",
  })).result;
  const bMain = await upload(bPaper.id, "Paper B main PDF, original synthetic content", "f00bad.pdf");
  const bMissing = await upload(bPaper.id, "Paper B missing attachment, separate original PDF", "missing-supplement.pdf");
  fs.unlinkSync(inside(bMissing.relativePath));
  const noPdf = (await post("paper.create", {
    title: "TEST · PDF 分享 C · 尚无 PDF", authors: ["TEST Fixture Author"], year: 2026,
  })).result;
  const recycled = (await post("paper.create", {
    title: "TEST · PDF 分享 D · 回收站排除", authors: ["TEST Fixture Author"], year: 2026,
  })).result;
  const recycledAttachment = await upload(recycled.id, "Recycled paper, never share from all-library action", "recycled.pdf");
  await post("paper.trash", { id: recycled.id, revision: recycled.revision });
  const topic = (await post("topic.create", { title: "TEST · 分享与个人研究内容隔离" })).result;
  await post("link.set", { fromType: "paper", fromId: aPaper.id, toType: "topic", toId: topic.id });
  const idea = (await post("note.create", {
    title: "TEST · PDF 分享验收想法", purpose: "idea", paperIds: [aPaper.id, bPaper.id], topicIds: [topic.id],
    body: `只允许复制原论文，不应把个人笔记装进分享文件夹。\n\n[已有论文](kb://paper/${aPaper.id})\n\n$\\alpha+\\beta$`,
  })).result;
  const annotation = (await post("annotation.create", {
    paperId: aPaper.id, attachmentId: aMain.id, kind: "region", pageIndex: 0,
    rects: [{ x: 0.1, y: 0.4, width: 0.3, height: 0.1 }], comment: "TEST · 个人批注不会写入原 PDF",
  })).result;
  const baseline = await json("/api/kb");
  assert.equal(baseline.papers.length, 4);
  assert.equal(baseline.papers.filter((paper) => !paper.deletedAt).length, 3);
  assert.equal(expectedAttachments(baseline).length, 3);
  assert.deepEqual(baseline.readingPositions, []);
  await verifyOriginals(baseline);
  const report = {
    createdAtUTC: new Date().toISOString(), base, dataDir: config.dataDir,
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    policy: "Fixed loopback port 3125; guarded real temporary directory; AI disabled; independently authored synthetic PDFs. Never contacts port 3000. Script open=false. Browser should use the library folder action without opening a PDF, preserving reading positions.",
    seed: null, ai: "disabled", aPaperId: aPaper.id, bPaperId: bPaper.id, noPdfPaperId: noPdf.id,
    recycledPaperId: recycled.id, noteId: aNote.id, topicId: topic.id, ideaId: idea.id, annotationId: annotation.id,
    attachmentIds: [aMain.id, aSupplement.id, bMain.id], missingAttachmentId: bMissing.id,
    recycledAttachmentId: recycledAttachment.id, baseline, markdown: markdownSnapshot(), checks: [],
  };
  save(report);
  console.log(JSON.stringify({ result: "seeded", base, dataDir: config.dataDir,
    aPaperId: aPaper.id, bPaperId: bPaper.id, noPdfPaperId: noPdf.id,
    expectedAllAvailableFiles: 3, expectedAllMissingCount: 1 }, null, 2));
} else {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.base, base);
  assert.equal(report.dataDir, config.dataDir, "Fixture changed since seeding");
  if (mode === "inspect") {
    console.log(JSON.stringify({ base, dataDir: config.dataDir, papers: state.papers,
      lastCheck: report.checks.at(-1), shareDirectory: inside("share/papers") }, null, 2));
  } else if (mode === "browser") {
    await unchanged(report);
    const active = expectedAttachments(report.baseline);
    const result = await share();
    verifyOutput(result, active);
    assert.equal(result.missingCount, 1);
    const check = { stage: "browser", result: "passed", verifiedAtUTC: new Date().toISOString(),
      scopes: ["UI folder action leaves full snapshot unchanged", "all personal Markdown mirrors unchanged",
        "stored and served original PDFs unchanged", "copies remain separately named and byte-exact"],
      limit: "Finder launch and visible UI are observed separately by the parent browser run." };
    report.checks.push(check); save(report); console.log(JSON.stringify(check, null, 2));
  } else {
    await unchanged(report);
    const single = await share({ paperId: report.aPaperId });
    verifyOutput(single, expectedAttachments(report.baseline, report.aPaperId));
    assert.equal(single.missingCount, 0);
    assert.ok(single.files.every((file) => /附件/.test(file.filename)), "Multiple attachments need visible distinguishing suffixes");
    const all = await share();
    verifyOutput(all, expectedAttachments(report.baseline));
    assert.equal(all.missingCount, 1, "Count papers with no available PDF, not individual missing attachments");
    assert.ok(all.warning, "Partly missing attachments must be reported");
    const before = all.files.map((file) => [file.path, fs.statSync(file.path).mtimeMs]);
    const again = await share();
    verifyOutput(again, expectedAttachments(report.baseline));
    assert.deepEqual(again.files, all.files, "Unchanged copies should be reused at the same paths");
    assert.deepEqual(again.files.map((file) => [file.path, fs.statSync(file.path).mtimeMs]), before,
      "Reusing a copy should not rewrite its bytes");
    const empty = await share({ paperId: report.noPdfPaperId });
    verifyOutput(empty, []);
    assert.equal(empty.missingCount, 1);
    const defaultOpen = await json("/api/kb/pdf-share", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paperId: report.aPaperId }) });
    assert.equal(defaultOpen.opened, false, "Omitted open must default to false");
    const collision = all.files.find((file) => file.paperId === report.aPaperId);
    const collisionBytes = await fixture("Pre-existing differently authored PDF; collision must never overwrite");
    fs.writeFileSync(collision.path, collisionBytes);
    const collisionSha = sha(collisionBytes);
    const different = await share({ paperId: report.aPaperId });
    verifyOutput(different, expectedAttachments(report.baseline, report.aPaperId));
    assert.equal(sha(fs.readFileSync(collision.path)), collisionSha, "An unrelated same-named file was overwritten");
    assert.notEqual(different.files.find((file) => file.attachmentId === collision.attachmentId).path, collision.path,
      "A different existing file needs a new destination path");
    const security = [];
    async function rejected(label, status, body, headers = { "Content-Type": "application/json" }) {
      const result = await response("/api/kb/pdf-share", {
        method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body),
      });
      assert.equal(result.status, status, `${label}: ${await result.text()}`);
      security.push({ label, status });
    }
    await rejected("Cross-origin request", 403, {}, { Origin: "https://example.org", "Content-Type": "application/json" });
    await rejected("Sec-Fetch-Site cross-site", 403, {}, { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" });
    await rejected("No explicit same-origin evidence", 403, {}, { Origin: "", "Content-Type": "application/json" });
    await rejected("Invalid UUID", 400, { paperId: "../../other.pdf" });
    await rejected("Invalid open type", 400, { open: "true" });
    await rejected("Unexpected path parameter", 400, { directory: "/private/tmp/unapproved" });
    await rejected("Malformed JSON", 400, "{invalid");
    await rejected("Wrong content type", 415, {}, { "Content-Type": "text/plain" });
    await rejected("Unknown paper", 404, { paperId: randomUUID() });
    await rejected("Recycled paper", 409, { paperId: report.recycledPaperId });
    await unchanged(report);
    const final = await share();
    verifyOutput(final, expectedAttachments(report.baseline));
    assert.equal(final.missingCount, 1);
    assert.ok(fs.readdirSync(final.directory).every((filename) => filename.endsWith(".pdf")),
      "Share directory must not include personal notes, database files or metadata exports");
    const check = { stage: "verify", result: "passed", verifiedAtUTC: new Date().toISOString(),
      scopes: ["one paper with multiple distinct attachments", "active available PDFs only; recycled excluded",
        "readable metadata filenames", "same-SHA copies reused without rewriting", "different same-named content never overwritten",
        "no-PDF and partially missing attachments reported", "default open=false; no Finder launch from script",
        "full library snapshot and personal Markdown exactly unchanged", "original stored and served PDF SHA-256 unchanged"],
      security, finalFiles: final.files, collisionPreserved: { path: collision.path, sha256: collisionSha },
      limit: "This script does not test successful Finder launch; browser and OS observation cover that action separately." };
    report.checks.push(check); save(report); console.log(JSON.stringify(check, null, 2));
  }
}
