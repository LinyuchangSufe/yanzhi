// OPTIONAL REAL MODEL CAPABILITY SMOKE. Never invoked by npm test/build.
// prepare: no model request, generates one original synthetic visual formula PDF.
// run: one real Codex vision request; fresh guarded temp library; no HTTP server.
//   node scripts/pdf-markdown-codex-smoke.mjs prepare
//   KB_CODEX_MODEL=<configured-model> node scripts/pdf-markdown-codex-smoke.mjs run \
//     /private/tmp/kb-markdown-codex-smoke-XXXXXX --allow-synthetic-vision
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const markerName = ".original-synthetic-vision.json";
const fixtureName = "original-synthetic-formula.pdf";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const mode = process.argv[2];
assert.ok(["prepare", "run"].includes(mode), "Use prepare or explicitly authorized run");
function writeExclusive(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
function plainFile(file) {
  assert.equal(fs.realpathSync(file), file, "Refusing a symlink or different source");
  assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink());
  return file;
}
function guard(value) {
  assert.match(value || "", /^\/private\/tmp\/kb-markdown-codex-smoke-[A-Za-z0-9_-]+$/);
  assert.equal(fs.realpathSync(value), value);
  assert.ok(fs.lstatSync(value).isDirectory() && !fs.lstatSync(value).isSymbolicLink());
  const marker = JSON.parse(fs.readFileSync(plainFile(path.join(value, markerName)), "utf8"));
  assert.equal(marker.type, "ORIGINAL SYNTHETIC PDF VISION CAPABILITY SMOKE");
  assert.equal(marker.physicalPages, 1);
  const pdf = fs.readFileSync(plainFile(path.join(value, fixtureName)));
  assert.equal(sha(pdf), marker.sourcePDFSHA256, "Synthetic source PDF changed since preparation");
  return marker;
}

