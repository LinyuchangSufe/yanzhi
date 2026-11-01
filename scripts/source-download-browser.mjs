// Verify the reported public source in the existing disposable row-menu library.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const base = "http://127.0.0.1:3122";
const reportPath = "test-results/source-download-browser.json";
const mode = process.argv[2];
assert.ok(["prepare", "verify"].includes(mode), "Use prepare or verify");
async function request(route, options = {}) {
  const response = await fetch(base + route, {
    ...options, redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { Origin: base, ...options.headers },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response;
}
const json = async (route, options) => (await request(route, options)).json();
const config = await json("/api/kb/ai");
assert.equal(config.provider, "none");
assert.match(config.dataDir, /^\/private\/tmp\/kb-library-actions-[A-Za-z0-9_-]+$/);
assert.equal(fs.realpathSync(config.dataDir), config.dataDir);
const rowReport = JSON.parse(fs.readFileSync("test-results/library-actions-smoke.json", "utf8"));
assert.equal(rowReport.dataDir, config.dataDir);
assert.equal(rowReport.checks.at(-1)?.stage, "restored", "Complete row-menu acceptance first");
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function attachmentHashes(state) {
  return Promise.all(state.attachments.map(async (item) => ({
    id: item.id,
    sha256: sha(Buffer.from(await (await request(`/api/kb/attachment?id=${item.id}`)).arrayBuffer())),
  })));
}
if (mode === "prepare") {
  assert.ok(!fs.existsSync(reportPath), "Refusing to prepare the same acceptance twice");
  const title = "Online tensor learning: Computational and statistical trade-offs, adaptivity and optimal regret";
  const response = await json("/api/kb", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "paper.create", payload: {
      title, sourceUrl: "https://doi.org/10.1214/25-aos2588", doi: "10.1214/25-aos2588",
    } }),
  });
  const baseline = await json("/api/kb");
  const report = {
    preparedAtUTC: new Date().toISOString(), base, dataDir: config.dataDir,
    policy: "Disposable library only; the real article title/DOI are public metadata. No personal user data, AI call or automatic source substitution.",
    paperId: response.result.id, title, baseline,
    attachmentHashes: await attachmentHashes(baseline),
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ result: "prepared", paperId: report.paperId, title }));
} else {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.dataDir, config.dataDir);
  const current = await json("/api/kb");
  assert.deepEqual(current, report.baseline, "Failed source download must not alter any records or reading positions");
  assert.deepEqual(await attachmentHashes(current), report.attachmentHashes);
  report.verifiedAtUTC = new Date().toISOString();
  report.result = "passed";
  report.expectedVisibleError = "来源返回登录或访问验证页面";
  report.note = "The visible error is checked separately through the browser; this script verifies data preservation.";
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ result: "passed", allStateAndAttachmentsUnchanged: true }));
}
