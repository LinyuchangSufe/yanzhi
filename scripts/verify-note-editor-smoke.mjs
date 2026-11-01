// Complete the browser's synthetic note-editor acceptance flow over HTTP.
// Run: node --import tsx scripts/verify-note-editor-smoke.mjs
// This script never calls AI or writes into the running source library.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KBStore } from "../src/lib/db.ts";
import { inspectNoteImage, readNoteImage } from "../src/lib/note-images.ts";

const cwd = fileURLToPath(new URL("..", import.meta.url));
process.chdir(cwd);
const seed = JSON.parse(
  fs.readFileSync("test-results/note-editor-browser.json", "utf8"),
);
const endpoint = new URL(
  process.argv[2] ||
    process.env.KB_NOTE_EDITOR_BASE_URL ||
    seed.baseUrl ||
    "http://127.0.0.1:3115",
);
assert.equal(
  endpoint.protocol,
  "http:",
  "Only a local HTTP acceptance server is allowed",
);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname),
  "Refusing a non-loopback server",
);
assert.equal(
  endpoint.port,
  "3115",
  "Refusing any service other than the independent acceptance library on port 3115; never use the user library on port 3000",
);
assert.ok(
  !endpoint.username &&
    !endpoint.password &&
    endpoint.pathname === "/" &&
    !endpoint.search &&
    !endpoint.hash,
  "Supply a plain loopback origin",
);
assert.equal(
  endpoint.origin,
  new URL(seed.baseUrl).origin,
  "The seed report must belong to this exact acceptance origin",
);
assert.match(seed.fixturePolicy, /Synthetic/);
const sourceDirectory = fs.realpathSync(seed.testDataDirectory);
assert.match(
  sourceDirectory,
  /^\/(?:private\/)?tmp\/ailib-note-editor-browser-[^/]+$/,
  "Refusing a source data directory outside the named temporary acceptance library",
);
const fixturePath = path.resolve(seed.paths.imagePath);
assert.equal(
  path.dirname(fixturePath),
  path.join(cwd, "test-results"),
  "Only the checked-in acceptance fixture location is allowed",
);
const fixture = fs.readFileSync(fixturePath);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(sha256(fixture), seed.image.sha256);
assert.equal(fixture.length, seed.image.byteSize);
assert.deepEqual(inspectNoteImage(fixture), {
  mimeType: "image/png",
  width: seed.image.width,
  height: seed.image.height,
});
const base = endpoint.origin;
const startedAt = Date.now();
const steps = [];
const report = {
  startedAtUTC: new Date(startedAt).toISOString(),
  baseUrl: base,
  sourceDirectory,
  node: process.version,
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  workingTreeDirty: Boolean(
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  ),
  fixturePolicy: seed.fixturePolicy,
  ai: "disabled; no AI request or external HTTP request is made",
  config: {
    pollingDeadlineMs: 14000,
    pollingIntervalMs: 400,
    port: 3115,
    restorePolicy:
      "new sibling directory; original library is never overwritten",
  },
  ideaId: seed.ideaId,
  fixtureImage: seed.image,
  steps,
  result: "running",
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function response(route, options = {}, timeout = 20000) {
  assert.ok(route.startsWith("/api/kb") && !route.startsWith("//"));
  const result = await fetch(base + route, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
    headers: { Origin: base, ...options.headers },
  });
  if (!result.ok)
    throw new Error(`HTTP ${result.status}: ${await result.text()}`);
  return result;
}
async function json(route, options, timeout) {
  return (await response(route, options, timeout)).json();
}
async function bytes(route) {
  const result = await response(route);
  const reader = result.body?.getReader();
  assert.ok(reader, "Expected response body");
  const chunks = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > 16 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Synthetic acceptance response exceeds 16 MiB");
    }
    chunks.push(chunk.value);
  }
  return { response: result, buffer: Buffer.concat(chunks) };
}
const originalParagraph =
  "这是一段独立的中文阅读记录，用于验证笔记编辑器。原始段落应在插图、选择文献以及取消补录后完整保留。";
