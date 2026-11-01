// Opt-in real Codex integration smoke. Uses synthetic content and a disposable
// library only. Runs two small model requests using the CLI's existing login.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
process.chdir(cwd);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-codex-http-"));
const port = process.env.KB_CODEX_SMOKE_PORT || "3112";
const base = `http://127.0.0.1:${port}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const steps = [];
const report = {
  timestamp: new Date().toISOString(),
  gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  workingTree: "Includes uncommitted local edition changes",
  provider: "codex",
  model: process.env.KB_CODEX_MODEL || "cli-default",
  input:
    "Synthetic PDF fixture and synthetic selected text; no user library content",
  steps,
  success: false,
};
let logs = "";
const child = spawn(process.execPath, ["scripts/serve.mjs", "start"], {
  cwd,
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PORT: port,
    KB_DATA_DIR: path.join(root, "data"),
    KB_AI_PROVIDER: "codex",
    NEXT_TELEMETRY_DISABLED: "1",
  },
});
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    logs = (logs + chunk).slice(-4000);
  });
async function json(route, options) {
  const response = await fetch(base + route, {
    ...options,
    signal: AbortSignal.timeout(240000),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
const post = (action, payload) =>
  json("/api/kb", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
const generate = (payload) =>
  json("/api/kb/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Test server exited (${child.exitCode})`);
    try {
      if (
        (await fetch(base + "/api/kb", { signal: AbortSignal.timeout(500) })).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await pause(200);
  }
  assert.ok(ready, "Temporary production server became ready");
  const config = await json("/api/kb/ai?check=codex");
  assert.equal(config.codexStatus?.authenticated, true);
  report.cliVersion = config.codexStatus.version;
  steps.push("Production HTTP CLI readiness and existing login detected");
  const created = await post("paper.create", {
    title: "CODEX HTTP TEST FIXTURE",
    abstract:
      "Synthetic connection test. This fixture reports no experimental results.",
  });
  const paper = created.result;
  const note = created.state.notes.find((item) => item.purpose === "paper");
  const noteBody = "个人笔记保持原文，绝不能被模型覆盖。";
  await post("note.update", {
    id: note.id,
    revision: note.revision,
    body: noteBody,
  });
  const form = new FormData();
  form.append("paperId", paper.id);
  form.append(
    "file",
    new Blob([fs.readFileSync("tests/fixtures/reading-fixture.pdf")], {
      type: "application/pdf",
    }),
    "synthetic.pdf",
  );
  const uploaded = await json("/api/kb/attachment", {
    method: "POST",
    body: form,
  });
  const attachment = uploaded.state.attachments.find(
    (item) => item.paperId === paper.id,
  );
  assert.ok(attachment);
  const summary = await generate({
    paperId: paper.id,
    attachmentId: attachment.id,
    kind: "summary",
  });
  assert.equal(summary.result.provider, "codex");
  assert.equal(summary.result.sourceScope, "full_text");
  assert.equal(summary.result.sourceAttachmentId, attachment.id);
  assert.ok(summary.result.sourcePageIndices.length > 0);
  assert.ok(summary.result.sourceText.includes("TEST FIXTURE"));
  assert.match(summary.result.body, /研究问题/);
  assert.equal(
    summary.state.notes.find((item) => item.id === note.id).body,
    noteBody,
  );
  steps.push(
    "Synthetic PDF -> local text extraction -> real Codex structured summary -> AIContent with attachment/pages/source snapshot",
  );
  const selection =
    "TEST FIXTURE: x squared is the square of x. This is synthetic, not a research result.";
  const explanation = await generate({
    paperId: paper.id,
    attachmentId: attachment.id,
    pageIndex: 1,
    kind: "explanation",
    selection,
  });
  assert.equal(explanation.result.sourceScope, "selection");
  assert.deepEqual(explanation.result.sourcePageIndices, [1]);
  assert.equal(explanation.result.sourceText, selection);
  assert.ok(explanation.result.body.trim());
  assert.equal(explanation.state.aiContents.length, 2);
  assert.equal(
    explanation.state.notes.find((item) => item.id === note.id).body,
    noteBody,
  );
  assert.ok(
    fs
      .readFileSync(path.join(root, "data", "notes", `${note.id}.md`), "utf8")
      .includes(noteBody),
  );
  steps.push(
    "Real Codex selected-text explanation saved separately; database and Markdown personal note unchanged",
  );
  report.success = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : "Smoke test failed";
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      process.platform === "win32"
        ? child.kill("SIGTERM")
        : process.kill(-child.pid, "SIGTERM");
    } catch {}
    await Promise.race([exited, pause(3000)]);
    if (child.exitCode === null) {
      try {
        process.platform === "win32"
          ? child.kill("SIGKILL")
          : process.kill(-child.pid, "SIGKILL");
      } catch {}
      await exited;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync(
    "test-results/codex-smoke.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
