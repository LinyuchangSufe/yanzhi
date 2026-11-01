import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendDraftSelection,
  draftTextSegments,
  removeLastDraftSegment,
  selectDraftSelection,
  shouldAppendPdfSelection,
  type PdfDraft,
} from "../src/components/pdf/annotation-draft";

function selected(
  selectedText = "First separated excerpt",
  y = 0.1,
  overrides: Partial<PdfDraft> = {},
): PdfDraft {
  return {
    paperId: "paper-a",
    attachmentId: "attachment-a",
    pageIndex: 3,
    pageLabel: "2",
    kind: "highlight",
    rects: [{ x: 0.1, y, width: 0.6, height: 0.02 }],
    selectedText,
    ...overrides,
  };
}

test("disconnected excerpts become one draft with distinct geometry and an explicit text break", () => {
  const first = selected();
  const second = selected("Second excerpt after an unselected gap", 0.6);
  const initial = appendDraftSelection(null, first);
  assert.equal(initial.status, "created");
  assert.deepEqual(initial.draft?.textSegments, [{ rects: first.rects, selectedText: first.selectedText }]);
  const result = appendDraftSelection(initial.draft, second);
  assert.equal(result.status, "appended");
  assert.equal(result.draft?.paperId, first.paperId);
  assert.equal(result.draft?.attachmentId, first.attachmentId);
  assert.equal(result.draft?.pageIndex, first.pageIndex);
  assert.equal(result.draft?.pageLabel, first.pageLabel);
  assert.deepEqual(result.draft?.rects, [...first.rects, ...second.rects]);
  assert.equal(result.draft?.selectedText, `${first.selectedText}\n\n${second.selectedText}`);
  assert.equal(result.draft?.textSegments?.length, 2);
  assert.equal(initial.draft?.textSegments?.length, 1);
  assert.equal(first.textSegments, undefined);
});

test("reselecting the same excerpt is a no-op, while identical words at a different source remain separate", () => {
  const original = appendDraftSelection(null, selected()).draft!;
  const duplicate = selected();
  duplicate.rects[0].x += 0.000001;
  const result = appendDraftSelection(original, duplicate);
  assert.equal(result.status, "duplicate");
  assert.equal(result.draft, original);
  const elsewhere = appendDraftSelection(original, selected(original.selectedText, 0.6));
  assert.equal(elsewhere.status, "appended");
  assert.equal(elsewhere.draft?.textSegments?.length, 2);
});

test("other pages, attachment versions, papers and region mixtures cannot replace the pending source", () => {
  const original = appendDraftSelection(null, selected()).draft!;
  const before = structuredClone(original);
  for (const incoming of [
    selected("Next page", 0.1, { pageIndex: 4 }),
    selected("Another attachment", 0.1, { attachmentId: "attachment-b" }),
    selected("Another paper", 0.1, { paperId: "paper-b" }),
    selected("", 0.4, { kind: "region" }),
  ]) {
    const result = appendDraftSelection(original, incoming);
    assert.equal(result.status, "rejected");
    assert.equal(result.draft, original);
    assert.match(result.message!, /先保存|不能合并/);
  }
  assert.deepEqual(original, before);
  const region = selected("", 0.4, { kind: "region" });
  assert.equal(appendDraftSelection(null, region).draft, region);
  assert.equal(appendDraftSelection(region, selected()).status, "rejected");
  assert.equal(appendDraftSelection(region, region).status, "rejected");
  assert.deepEqual(draftTextSegments(region), []);
});

test("undo removes only the most recent excerpt, supports legacy single selections and clears the last selection", () => {
  const first = selected();
  const second = selected("Later excerpt", 0.5);
  const combined = appendDraftSelection(appendDraftSelection(null, first).draft, second).draft!;
  const undo = removeLastDraftSegment(combined)!;
  assert.deepEqual(undo.rects, first.rects);
  assert.equal(undo.selectedText, first.selectedText);
  assert.equal(undo.textSegments?.length, 1);
  assert.equal(removeLastDraftSegment(undo), null);
  assert.equal(removeLastDraftSegment(first), null);
  const region = selected("", 0.4, { kind: "region" });
  assert.equal(removeLastDraftSegment(region), region);
  assert.equal(combined.textSegments?.length, 2);
});

test("saving blocks all source edits without changing the in-flight draft", () => {
  const draft = appendDraftSelection(null, selected()).draft!;
  const rejected = appendDraftSelection(draft, selected("Later excerpt", 0.5), { saving: true });
  assert.equal(rejected.status, "rejected");
  assert.match(rejected.message!, /正在保存/);
  assert.equal(rejected.draft, draft);
  assert.equal(removeLastDraftSegment(draft, true), draft);
  assert.equal(appendDraftSelection(null, selected(), { saving: true }).draft, null);
});

test("thirty excerpts are supported and duplicates at the limit remain harmless", () => {
  let draft: PdfDraft | null = null;
  for (let index = 0; index < 30; index++) {
    const result = appendDraftSelection(draft, selected(`Passage ${index}`, index / 100));
    assert.equal(result.status, index ? "appended" : "created");
    draft = result.draft;
  }
  assert.equal(draft?.textSegments?.length, 30);
  assert.equal(appendDraftSelection(draft, selected("Passage 29", 0.29)).status, "duplicate");
  const overflow = appendDraftSelection(draft, selected("Passage 30", 0.3));
  assert.equal(overflow.status, "rejected");
  assert.equal(overflow.draft, draft);
  assert.match(overflow.message!, /30/);
});