const uploadTyping = "上传期间新增文字：这段输入也必须保留。";
const cancelledTrigger = "[[TEST Cancelled Reference]]";
const cancelledTyping = "取消后继续编辑：新文字应保留。";
let extractionDirectory;
let restoredStore;
try {
  const pollingUntil = Date.now() + report.config.pollingDeadlineMs;
  let state;
  let note;
  while (true) {
    state = await json("/api/kb", undefined, 1200);
    assert.equal(
      state.settings.aiProvider,
      "none",
      "Acceptance library must have AI disabled",
    );
    assert.equal(
      state.aiContents.length,
      0,
      "No AI result may be generated in this check",
    );
    assert.ok(
      state.papers.length <= 10 &&
        state.papers.every((paper) => paper.title.startsWith("TEST")),
      "Refusing a library with non-synthetic paper data",
    );
    assert.ok(
      state.notes.length <= 20 &&
        state.notes.every((candidate) => candidate.title.startsWith("TEST")),
      "Refusing a library with non-synthetic notes",
    );
    assert.equal(
      state.papers.find((paper) => paper.id === seed.paperAId)?.title,
      "TEST · Online Learning with Dependent Data",
    );
    note = state.notes.find((candidate) => candidate.id === seed.ideaId);
    assert.equal(
      note?.title,
      "TEST · 阅读记录",
      "Original stable fixture note ID must exist",
    );
    if (
      [
        originalParagraph,
        uploadTyping,
        cancelledTrigger,
        cancelledTyping,
      ].every((text) => note.body.includes(text))
    )
      break;
    assert.ok(
      Date.now() < pollingUntil,
      "Browser edits did not finish saving within 14 seconds",
    );
    await pause(report.config.pollingIntervalMs);
  }
  const addedPaper = state.papers.find(
    (paper) => paper.title === "TEST · New Local Citation",
  );
  assert.ok(addedPaper, "Add-and-cite created paper must be in this library");
  const expectedReferences = [seed.paperAId, addedPaper.id].sort();
  for (const id of expectedReferences)
    assert.ok(note.body.includes(`kb://paper/${id}`));
  const references = state.relations.filter(
    (relation) =>
      relation.fromType === "note" &&
      relation.fromId === note.id &&
      relation.purpose === "reference",
  );
  assert.equal(
    references.length,
    2,
    "Only the existing and successfully added papers are cited",
  );
  assert.deepEqual(
    references
      .map((relation) => {
        assert.equal(relation.toType, "paper");
        return relation.toId;
      })
      .sort(),
    expectedReferences,
  );
  const cancelledPapers = state.papers.filter(
    (paper) => paper.title === "TEST Cancelled Reference",
  );
  for (const paper of cancelledPapers) {
    assert.ok(
      !note.body.includes(`kb://paper/${paper.id}`),
      "Cancelled late response must not insert a citation",
    );
    assert.ok(!references.some((reference) => reference.toId === paper.id));
  }
  steps.push(
    "Original paragraph, upload-time typing, existing citation, new citation, cancelled raw trigger and post-cancel typing are preserved; exactly two reference relations",
  );
  const imageLinks = [
    ...note.body.matchAll(
      /!\[[^\]]*\]\(\/api\/kb\/image\?id=([0-9a-f-]{36})\)/gi,
    ),
  ];
  assert.equal(
    imageLinks.length,
    1,
    "One actual uploaded fixture image must be embedded",
  );
  const imageId = imageLinks[0][1];
  const image = state.noteImages.find((candidate) => candidate.id === imageId);
  assert.ok(image);
  assert.equal(image.noteId, note.id);
  assert.equal(image.status, "available");
  for (const field of ["width", "height", "sha256", "byteSize"])
    assert.equal(
      image[field],
      seed.image[field],
      `Image ${field} must match the original fixture`,
    );
  const downloaded = await bytes(`/api/kb/image?id=${imageId}`);
  assert.equal(downloaded.response.headers.get("content-type"), "image/png");
  assert.equal(sha256(downloaded.buffer), seed.image.sha256);
  assert.equal(downloaded.buffer.compare(fixture), 0);
  assert.deepEqual(
    inspectNoteImage(downloaded.buffer),
    inspectNoteImage(fixture),
  );
  report.imageId = imageId;
  steps.push(
    "HTTP image GET returns exact original raster bytes, dimensions, MIME and SHA-256",
  );

  const bundle = await bytes(`/api/kb/export?format=bundle&noteId=${note.id}`);
  assert.equal(bundle.response.headers.get("content-type"), "application/gzip");
  extractionDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "kb-note-export-verify-"),
  );
  const archivePath = path.join(extractionDirectory, "notes.tar.gz");
  const unpacked = path.join(extractionDirectory, "unpacked");
  fs.mkdirSync(unpacked);
  fs.writeFileSync(archivePath, bundle.buffer);
  const names = execFileSync("/usr/bin/tar", ["-tzf", archivePath], {
    encoding: "utf8",
    timeout: 5000,
  })
    .trim()
    .split("\n");
  assert.deepEqual(
    names.sort(),
    ["README.md", `notes/${note.id}.md`, image.relativePath].sort(),
    "Single-note bundle must contain only this note, README and its referenced image",
  );
  const verbose = execFileSync("/usr/bin/tar", ["-tvzf", archivePath], {
    encoding: "utf8",
    timeout: 5000,
  })
    .trim()
    .split("\n");
  assert.ok(
    verbose.every((line) => line.startsWith("-")),
    "Export may contain only regular files",
  );
  execFileSync("/usr/bin/tar", ["-xzf", archivePath, "-C", unpacked], {
    timeout: 5000,
  });
  const exported = fs.readFileSync(
    path.join(unpacked, "notes", `${note.id}.md`),
    "utf8",
  );
  const expectedBody = note.body.replace(
    `/api/kb/image?id=${imageId}`,
    `../${image.relativePath}`,
  );
  assert.ok(
    exported.includes(expectedBody),
    "Export preserves the exact note body, changing only the image destination",
  );
  assert.equal(
    sha256(fs.readFileSync(path.join(unpacked, image.relativePath))),
    seed.image.sha256,
  );
  for (const other of state.notes.filter(
    (candidate) => candidate.id !== note.id && candidate.body.trim(),
  ))
    assert.ok(
      !exported.includes(other.body),
      "Other private note bodies must not be included",
    );
  report.bundle = {
    sha256: sha256(bundle.buffer),
    byteSize: bundle.buffer.length,
    entries: names,
    independentlyExtractedBy: "/usr/bin/tar",
  };
  steps.push(
    "HTTP single-note tar.gz independently listed and extracted by system tar; relative image link and bytes preserved; no other notes or AI files",
  );

  const backup = await bytes("/api/kb/backup");
  const form = new FormData();
  form.set(
    "file",
    new Blob([backup.buffer], { type: "application/gzip" }),
    "note-editor-smoke.kb.json.gz",
  );
  const restored = await json("/api/kb/backup", { method: "POST", body: form });
  const restoredDirectory = fs.realpathSync(restored.restoredDirectory);
  assert.notEqual(restoredDirectory, sourceDirectory);
  assert.equal(path.dirname(restoredDirectory), path.dirname(sourceDirectory));
  assert.match(path.basename(restoredDirectory), /^restored-\d+-[0-9a-f]{8}$/);
  report.restoredDirectory = restoredDirectory;
  report.restoreCommand = restored.restartCommand;
  // Only the newly restored fixture is opened; all checks after opening are reads.
  restoredStore = new KBStore(restoredDirectory);
  restoredStore.db.exec("PRAGMA query_only=ON");
  const restoredState = restoredStore.snapshot();
  assert.deepEqual(
    restoredState,
    state,
    "Full backup retains all stable IDs, notes, relationships, image metadata and settings",
  );
  const restoredNote = restoredState.notes.find(
    (candidate) => candidate.id === note.id,
  );
  assert.equal(restoredNote.body, note.body);
  assert.ok(restoredNote.body.includes(`/api/kb/image?id=${imageId}`));
  const restoredImage = readNoteImage(restoredStore, imageId);
  assert.equal(sha256(restoredImage.bytes), seed.image.sha256);
  assert.equal(restoredImage.bytes.compare(fixture), 0);
  assert.deepEqual(restoredImage.image, image);
  restoredStore.close();
  restoredStore = undefined;
  assert.deepEqual(
    await json("/api/kb"),
    state,
    "Backup and restore must not change the running source library",
  );
  report.backup = {
    sha256: sha256(backup.buffer),
    byteSize: backup.buffer.length,
    restoredCounts: restored.counts,
    keptForReproduction: true,
  };
  steps.push(
    "HTTP complete backup restored to a fresh sibling directory; KBStore query-only verification preserves original note/image IDs, URL, metadata, bytes and every relation; running original library unchanged",
  );
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  restoredStore?.close();
  if (extractionDirectory)
    fs.rmSync(extractionDirectory, { recursive: true, force: true });
  report.finishedAtUTC = new Date().toISOString();
  report.elapsedMs = Date.now() - startedAt;
  fs.writeFileSync(
    "test-results/note-editor-verify.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
