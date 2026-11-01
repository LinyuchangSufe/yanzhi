import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";

/** Wrap each selection, or put the caret between two dollars at each cursor. */
export function inlineMathInsertion(state: EditorState): TransactionSpec {
  const change = state.changeByRange((range) => ({
    changes: {
      from: range.from,
      to: range.to,
      insert: `$${state.sliceDoc(range.from, range.to)}$`,
    },
    range: EditorSelection.range(range.anchor + 1, range.head + 1),
  }));
  return {
    ...change,
    userEvent: "input.math",
    annotations: isolateHistory.of("full"),
    scrollIntoView: true,
  };
}
