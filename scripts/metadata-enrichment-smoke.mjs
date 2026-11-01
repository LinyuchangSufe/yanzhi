/** Read-only, reproducible public bibliographic check. No local library is opened. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookupMetadata } from "../src/lib/import/enrichment.ts";
import { fetchPublicUrl } from "../src/lib/import/download.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const title = "Loss of plasticity in deep continual learning";
const expectedDoi = "10.1038/s41586-024-07711-7";
const requested = [];
const fetcher = async (url, signal) => {
  requested.push(url);
  return fetchPublicUrl(url, signal);
};
const startedAt = new Date().toISOString();
const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const gitDirty = !!execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
const summarize = (candidate) => {
  const { abstract, ...metadata } = candidate.metadata;
  return { ...candidate, metadata, abstract: abstract ? { length: abstract.length, sha256: createHash("sha256").update(abstract).digest("hex") } : null };
};
const report = { startedAt, gitCommit, gitDirty, configuration: { provider: "Crossref public REST API", ai: false, localLibraryOpened: false, title, expectedDoi, maxCandidates: 5 }, seed: null, requested };
try {
  const search = await lookupMetadata({ action: "search", title }, fetcher);
  assert.ok(search.candidates.length <= 5);
  const selected = search.candidates.find((candidate) => candidate.metadata.doi === expectedDoi);
  assert.ok(selected, "The known journal article must be present among candidate versions");
  assert.equal(selected.match, "exact");
  assert.equal(selected.metadata.year, 2024);
  assert.equal(selected.metadata.authors.length, 6);
  const detail = await lookupMetadata({ action: "detail", source: expectedDoi, title }, fetcher);
  const candidate = detail.candidates[0];
  assert.equal(candidate.metadata.doi, expectedDoi);
  assert.equal(candidate.metadata.title.toLowerCase(), title.toLowerCase());
  assert.equal(candidate.metadata.authors.length, 6);
  assert.equal(candidate.metadata.year, 2024);
  assert.ok(candidate.metadata.abstract?.length > 500, "The complete registered abstract should be present for this fixture article");
  assert.ok(candidate.provenance.some((source) => source.url.startsWith("https://api.crossref.org/works/") && source.fields.includes("abstract")));
  report.search = { ...search, candidates: search.candidates.map(summarize) };
  report.detail = { ...detail, candidates: detail.candidates.map(summarize) };
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  const destination = path.join(root, "test-results", "metadata-enrichment-smoke.json");
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(`${destination}.tmp`, JSON.stringify(report, null, 2));
  renameSync(`${destination}.tmp`, destination);
  console.log(JSON.stringify({ passed: report.passed, report: destination, candidates: report.search?.candidates.length, journalDoi: report.detail?.candidates[0]?.metadata.doi, journalAbstract: report.detail?.candidates[0]?.abstract, requested }, null, 2));
}
