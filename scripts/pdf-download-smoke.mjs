import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { downloadPdf, fetchPublicUrl, DOWNLOAD_TOTAL_TIMEOUT_MS, DOWNLOAD_REQUEST_TIMEOUT_MS } from "../src/lib/import/download.ts";

// Public read-only requests. PDF bytes remain in memory and never enter a library.
const title = "Online tensor learning: Computational and statistical trade-offs, adaptivity and optimal regret";
const targets = [
  { label: "user-reported-journal-source", source: "https://doi.org/10.1214/25-aos2588", doi: "10.1214/25-aos2588" },
  { label: "same-paper-public-arxiv-preprint", source: "https://arxiv.org/abs/2306.03372" },
  { label: "network-control-official-w3c-test-pdf-not-a-paper", source: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", control: true },
];
const selectedLabel = process.argv.find((value) => value.startsWith("--target="))?.slice("--target=".length);
if (selectedLabel && !targets.some((target) => target.label === selectedLabel)) throw new Error("Unknown smoke target");
const report = {
  startedAt: new Date().toISOString(),
  configuration: { mode: "read-only public download", seed: null, libraryWrites: false, modelCalls: 0, timeoutMs: DOWNLOAD_TOTAL_TIMEOUT_MS, perRequestTimeoutMs: DOWNLOAD_REQUEST_TIMEOUT_MS, selectedTarget: selectedLabel ?? "all", maxPdfBytes: 100 * 1024 * 1024, maxHtmlBytes: 2 * 1024 * 1024 },
  git: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() },
  targets: [],
};
for (const target of targets.filter((item) => !selectedLabel || item.label === selectedLabel)) {
  const trace = [];
  const started = Date.now();
  try {
    const result = await downloadPdf(target.source, {
      expectedDoi: target.doi,
      expectedTitle: target.control ? undefined : title,
      fetcher: async (url, signal) => {
        const fetched = await fetchPublicUrl(url, signal);
        trace.push({ requestedUrl: url, finalUrl: fetched.url, status: fetched.response.status, contentType: fetched.response.headers.get("content-type") });
        return fetched;
      },
    });
    report.targets.push({ ...target, outcome: "downloaded-and-validated-pdf-magic", trace, finalUrl: result.finalUrl, arxivId: result.arxivId, byteLength: result.bytes.length, sha256: createHash("sha256").update(result.bytes).digest("hex"), elapsedMs: Date.now() - started });
  } catch (error) {
    report.targets.push({ ...target, outcome: "source-unavailable", trace, status: error.status ?? null, message: error.message, elapsedMs: Date.now() - started });
  }
}
report.finishedAt = new Date().toISOString();
await mkdir("test-results", { recursive: true });
const reportPath = selectedLabel ? `test-results/pdf-download-smoke-${selectedLabel}.json` : "test-results/pdf-download-smoke.json";
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