if (mode === "prepare") {
  assert.equal(process.argv.length, 3, "prepare accepts no arbitrary input paths");
  const root = fs.mkdtempSync("/private/tmp/kb-markdown-codex-smoke-");
  const document = await PDFDocument.create();
  const fixedTime = new Date("2026-10-29T00:00:00.000Z");
  document.setTitle("ORIGINAL SYNTHETIC VISION FIXTURE");
  document.setAuthor("AIlib software capability smoke");
  document.setCreator("scripts/pdf-markdown-codex-smoke.mjs");
  document.setCreationDate(fixedTime); document.setModificationDate(fixedTime);
  const page = document.addPage([600, 800]);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const italic = await document.embedFont(StandardFonts.TimesRomanItalic);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const text = (value, x, y, size = 16, font = regular) => page.drawText(value, { x, y, size, font });
  text("ORIGINAL SYNTHETIC VISION FIXTURE", 42, 744, 20, bold);
  text("Software capability test only. No personal or published material.", 42, 710, 14);
  text("Transcribe this visually typeset expression:", 42, 638, 18);
  // Visually typeset u_(t+1) = (x_t + 1)/(y_t^2). There is no embedded LaTeX source.
  text("u", 92, 486, 36, italic); text("t+1", 112, 477, 19, italic);
  text("=", 157, 486, 36);
  text("x", 228, 514, 33, italic); text("t", 246, 505, 18, italic); text("+ 1", 263, 514, 31);
  page.drawLine({ start: { x: 214, y: 500 }, end: { x: 329, y: 500 }, thickness: 1.6, color: rgb(0, 0, 0) });
  text("y", 252, 454, 33, italic); text("t", 271, 445, 18, italic); text("2", 272, 475, 18);
  text("The fraction and subscripts are drawn separately in this PDF.", 42, 360, 14);
  text("This expression is synthetic and makes no scientific claim.", 42, 332, 14);
  text("1", 294, 38, 12);
  const bytes = Buffer.from(await document.save({ useObjectStreams: false }));
  fs.writeFileSync(path.join(root, fixtureName), bytes, { flag: "wx", mode: 0o600 });
  const marker = {
    type: "ORIGINAL SYNTHETIC PDF VISION CAPABILITY SMOKE", runId: randomUUID(),
    preparedAtUTC: new Date().toISOString(), physicalPages: 1,
    sourcePDFSHA256: sha(bytes), sourcePDFBytes: bytes.length,
    formulaForHumanReviewOnly: "u_(t+1) = (x_t + 1)/(y_t^2)",
    policy: "Only this original one-page synthetic PDF may enter a real model request. No production library or port 3000 is accessed.",
  };
  writeExclusive(path.join(root, markerName), marker);
  console.log(JSON.stringify({ result: "prepared; no model called", root,
    sourcePDF: path.join(root, fixtureName), ...marker,
    runCommand: `KB_CODEX_MODEL=<configured-model> node scripts/pdf-markdown-codex-smoke.mjs run '${root}' --allow-synthetic-vision`,
  }, null, 2));
} else {
  assert.equal(process.argv.length, 5);
  assert.equal(process.argv[4], "--allow-synthetic-vision", "A real model request requires this explicit opt-in flag");
  const root = process.argv[3], marker = guard(root);
  const model = process.env.KB_CODEX_MODEL?.trim();
  assert.ok(model && model.length <= 100 && /^[a-zA-Z0-9._/-]+$/.test(model), "Pass the selected model explicitly through KB_CODEX_MODEL");
  assert.deepEqual(fs.readdirSync(root).sort(), [markerName, fixtureName].sort(), "Refusing reused, nonempty, or previously run fixture data");
  const dataDir = path.join(root, "library");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const resultFile = path.join(root, "result.json");
  const runner = path.join(root, "run-synthetic.mts");
  const libraryImport = pathToFileURL(path.join(cwd, "src/lib/db.ts")).href;
  const aiImport = pathToFileURL(path.join(cwd, "src/lib/ai.ts")).href;
  const driver = `import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {getStore} from ${JSON.stringify(libraryImport)};
import {aiConfiguration, generateAI} from ${JSON.stringify(aiImport)};
const controller = new AbortController();
for (const event of ['SIGINT','SIGTERM']) process.on(event, () => controller.abort());
const deadline = setTimeout(() => controller.abort(), 60000);
const store = getStore();
const report = {startedAtUTC:new Date().toISOString(), success:false};
try {
  assert.equal(store.dataDir, ${JSON.stringify(dataDir)});
  assert.ok(store.snapshot().papers.length === 0 && store.snapshot().notes.length === 0 && store.snapshot().aiContents.length === 0);
  const config = aiConfiguration();
  assert.equal(config.provider,'codex'); assert.equal(config.model,${JSON.stringify(model)});
  report.configuration = {provider:config.provider,model:config.model,environmentOverride:config.environmentOverride,dataDir:store.dataDir,modelTimeoutMs:60000,sourceScope:'one physical PDF page image',seed:null,seedReason:'Codex CLI has no seed option in this transport'};
  const paper = store.dispatch('paper.create',{title:'ORIGINAL SYNTHETIC VISION FIXTURE',abstract:'Original software capability smoke only. No research claims.'});
  const pdf = fs.readFileSync(${JSON.stringify(path.join(root, fixtureName))});
  assert.equal(createHash('sha256').update(pdf).digest('hex'),${JSON.stringify(marker.sourcePDFSHA256)});
  const attachment = store.addAttachment(paper.id,'original-synthetic-formula.pdf',pdf);
  const notesBefore = JSON.stringify(store.snapshot().notes);
  const result = await generateAI({paperId:paper.id,kind:'markdown',attachmentId:attachment.id,pageIndex:0}, controller.signal);
  assert.equal(result.provider,'codex'); assert.equal(result.kind,'markdown');
  assert.equal(result.sourceScope,'page_image'); assert.equal(result.sourceAttachmentId,attachment.id);
  assert.deepEqual(result.sourcePageIndices,[0]);
  assert.equal(JSON.stringify(store.snapshot().notes),notesBefore);
  assert.equal(createHash('sha256').update(fs.readFileSync(store.attachmentPath(attachment.id))).digest('hex'),${JSON.stringify(marker.sourcePDFSHA256)});
  const body = result.body;
  report.formulaChecks = {
    fractionSyntax:/\\\\(?:d|t|c)?frac\\b|\\\\over\\b/.test(body),
    subscriptSyntax:/_\\s*(?:\\{[^}]*t[^}]*\\}|t|\\([^)]*t[^)]*\\))/.test(body),
    exponentTwo:/\\^\\s*(?:\\{\\s*2\\s*\\}|2)/.test(body),
    mathDelimiters:/\\$[^$]+\\$/.test(body),
    unreadableMarker:body.includes('[无法辨认]'),
  };
  report.result = result;
  report.personalNotesUnchanged = true; report.sourcePDFUnchanged = true;
  report.success = report.formulaChecks.fractionSyntax && report.formulaChecks.subscriptSyntax && report.formulaChecks.exponentTwo;
  report.interpretation = report.success ? 'The real configured model returned a fraction, subscripts and square exponent from this single synthetic image. This is a small capability smoke, not general OCR accuracy evidence.' : 'A model response was received, but basic visual formula checks did not all pass. Inspect the saved output against the original PDF; do not infer general OCR quality.';
} catch(error) {
  report.error = error instanceof Error ? error.message : 'Synthetic smoke failed';
  report.cancelled = controller.signal.aborted;
} finally {
  clearTimeout(deadline); report.completedAtUTC = new Date().toISOString();
  fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(report,null,2)+'\\n',{flag:'wx',mode:0o600});
  store.close();
  if (!report.success) process.exitCode=1;
}
`;
  fs.writeFileSync(runner, driver, { flag: "wx", mode: 0o600 });
  const codeHashes = Object.fromEntries(["src/lib/ai.ts", "src/lib/ai/codex.ts", "src/lib/ai/pdf-image.ts"].map((file) => [file, sha(fs.readFileSync(path.join(cwd, file)))]));
  const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const environment = { ...process.env, KB_DATA_DIR: dataDir, KB_AI_PROVIDER: "codex", KB_CODEX_MODEL: model, KB_CODEX_TIMEOUT_MS: "60000" };
  // Real tools only; fixture executables and arbitrary extractor overrides are excluded.
  for (const key of ["KB_CODEX_BIN", "CODEX_CLI_PATH", "KB_PDFINFO", "KB_PDFTOPPM", "KB_PDFTOTEXT"]) delete environment[key];
  const child = spawn(process.execPath, ["--import", "tsx", runner], { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (part) => { diagnostics = (diagnostics + part.toString()).slice(-4000); });
  const forwardCancel = () => child.kill("SIGTERM");
  for (const event of ["SIGINT", "SIGTERM"]) process.on(event, forwardCancel);
  const failsafe = setTimeout(forwardCancel, 70000);
  const exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  clearTimeout(failsafe);
  for (const event of ["SIGINT", "SIGTERM"]) process.removeListener(event, forwardCancel);
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, "utf8")) : {
    success: false, error: "Synthetic driver exited before writing a result", driverExitCode: exitCode,
    // These diagnostics originate only from the synthetic driver, never the Codex raw event stream.
    driverDiagnostics: diagnostics,
  };
  const report = {
    type: marker.type, runId: marker.runId, root, sourcePDF: path.join(root, fixtureName),
    sourcePDFSHA256: marker.sourcePDFSHA256, physicalPages: 1, gitCommit, codeHashes,
    workingTree: "Local source may include uncommitted changes; the exact AI source hashes are recorded above.",
    policy: marker.policy, ...result,
  };
  const outputDir = path.join(cwd, "test-results"); fs.mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, `pdf-markdown-codex-${marker.runId}.json`);
  writeExclusive(output, report);
  console.log(JSON.stringify({ success: report.success, report: output, root,
    configuration: report.configuration, formulaChecks: report.formulaChecks,
    ...(report.error ? { error: report.error } : {}),
  }, null, 2));
  if (!report.success || exitCode !== 0) process.exitCode = 1;
}
