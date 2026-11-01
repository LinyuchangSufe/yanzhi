import { test } from "node:test";
import assert from "node:assert/strict";
import { recentPaperIds, rememberOpenedPaper, sortLibraryPapers } from "../src/lib/library-navigation";

function paper(id: string, createdAt: string, deletedAt: string | null = null) {
  return { id, title: `TEST ${id}`, createdAt, updatedAt: createdAt, deletedAt,
    readingStatus: "unread" as const, inReadingList: false };
}
const papers = [
  paper("older", "2025-01-01"),
  paper("newest", "2026-10-29"),
  paper("middle", "2026-06-01"),
  paper("trash", "2026-10-28", "2026-10-29"),
];

test("opening history accepts only a string array, deduplicates, and excludes other libraries and trash", () => {
  assert.deepEqual(recentPaperIds('["older","missing","older","trash","newest"]', papers), ["older", "newest"]);
  for (const stored of [null, "{broken", "null", '"older"', '{"id":"older"}', '["older",4]'])
    assert.deepEqual(recentPaperIds(stored, papers), []);
  assert.deepEqual(recentPaperIds('["older"]', [paper("different-library", "2026-01-01")]), []);
});

test("history is capped after validation and active-paper filtering", () => {
  const many = Array.from({ length: 65 }, (_, i) => paper(`paper-${i}`, "2026-01-01"));
  const ids = ["missing", ...many.map(({ id }) => id)];
  assert.deepEqual(recentPaperIds(JSON.stringify(ids), many), many.slice(0, 50).map(({ id }) => id));
});

test("opening a paper moves it to the front without modifying library state or reading progress", () => {
  const before = structuredClone(papers);
  assert.deepEqual(rememberOpenedPaper('["older","newest"]', "newest", papers), ["newest", "older"]);
  assert.deepEqual(rememberOpenedPaper("{bad", "middle", papers), ["middle"]);
  assert.deepEqual(rememberOpenedPaper('["older"]', "trash", papers), ["older"]);
  assert.deepEqual(rememberOpenedPaper('["older"]', "another-library", papers), ["older"]);
  assert.deepEqual(papers, before);
});

test("recent sorting keeps unopened papers and orders them by creation time after opened papers", () => {
  const active = papers.filter((entry) => !entry.deletedAt);
  const before = structuredClone(active);
  const sorted = sortLibraryPapers(active, "recent", ["older"]);
  assert.deepEqual(sorted.map(({ id }) => id), ["older", "newest", "middle"]);
  assert.equal(sorted.length, active.length);
  assert.deepEqual(active, before);
  assert.deepEqual(sortLibraryPapers(active, "recent", ["middle", "older"]).map(({ id }) => id), ["middle", "older", "newest"]);
});

test("empty or invalid history falls back to creation time and other sort orders still work", () => {
  const active = papers.filter((entry) => !entry.deletedAt);
  for (const stored of [null, "not-json", '{"malformed":true}', '["different-library","trash"]'])
    assert.deepEqual(sortLibraryPapers(active, "recent", recentPaperIds(stored, papers)).map(({ id }) => id), ["newest", "middle", "older"]);
  assert.deepEqual(sortLibraryPapers(active, "title", ["older"]).map(({ id }) => id), ["middle", "newest", "older"]);
  const updated = active.map((entry) => entry.id === "older" ? { ...entry, updatedAt: "2026-10-30" } : entry);
  assert.deepEqual(sortLibraryPapers(updated, "updated").map(({ id }) => id), ["older", "newest", "middle"]);
  assert.deepEqual(sortLibraryPapers(active, "newest", ["older"]).map(({ id }) => id), ["newest", "middle", "older"]);
});
