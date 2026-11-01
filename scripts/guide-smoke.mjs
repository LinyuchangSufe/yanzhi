// Opt-in real-model integration check. Only original, clearly synthetic math
// fixtures enter the model; no user library, paper, note, or credential is read.
// Requires an existing production build and the CLI's existing login.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { findUniqueQuote } from "../src/lib/guide/anchors.ts";

const cwd = fileURLToPath(new URL("..", import.meta.url));
process.chdir(cwd);
const port = Number(process.env.KB_GUIDE_SMOKE_PORT || 3113);
assert.ok(
  Number.isInteger(port) && port > 0 && port < 65536,
  "Invalid smoke-test port",
);
const base = `http://127.0.0.1:${port}`;
const keep = process.env.KB_GUIDE_KEEP_TEST_DATA === "1";
const model = process.env.KB_CODEX_MODEL || "gpt-6.1-sol";
const retainedParent = path.join(cwd, "test-results", "guide-browser-library");
if (keep) fs.mkdirSync(retainedParent, { recursive: true });
// mkdtemp always creates a fresh child. Existing retained libraries are never removed.
const root = fs.mkdtempSync(
  keep
    ? path.join(
        retainedParent,
        `run-${new Date().toISOString().replace(/[:.]/g, "-")}-`,
      )
    : path.join(os.tmpdir(), "kb-guide-http-"),
);
const dataDir = path.join(root, "data");
const startedAt = Date.now();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  startedAtUTC: new Date(startedAt).toISOString(),
  node: process.version,
  gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  workingTreeDirty: Boolean(
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  ),
  provider: "codex",
  requestedModel: model,
  input:
    "Two original synthetic scalar-quadratic mathematical notes and one original induction supplement; no real papers, experimental results, or external citations",
  fixtureGeneration:
    "Deterministic text and fixed PDF metadata date; no random experiment or seed",
  config: {
    port,
    jobTimeoutMs: 360000,
    pollIntervalMs: 1000,
    pollTimeoutMs: 1000,
    automaticModelRetries: 0,
    modelGenerationSeed: null,
    modelOutputMayVary: true,
  },
  steps: [],
  timingsMs: {},
  success: false,
};
let child,
  logs = "",
  activeJob,
  interrupted;
process.once("SIGINT", () => {
  interrupted = "SIGINT";
});
process.once("SIGTERM", () => {
  interrupted = "SIGTERM";
});

