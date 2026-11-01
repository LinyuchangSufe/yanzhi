import test from "node:test";
import assert from "node:assert/strict";
import { annotationOverview, confirmAnnotationDeletion } from "../src/components/editor/annotation-overview";
import type { Annotation } from "../src/lib/types";

const mark = (id: string, comment = "", paperId = "paper-a", kind: Annotation["kind"] = "highlight"): Annotation => ({
  id, paperId, attachmentId: "source-pdf", pageIndex: 2, pageLabel: "iii", kind, color: "#ffff00", selectedText: "Synthetic original excerpt",
  rects: [{ x: .1, y: .2, width: .3, height: .04 }], comment, revision: 1, createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z",
});

test("annotation overview includes pure highlights, regional marks and comments without changing their source geometry", () => {
  const annotations = [mark("plain"), mark("whitespace", " \n "), mark("region", "", "paper-a", "region"), mark("comment", "My observation"), mark("other", "", "paper-b")];
  const original = structuredClone(annotations), groups = annotationOverview(annotations, "paper-a");
  assert.deepEqual(groups.all.map(item => item.id), ["plain", "whitespace", "region", "comment"]);
  assert.deepEqual(groups.highlights.map(item => item.id), ["plain", "whitespace", "region"]);
  assert.deepEqual(groups.comments.map(item => item.id), ["comment"]);
  assert.deepEqual(annotations, original); assert.equal(groups.highlights[0], annotations[0]);
  assert.deepEqual(annotationOverview(annotations, "missing"), { all: [], highlights: [], comments: [] });
});

test("cancelling physical annotation deletion never dispatches a mutation and states the irreversible consequence", async () => {
  let removed = false, prompt = "";
  const deleted = await confirmAnnotationDeletion(mark("plain"), { referenced: false, confirm(message) { prompt = message; return false; }, async remove() { removed = true; } });
  assert.equal(deleted, false); assert.equal(removed, false); assert.match(prompt, /第 3 页/); assert.match(prompt, /无法单独撤销/); assert.match(prompt, /原 PDF 不会修改/);
});

test("referenced annotations remain protected even before confirmation", async () => {
  let confirmed = false, removed = false;
  await assert.rejects(confirmAnnotationDeletion(mark("referenced"), { referenced: true, confirm() { confirmed = true; return true; }, async remove() { removed = true; } }), /已被笔记引用/);
  assert.equal(confirmed, false); assert.equal(removed, false);
});

test("explicit approval dispatches once and retains storage failures for the caller to show", async () => {
  let removed = 0, prompt = "";
  assert.equal(await confirmAnnotationDeletion(mark("comment", "My comment"), { referenced: false, confirm(message) { prompt = message; return true; }, async remove() { removed++; } }), true);
  assert.equal(removed, 1); assert.match(prompt, /标注及评论/);
  await assert.rejects(confirmAnnotationDeletion(mark("race"), { referenced: false, confirm: () => true, remove: async () => { throw new Error("批注已被笔记引用"); } }), /已被笔记引用/);
});
