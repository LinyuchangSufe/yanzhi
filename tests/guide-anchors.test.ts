import assert from "node:assert/strict";
import test from "node:test";
import {
  findUniqueQuote,
  joinEvidenceTextRuns,
  normalizeEvidenceText,
} from "../src/lib/guide/anchors";

test("evidence matcher returns offsets into the original PDF source", () => {
  const quote = "Our algorithm converges under dependent observations.";
  const source = `Abstract\n${quote}\n1 Introduction`;
  const match = findUniqueQuote(source, quote);
  assert.equal(match.status, "matched");
  if (match.status === "matched") assert.equal(source.slice(match.start, match.end), quote);
});

test("PDF typography is normalized without rewriting evidence meaning", () => {
  const source = "An efﬁcient algo-\nrithm handles de\u00adpendent observations.";
  const quote = "An efficient algorithm handles dependent observations.";
  const match = findUniqueQuote(source, quote);
  assert.equal(match.status, "matched");
  if (match.status === "matched") assert.equal(source.slice(match.start, match.end), source);
  assert.notEqual(normalizeEvidenceText("non-convex"), normalizeEvidenceText("nonconvex"));
  assert.notEqual(normalizeEvidenceText("a − b"), normalizeEvidenceText("a + b"));
  assert.notEqual(normalizeEvidenceText("𝐀"), normalizeEvidenceText("A"));
});

test("ambiguous, missing, and short quotations never produce coordinates", () => {
  const quote = "We assume a bounded second moment for all observations.";
  assert.deepEqual(findUniqueQuote(`${quote}\n${quote}`, quote), { status: "ambiguous" });
  assert.deepEqual(findUniqueQuote("A different statement.", quote), { status: "missing" });
  assert.deepEqual(findUniqueQuote("Theorem 1", "Theorem 1"), { status: "too-short" });
  assert.deepEqual(findUniqueQuote("aaaaaaaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaaaaaa"), { status: "ambiguous" });
});

test("PDF item joining preserves actual line endings for hyphenation", () => {
  const page = joinEvidenceTextRuns([
    { text: "An efficient algo-", hasEOL: true },
    { text: "rithm for dependent observations." },
  ]);
  assert.equal(findUniqueQuote(page, "An efficient algorithm for dependent observations.").status, "matched");
});