async function assertFreePort() {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}
async function json(route, options = {}, timeoutMs = 10000) {
  const response = await fetch(base + route, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
}
const post = (action, payload) =>
  json("/api/kb", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
const guideAction = (payload) =>
  json("/api/kb/guide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
async function startServer() {
  await assertFreePort();
  child = spawn(process.execPath, ["scripts/serve.mjs", "start"], {
    cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      KB_DATA_DIR: dataDir,
      KB_AI_PROVIDER: "codex",
      KB_CODEX_MODEL: model,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      logs = (logs + chunk).slice(-5000);
    });
  child.once("error", (error) => {
    logs = String(error);
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
    if (child.exitCode !== null)
      throw new Error(`Temporary server exited (${child.exitCode}): ${logs}`);
    try {
      if (
        (await fetch(base + "/api/kb", { signal: AbortSignal.timeout(500) })).ok
      ) {
        const configuration = await json("/api/kb/ai");
        assert.equal(
          path.resolve(configuration.dataDir),
          path.resolve(dataDir),
          "Only use this fresh disposable library",
        );
        assert.equal((await json("/api/kb")).papers.length, 0);
        return;
      }
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
    }
    await pause(200);
  }
  throw new Error(`Temporary production server did not become ready: ${logs}`);
}
async function stopServer() {
  if (!child || child.exitCode !== null || !child.pid) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const stop = (signal) => {
    try {
      process.platform === "win32"
        ? child.kill(signal)
        : process.kill(-child.pid, signal);
    } catch {}
  };
  stop("SIGTERM");
  await Promise.race([exited, pause(3000)]);
  if (child.exitCode === null) {
    stop("SIGKILL");
    await Promise.race([exited, pause(3000)]);
  }
}
async function cancelActiveJob() {
  if (!activeJob || !child || child.exitCode !== null) return;
  try {
    await guideAction({ action: "cancel", jobId: activeJob.id });
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const { jobs } = await json(
        `/api/kb/guide?paperId=${activeJob.paperId}`,
        {},
        1000,
      );
      if (
        !["queued", "running"].includes(
          jobs.find((job) => job.id === activeJob.id)?.status,
        )
      )
        break;
      await pause(200);
    }
  } catch {
    /* The test server may already have exited. */
  }
}
function wrap(text, width = 88) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}
async function makePDF(filename, title, paragraphs) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.setTitle(title);
  document.setAuthor("Original synthetic software-test fixture");
  document.setProducer("AIlib reproducible guide smoke");
  document.setCreator("AIlib guide-smoke.mjs");
  document.setCreationDate(new Date("2026-01-01T00:00:00.000Z"));
  document.setModificationDate(new Date("2026-01-01T00:00:00.000Z"));
  const page = document.addPage([612, 792]);
  const drawn = [];
  let y = 747;
  for (const line of wrap(title, 65)) {
    page.drawText(line, {
      x: 42,
      y,
      size: 15,
      font,
      color: rgb(0.12, 0.2, 0.15),
    });
    drawn.push(line);
    y -= 21;
  }
  y -= 8;
  for (const paragraph of paragraphs) {
    for (const line of wrap(paragraph)) {
      assert.ok(y > 42, "Fixture must remain one short text page");
      assert.match(
        line,
        /^[\x20-\x7e]+$/,
        "Fixture PDF text is intentionally ASCII",
      );
      page.drawText(line, { x: 42, y, size: 10, font });
      drawn.push(line);
      y -= 15;
    }
    y -= 9;
  }
  const bytes = await document.save();
  fs.mkdirSync(path.join(root, "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(root, "fixtures", filename), bytes);
  return { filename, bytes, sha256: sha256(bytes), pages: [drawn.join("\n")] };
}
async function upload(paperId, fixture) {
  const form = new FormData();
  form.set("paperId", paperId);
  form.set(
    "file",
    new Blob([fixture.bytes], { type: "application/pdf" }),
    fixture.filename,
  );
  const { result } = await json("/api/kb/attachment", {
    method: "POST",
    body: form,
  });
  assert.equal(result.sha256, fixture.sha256);
  return result;
}
async function waitForJob(job) {
  activeJob = job;
  let previous = "";
  const deadline = Date.now() + 360000;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
    const { jobs } = await json(
      `/api/kb/guide?paperId=${job.paperId}`,
      {},
      1000,
    );
    const current = jobs.find((item) => item.id === job.id);
    assert.ok(current, "Started job remains available");
    const progress = `${current.mode}: ${current.status} ${current.completedChunks}/${current.totalChunks} ${current.message}`;
    if (progress !== previous) {
      console.log(progress);
      previous = progress;
    }
    if (current.status === "completed") {
      activeJob = undefined;
      return current;
    }
    if (current.status === "failed" || current.status === "cancelled") {
      activeJob = undefined;
      throw new Error(
        `No automatic retry: ${current.status}: ${current.error || current.message}`,
      );
    }
    await pause(1000);
  }
  throw new Error(
    "Guide job exceeded six minutes; it will be cancelled without an automatic model retry",
  );
}
function verifyReport(result, mode, expectedAttachments, fixtures) {
  assert.equal(result.kind, mode);
  assert.equal(result.provider, "codex");
  const data = result.guideData;
  assert.equal(data.mode, mode);
  assert.ok(data.overview.trim());
  assert.ok(data.sections.length);
  assert.deepEqual(
    new Set(data.sources.map((item) => item.attachmentId)),
    new Set(expectedAttachments.map((item) => item.id)),
  );
  assert.deepEqual(
    new Set(data.paperIds),
    new Set(expectedAttachments.map((item) => item.paperId)),
  );
  assert.ok(data.evidence.length > 0);
  for (const source of data.sources) {
    const attachment = expectedAttachments.find(
      (item) => item.id === source.attachmentId,
    );
    assert.equal(source.attachmentSha256, attachment.sha256);
    assert.equal(source.paperId, attachment.paperId);
    assert.equal(source.pageCount, 1);
    assert.deepEqual(source.parsedPages, [0]);
    assert.deepEqual(source.emptyPages, []);
  }
  for (const evidence of data.evidence) {
    const fixture = fixtures.get(evidence.attachmentId),
      attachment = expectedAttachments.find(
        (item) => item.id === evidence.attachmentId,
      );
    assert.ok(
      fixture && attachment,
      "Evidence only refers to selected synthetic PDFs",
    );
    assert.equal(evidence.paperId, attachment.paperId);
    assert.equal(evidence.attachmentSha256, fixture.sha256);
    assert.equal(evidence.pageIndex, 0);
    assert.equal(
      findUniqueQuote(fixture.pages[evidence.pageIndex], evidence.quote).status,
      "matched",
      "Every saved quote exists uniquely in its original generated PDF text",
    );
    assert.equal(evidence.matched, true);
  }
  for (const paperId of data.paperIds)
    assert.ok(data.evidence.some((item) => item.paperId === paperId));
  for (const id of [
    ...data.readingOrder,
    ...data.sections.flatMap((section) => section.evidenceIds),
  ])
    assert.ok(
      data.evidence.some((item) => item.id === id),
      "Every final report reference resolves to retained evidence",
    );
  if (mode === "comparison")
    for (const section of data.sections) {
      if (section.basis === "author" || section.basis === "analysis")
        assert.ok(
          new Set(
            section.evidenceIds.map(
              (id) => data.evidence.find((item) => item.id === id)?.paperId,
            ),
          ).size >= 2,
        );
    }
  return {
    sources: data.sources.length,
    evidence: data.evidence.length,
    matchedEvidence: data.evidence.filter((item) => item.matched).length,
    sections: data.sections.length,
    readingSteps: data.readingOrder.length,
    warnings: data.warnings.length,
    actualModel: result.model,
  };
}
function assertNotesUnchanged(state, expected, mirrors) {
  assert.deepEqual(state.notes, expected);
  for (const note of expected)
    assert.equal(
      fs.readFileSync(path.join(dataDir, "notes", `${note.id}.md`), "utf8"),
      mirrors.get(note.id),
    );
}

try {
  await startServer();
  const configuration = await json("/api/kb/ai?check=codex");
  assert.equal(
    configuration.codexStatus?.authenticated,
    true,
    "Existing CLI login is required; this script never logs in",
  );
  report.cliVersion = configuration.codexStatus.version;
  report.steps.push(
    "Fresh production HTTP server and existing CLI authentication verified without invoking a model",
  );
  const main = await makePDF(
    "synthetic-quadratic-a.pdf",
    "SYNTHETIC MATHEMATICAL NOTE A",
    [
      "Research problem. This original synthetic software-test note studies convergence of scalar gradient descent for f(x)=x^2/2. It is a toy derivation, not a research publication or experimental finding.",
      "Method. Start at any real x_0 and apply x_(t+1)=x_t-eta*x_t. The gradient is f'(x)=x. Each update therefore multiplies the current iterate by 1-eta.",
      "Assumptions. The step size eta is constant and satisfies 0<eta<2. The index t is a nonnegative integer. There is no sampling noise or data distribution in this example.",
      "Theorem A. For every t, x_t=(1-eta)^t*x_0 and f(x_t)=(1-eta)^(2t)*f(x_0). Because |1-eta|<1, the iterates converge to the minimizer zero.",
      "Proof location. The accompanying Supplement A proves the formula by induction and then derives the objective-value identity. The main text states the result but does not replace that argument.",
      "Limitations. This note treats a single scalar quadratic, not general nonlinear objectives, stochastic gradients, or dependent observations. No numerical experiment or external benchmark is reported. No novelty claim or external citation is made.",
    ],
  );
  const supplement = await makePDF(
    "synthetic-supplement-a.pdf",
    "SYNTHETIC SUPPLEMENT A: INDUCTION PROOF",
    [
      "Purpose. This original synthetic supplement belongs to Mathematical Note A. It supplies the elementary proof of Theorem A for the update x_(t+1)=(1-eta)*x_t.",
      "Base case. At t=0 the formula x_0=(1-eta)^0*x_0 holds because any nonzero base to the zero power equals one; the t=0 identity is taken directly as x_0=x_0 also when eta=1.",
      "Inductive step. Suppose x_t=(1-eta)^t*x_0. Substitution into the update gives x_(t+1)=(1-eta)*(1-eta)^t*x_0=(1-eta)^(t+1)*x_0. This closes the induction.",
      "Objective value. Squaring the iterate formula and dividing by two gives f(x_t)=(1-eta)^(2t)*f(x_0). For 0<eta<2 the multiplier has absolute value below one, so both the iterate and objective gap converge to zero.",
      "Boundary and scope. At eta=2 a nonzero starting iterate alternates sign and does not converge. At eta=0 it stays fixed. This is a toy algebraic verification, with no experiment, external reference, or claim about general optimization problems.",
    ],
  );
  const second = await makePDF(
    "synthetic-quadratic-b.pdf",
    "SYNTHETIC MATHEMATICAL NOTE B",
    [
      "Research problem. This original synthetic software-test note studies how known positive curvature lambda changes scalar gradient descent on g(x)=lambda*x^2/2. It extends the toy setting of Note A algebraically, without any research novelty claim.",
      "Method and assumptions. Let lambda>0 be a fixed known real number. The gradient is g'(x)=lambda*x. Use a constant step size with 0<eta<2/lambda and update x_(t+1)=(1-eta*lambda)*x_t.",
      "Theorem B. Repeated substitution or induction yields x_t=(1-eta*lambda)^t*x_0 and g(x_t)=(1-eta*lambda)^(2t)*g(x_0). The stated step-size condition makes the absolute contraction factor less than one.",
      "Relation to Note A. Setting lambda=1 recovers Note A exactly. The stability interval depends on lambda, so two contraction rates cannot be compared without first fixing curvature and step size. Choosing eta=1/lambda reaches zero in one update in this scalar toy model.",
      "Proof technique and limitations. The proof uses the same induction and squaring technique as Note A. The result assumes a scalar quadratic with known curvature and says nothing about noisy gradients, unknown curvature, or nonlinear objectives. There are no empirical data, benchmark comparisons, external citations, or experimental results.",
    ],
  );
  report.fixtures = [main, supplement, second].map((item) => ({
    filename: item.filename,
    sha256: item.sha256,
    pages: item.pages.length,
    characters: item.pages.reduce((count, text) => count + text.length, 0),
  }));
  const firstCreated = await post("paper.create", {
    title: "Synthetic Note A: scalar quadratic descent",
    abstract:
      "Original toy mathematical software-test fixture, not a research claim.",
    tags: ["synthetic-guide-smoke"],
  });
  const firstPaper = firstCreated.result;
  const secondPaper = (
    await post("paper.create", {
      title: "Synthetic Note B: curvature-scaled descent",
      abstract:
        "Original toy mathematical software-test fixture, not a research claim.",
      tags: ["synthetic-guide-smoke"],
    })
  ).result;
  const mainAttachment = await upload(firstPaper.id, main);
  const supplementAttachment = await upload(firstPaper.id, supplement);
  const secondAttachment = await upload(secondPaper.id, second);
  const fixtureMap = new Map([
    [mainAttachment.id, main],
    [supplementAttachment.id, supplement],
    [secondAttachment.id, second],
  ]);
  for (const note of (await json("/api/kb")).notes)
    await post("note.update", {
      id: note.id,
      revision: note.revision,
      body: `Private synthetic test note ${note.id}: AI output must never overwrite this body. 我的个人笔记保持不变。`,
    });
  const protectedNotes = (await json("/api/kb")).notes;
  const mirrors = new Map(
    protectedNotes.map((note) => [
      note.id,
      fs.readFileSync(path.join(dataDir, "notes", `${note.id}.md`), "utf8"),
    ]),
  );
  report.paperIds = [firstPaper.id, secondPaper.id];
  report.steps.push(
    "Created three original synthetic PDFs, two papers, and protected personal notes in the disposable library",
  );

  const guideStart = Date.now();
  const guideJob = await waitForJob(
    (
      await guideAction({
        action: "start",
        paperId: firstPaper.id,
        mode: "guide",
        attachmentIds: [mainAttachment.id, supplementAttachment.id],
      })
    ).job,
  );
  const guideState = await json("/api/kb");
  const guideResult = guideState.aiContents.find(
    (item) => item.id === guideJob.resultId,
  );
  assert.ok(guideResult);
  report.guide = verifyReport(
    guideResult,
    "guide",
    [mainAttachment, supplementAttachment],
    fixtureMap,
  );
  assertNotesUnchanged(guideState, protectedNotes, mirrors);
  report.timingsMs.guide = Date.now() - guideStart;
  report.steps.push(
    "Real Codex guide completed for main PDF and supplement; every retained original quote, attachment fingerprint, physical page, and private note checked",
  );

  const comparisonStart = Date.now();
  const comparisonJob = await waitForJob(
    (
      await guideAction({
        action: "start",
        paperId: firstPaper.id,
        mode: "comparison",
        paperIds: [firstPaper.id, secondPaper.id],
        attachmentIds: [
          mainAttachment.id,
          supplementAttachment.id,
          secondAttachment.id,
        ],
      })
    ).job,
  );
  const comparisonState = await json("/api/kb");
  const comparisonResult = comparisonState.aiContents.find(
    (item) => item.id === comparisonJob.resultId,
  );
  assert.ok(comparisonResult);
  report.comparison = verifyReport(
    comparisonResult,
    "comparison",
    [mainAttachment, supplementAttachment, secondAttachment],
    fixtureMap,
  );
  assertNotesUnchanged(comparisonState, protectedNotes, mirrors);
  assert.equal(comparisonState.aiContents.length, 2);
  report.timingsMs.comparison = Date.now() - comparisonStart;
  report.counts = {
    papers: comparisonState.papers.length,
    attachments: comparisonState.attachments.length,
    personalNotes: comparisonState.notes.length,
    aiReports: comparisonState.aiContents.length,
  };
  report.steps.push(
    "Real Codex comparison completed with both papers represented in final evidence; database and Markdown personal notes remain byte-for-byte unchanged",
  );
  report.success = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : "Guide smoke failed";
  process.exitCode = interrupted ? 130 : 1;
} finally {
  await cancelActiveJob();
  await stopServer();
  report.finishedAtUTC = new Date().toISOString();
  report.timingsMs.total = Date.now() - startedAt;
  if (keep) {
    report.retainedDataDirectory = dataDir;
    report.browserReviewCommand = `KB_DATA_DIR='${dataDir.replaceAll("'", "'\\''")}' KB_AI_PROVIDER=codex KB_CODEX_MODEL='${model.replaceAll("'", "'\\''")}' PORT=${port} npm start`;
  } else fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(cwd, "test-results"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "test-results", "guide-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (keep)
    fs.writeFileSync(
      path.join(root, "guide-smoke.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  console.log(JSON.stringify(report, null, 2));
}
