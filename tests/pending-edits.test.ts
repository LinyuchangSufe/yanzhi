import assert from "node:assert/strict";
import test from "node:test";
import { persistSessionDraft, prepareWorkspaceLeave, readSessionDraft, registerLeaveGuard } from "../src/lib/editor/pending-edits";
import { isPendingAnnotation, matchesDraftAttachment, savedAnnotationForDraft } from "../src/lib/editor/annotation-recovery";
import type { Annotation } from "../src/lib/types";

test("navigation waits for pending editors and stops before discarding a blocked edit", async () => {
  const calls: string[] = [];
  const removeFirst = registerLeaveGuard(async () => { calls.push("saved"); return true; });
  const removeSecond = registerLeaveGuard(() => { calls.push("blocked"); return false; });
  const removeThird = registerLeaveGuard(() => { calls.push("unvisited"); return true; });
  try {
    assert.equal(await prepareWorkspaceLeave(), false);
    assert.deepEqual(calls, ["saved", "blocked"]);
    removeSecond();
    calls.length = 0;
    assert.equal(await prepareWorkspaceLeave(), true);
    assert.deepEqual(calls, ["saved", "unvisited"]);
  } finally { removeFirst(); removeSecond(); removeThird(); }
  assert.equal(await prepareWorkspaceLeave(), true);
});

test("session draft survives route remount, clean save removes it, malformed data is ignored", () => {
  const memory = new Map<string, string>();
  const storage = { getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); } };
  const valid = (value: unknown): value is { comment: string } => Boolean(value && typeof value === "object" &&
    "comment" in value && typeof value.comment === "string");
  persistSessionDraft(storage, "comment:a", { comment: "还没保存的想法" }, true);
  assert.deepEqual(readSessionDraft(storage, "comment:a", valid), { comment: "还没保存的想法" });
  assert.equal(readSessionDraft(storage, "comment:b", valid), null);
  persistSessionDraft(storage, "comment:a", { comment: "还没保存的想法" }, false);
  assert.equal(readSessionDraft(storage, "comment:a", valid), null);
  storage.setItem("comment:a", "{broken");
  assert.equal(readSessionDraft(storage, "comment:a", valid), null);
  storage.setItem("comment:a", JSON.stringify({ version: 1, value: { comment: 12 } }));
  assert.equal(readSessionDraft(storage, "comment:a", valid), null);
  assert.throws(() => persistSessionDraft({ ...storage, setItem: () => { throw new Error("quota"); } },
    "comment:a", { comment: "keep in editor" }, true), /quota/);
});

test("recovered PDF draft keeps its immutable paper, attachment, page, geometry and comment", () => {
  const value = { draft: { kind: "region", paperId: "paper-a", attachmentId: "pdf-a", pageIndex: 2,
    pageLabel: "iv", rects: [{ x: .1, y: .2, width: .4, height: .3 }], selectedText: "" },
    comment: "我的评论", color: "#f5cf58", expanded: true, sha256: "immutable-a" };
  assert.equal(isPendingAnnotation(value), true);
  if (!isPendingAnnotation(value)) throw new Error("fixture rejected");
  assert.equal(matchesDraftAttachment(value, "paper-a", [{ id: "pdf-a", sha256: "immutable-a" }]), true);
  assert.equal(matchesDraftAttachment(value, "paper-b", [{ id: "pdf-a", sha256: "immutable-a" }]), false);
  assert.equal(matchesDraftAttachment(value, "paper-a", [{ id: "pdf-a", sha256: "changed" }]), false);
  assert.equal(matchesDraftAttachment(value, "paper-a", [{ id: "pdf-b", sha256: "immutable-a" }]), false);
  assert.equal(isPendingAnnotation({ ...value, draft: { ...value.draft, pageIndex: -1 } }), false);
  assert.equal(isPendingAnnotation({ ...value, draft: { ...value.draft, rects: [{ x: .9, y: 0, width: .5, height: .1 }] } }), false);
});

test("recovering a draft after a lost success response finds only the exact saved annotation", () => {
  const saved: Annotation = { id: "saved", revision: 1, paperId: "paper-a", attachmentId: "pdf-a", kind: "region",
    pageIndex: 0, pageLabel: "i", selectedText: "", rects: [{ x: .1, y: .1, width: .2, height: .2 }],
    comment: "已保存", color: "#f5cf58", createdAt: "2026-10-30", updatedAt: "2026-10-30" };
  const pending = { draft: { ...saved, textSegments: saved.textSegments ?? undefined }, comment: saved.comment, color: saved.color, expanded: true, sha256: "sha" };
  assert.equal(savedAnnotationForDraft(pending, [saved])?.id, "saved");
  assert.equal(savedAnnotationForDraft({ ...pending, comment: "新评论" }, [saved]), undefined);
  assert.equal(savedAnnotationForDraft(pending, [{ ...saved, attachmentId: "another" }]), undefined);
  assert.equal(savedAnnotationForDraft(pending, [{ ...saved, rects: [{ x: .1, y: .2, width: .2, height: .2 }] }]), undefined);
});
