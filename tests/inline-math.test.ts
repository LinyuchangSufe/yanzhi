import assert from "node:assert/strict";
import test from "node:test";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { inlineMathInsertion } from "../src/lib/editor/inline-math";

test("inline math inserts exactly two dollars into an empty note and places the caret between them", () => {
  const original = EditorState.create();
  const next = original.update(inlineMathInsertion(original)).state;
  assert.equal(next.doc.toString(), "$$");
  assert.equal(next.selection.main.empty, true);
  assert.equal(next.selection.main.head, 1);
});

test("inline math preserves surrounding Unicode prose and types inside the new delimiters", () => {
  const before = "前文🙂";
  const after = "，后文保持原样。";
  const original = EditorState.create({
    doc: before + after,
    selection: { anchor: before.length },
  });
  const inserted = original.update(inlineMathInsertion(original)).state;
  assert.equal(inserted.doc.toString(), `${before}$$${after}`);
  assert.equal(inserted.selection.main.head, before.length + 1);
  const typed = inserted.update(inserted.replaceSelection("x^2")).state;
  assert.equal(typed.doc.toString(), `${before}$x^2$${after}`);
});

test("inline math wraps selected text without losing its content or selection direction", () => {
  const doc = "前文 x + y 后文";
  const from = doc.indexOf("x");
  const to = from + "x + y".length;
  for (const [anchor, head] of [[from, to], [to, from]]) {
    const original = EditorState.create({ doc, selection: { anchor, head } });
    const next = original.update(inlineMathInsertion(original)).state;
    assert.equal(next.doc.toString(), "前文 $x + y$ 后文");
    assert.equal(next.selection.main.anchor, anchor + 1);
    assert.equal(next.selection.main.head, head + 1);
    assert.equal(next.sliceDoc(next.selection.main.from, next.selection.main.to), "x + y");
  }
});

test("inline math maps multiple cursors and both selection directions in one transaction", () => {
  const original = EditorState.create({
    doc: "alpha beta gamma",
    selection: EditorSelection.create([
      EditorSelection.cursor(0),
      EditorSelection.range(4, 1),
      EditorSelection.range(6, 10),
      EditorSelection.cursor(16),
    ], 2),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });
  const next = original.update(inlineMathInsertion(original)).state;
  assert.equal(next.doc.toString(), "$$a$lph$a $beta$ gamma$$");
  assert.equal(next.selection.mainIndex, 2);
  assert.deepEqual(next.selection.ranges.map(({ anchor, head }) => [anchor, head]), [
    [1, 1], [7, 4], [11, 15], [23, 23],
  ]);
});

test("inline math and adjacent typing each undo and redo independently", () => {
  let state = EditorState.create({ doc: "start ", selection: { anchor: 6 }, extensions: [history()] });
  const dispatch = (transaction: Transaction) => { state = transaction.state; };
  const time = Date.now();
  dispatch(state.update(state.replaceSelection("a"), {
    userEvent: "input.type", annotations: Transaction.time.of(time),
  }));
  dispatch(state.update(inlineMathInsertion(state), {
    annotations: Transaction.time.of(time + 1),
  }));
  dispatch(state.update(state.replaceSelection("x"), {
    userEvent: "input.type", annotations: Transaction.time.of(time + 2),
  }));
  assert.equal(state.doc.toString(), "start a$x$");

  for (const expected of ["start a$$", "start a", "start "]) {
    assert.equal(undo({ state, dispatch }), true);
    assert.equal(state.doc.toString(), expected);
  }
  assert.equal(undo({ state, dispatch }), false);
  for (const expected of ["start a", "start a$$", "start a$x$"]) {
    assert.equal(redo({ state, dispatch }), true);
    assert.equal(state.doc.toString(), expected);
  }
  assert.equal(redo({ state, dispatch }), false);
});

test("undo restores all original selected text and redo restores both wrapped text ranges", () => {
  const selection = EditorSelection.create([EditorSelection.range(5, 0), EditorSelection.range(6, 10)], 1);
  let state = EditorState.create({
    doc: "alpha beta",
    selection,
    extensions: [EditorState.allowMultipleSelections.of(true), history()],
  });
  const dispatch = (transaction: Transaction) => { state = transaction.state; };
  dispatch(state.update(inlineMathInsertion(state)));
  assert.equal(state.doc.toString(), "$alpha$ $beta$");
  assert.equal(undo({ state, dispatch }), true);
  assert.equal(state.doc.toString(), "alpha beta");
  assert.equal(state.selection.eq(selection), true);
  assert.equal(redo({ state, dispatch }), true);
  assert.equal(state.doc.toString(), "$alpha$ $beta$");
  assert.equal(state.selection.ranges.length, selection.ranges.length);
  assert.equal(state.selection.mainIndex, selection.mainIndex);
});
