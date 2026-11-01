/** Read-only live check: node --import tsx scripts/journal-metadata-smoke.mjs */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveMetadata } from "../src/lib/import/metadata.ts";
import { fetchPublicUrl } from "../src/lib/import/download.ts";

const sourceUrl = "https://www.tandfonline.com/doi/full/10.1080/01621459.2026.2674413";
const doi = "10.1080/01621459.2026.2674413";
const report = {
  startedAt: new Date().toISOString(),
  command: "node --import tsx scripts/journal-metadata-smoke.mjs",
  implementation: "src/lib/import/metadata.ts resolveMetadata → fetchPublicUrl (DNS pinning, public addresses, redirect guards) → 2 MiB bounded response",
  sourceUrl,
  doi,
  gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
  realModelExecuted: false,
  libraryMutated: false,
  requests: [],
};
try {
  const result = await resolveMetadata(sourceUrl, async (url, signal) => {
    const request = {url, startedAt: new Date().toISOString()};
    report.requests.push(request);
    try {
      const response = await fetchPublicUrl(url, signal);
      request.httpStatus = response.response.status;
      return response;
    } catch (error) {
      request.error = error instanceof Error ? error.message : "Fetch failed";
      throw error;
    }
  });
  report.metadata = result.metadata;
  report.warnings = result.warnings;
  assert.equal(result.metadata.sourceUrl, sourceUrl);
  assert.equal(result.metadata.doi, doi);
  assert.ok(result.metadata.title);
  assert.ok(result.metadata.authors?.length);
  assert.equal(result.warnings.length, 0);
  assert.equal(report.requests.length, 1);
  assert.equal(report.requests[0].httpStatus, 200);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : "Live check failed";
  process.exitCode = 1;
}
report.completedAt = new Date().toISOString();
const directory = fileURLToPath(new URL("../test-results/", import.meta.url));
await mkdir(directory, {recursive: true});
await writeFile(new URL("../test-results/journal-metadata-live.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({passed: report.passed, title: report.metadata?.title, authors: report.metadata?.authors, year: report.metadata?.year, requests: report.requests, error: report.error}, null, 2));
