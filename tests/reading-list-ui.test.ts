import assert from "node:assert/strict";
import test from "node:test";
import { readingListMessage, visibleSelection } from "../src/lib/reading-list-ui";
import type { Paper } from "../src/lib/types";

const paper = (id: string, values: Partial<Paper> = {}): Paper => ({
  id, title: id, authors: [], year: null, abstract: "", sourceUrl: "", doi: "",
  arxivId: "", arxivVersion: null, readingStatus: "unread", inReadingList: false,
  revision: 1, createdAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z", ...values,
});

test("batch selection excludes filtered, deleted, and unknown rows without losing visible progress states", () => {
  const unread = paper("unread");
  const reading = paper("reading", { readingStatus: "reading", inReadingList: true });
  const read = paper("read", { readingStatus: "read" });
  const deleted = paper("deleted", { deletedAt: "2026-10-29T01:00:00.000Z" });
  const visible = [reading, unread, deleted, read];
  assert.deepEqual(visibleSelection(visible, ["hidden", "deleted", "unread", "read", "reading", "unknown"]), [reading, unread, read]);
  assert.deepEqual(visibleSelection(visible, []), []);
  assert.deepEqual(visibleSelection([], ["unread"]), []);
});

test("batch selection uses the latest visible paper revision and never duplicates a selected record", () => {
  const updated = paper("selected", { revision: 7, readingStatus: "reading", inReadingList: true });
  const result = visibleSelection([updated, paper("other")], ["selected", "selected"]);
  assert.equal(result.length, 1);
  assert.equal(result[0], updated);
  assert.equal(result[0].revision, 7);
  assert.equal(result[0].inReadingList, true);
});

test("membership feedback only describes joining or leaving the reading list", () => {
  assert.equal(readingListMessage("add", 2), "已将 2 篇文献加入待阅读。");
  assert.equal(readingListMessage("remove", 1), "已将 1 篇文献移出待阅读。");
});