test("total text includes excerpt separators and geometry cannot exceed the server's safe limits", () => {
  const base = selected("a".repeat(49999));
  base.rects = Array.from({ length: 250 }, () => ({ ...base.rects[0] }));
  const second = selected("b".repeat(49999), 0.4);
  second.rects = Array.from({ length: 250 }, () => ({ ...second.rects[0] }));
  const maximum = appendDraftSelection(appendDraftSelection(null, base).draft, second);
  assert.equal(maximum.status, "appended");
  assert.equal(maximum.draft?.selectedText.length, 100000);
  assert.equal(maximum.draft?.rects.length, 500);
  const overflow = appendDraftSelection(maximum.draft, selected("More", 0.6));
  assert.equal(overflow.status, "rejected");
  assert.equal(overflow.draft, maximum.draft);
  const tooManyRects = selected();
  tooManyRects.rects = Array.from({ length: 501 }, () => ({ ...tooManyRects.rects[0] }));
  assert.equal(appendDraftSelection(null, tooManyRects).status, "rejected");
  assert.equal(appendDraftSelection(null, selected("x".repeat(100001))).status, "rejected");
  assert.equal(appendDraftSelection(null, selected("x".repeat(100000))).status, "created");
});

test("empty selections cannot create a false source or erase an existing draft", () => {
  const draft = selected();
  for (const empty of [selected(" \n\t"), selected("Text without geometry", 0.4, { rects: [] })]) {
    assert.equal(appendDraftSelection(null, empty).draft, null);
    const rejected = appendDraftSelection(draft, empty);
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.draft, draft);
  }
});

test("normal text drags replace earlier excerpts, including an earlier Cmd multi-selection", () => {
  const first = selectDraftSelection(null, selected()).draft!;
  const multiple = selectDraftSelection(first, selected("Second passage", 0.4), { append: true }).draft!;
  const incoming = selected("Fresh passage", 0.8);
  const replacement = selectDraftSelection(multiple, incoming);
  assert.equal(replacement.status, "created");
  assert.equal(replacement.draft?.selectedText, incoming.selectedText);
  assert.deepEqual(replacement.draft?.rects, incoming.rects);
  assert.equal(replacement.draft?.textSegments?.length, 1);
  assert.equal(multiple.textSegments?.length, 2);
  assert.equal("append" in replacement.draft!, false);
});

test("ordinary replacement can move to a different source while explicit append stays on its original page", () => {
  const current = selectDraftSelection(null, selected()).draft!;
  for (const incoming of [
    selected("Next page", 0.2, { pageIndex: 4 }),
    selected("Different attachment", 0.2, { attachmentId: "attachment-b" }),
    selected("Different paper", 0.2, { paperId: "paper-b" }),
  ]) {
    const replacement = selectDraftSelection(current, incoming);
    assert.equal(replacement.status, "created");
    assert.equal(replacement.draft?.selectedText, incoming.selectedText);
    const append = selectDraftSelection(current, incoming, { append: true });
    assert.equal(append.status, "rejected");
    assert.equal(append.draft, current);
  }
});

test("typed comments protect their exact source from replacement, while Cmd may add another excerpt", () => {
  const current = selectDraftSelection(null, selected()).draft!;
  const incoming = selected("Another passage", 0.6);
  const replacement = selectDraftSelection(current, incoming, { hasComment: true });
  assert.equal(replacement.status, "rejected");
  assert.equal(replacement.draft, current);
  assert.match(replacement.message!, /未保存的评论/);
  const duplicate = selectDraftSelection(current, selected(), { hasComment: true });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.draft, current);
  const append = selectDraftSelection(current, incoming, { append: true, hasComment: true });
  assert.equal(append.status, "appended");
  assert.equal(append.draft?.textSegments?.length, 2);
  // Reselecting only the last excerpt must not discard the first excerpt.
  assert.equal(selectDraftSelection(append.draft, incoming, { hasComment: true }).status, "rejected");
});

test("saving and invalid replacement never erase the current selection", () => {
  const current = selectDraftSelection(null, selected()).draft!;
  for (const append of [false, true]) {
    const result = selectDraftSelection(current, selected("Fresh passage", 0.8), { append, saving: true });
    assert.equal(result.status, "rejected");
    assert.equal(result.draft, current);
  }
  for (const incoming of [selected(""), selected("Text without geometry", 0.3, { rects: [] })]) {
    const result = selectDraftSelection(current, incoming);
    assert.equal(result.status, "rejected");
    assert.equal(result.draft, current);
  }
});

test("only Cmd on Mac and Cmd or Ctrl on other platforms request append", () => {
  assert.equal(shouldAppendPdfSelection({ metaKey: false, ctrlKey: false }, "MacIntel"), false);
  assert.equal(shouldAppendPdfSelection({ metaKey: true, ctrlKey: false }, "MacIntel"), true);
  assert.equal(shouldAppendPdfSelection({ metaKey: false, ctrlKey: true }, "MacIntel"), false);
  assert.equal(shouldAppendPdfSelection({ metaKey: false, ctrlKey: true }, "Win32"), true);
  assert.equal(shouldAppendPdfSelection({ metaKey: false, ctrlKey: true }, "Linux x86_64"), true);
});
