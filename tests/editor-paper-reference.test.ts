import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import {
  paperMarkdown,
  paperInsertion,
  paperTrigger,
  searchPapers,
} from "../src/lib/editor/paper-completion";
import type { Paper } from "../src/lib/types";

const state = (doc: string) =>
  EditorState.create({ doc, extensions: [markdown()] });
const paper = (id: string, values: Partial<Paper> = {}): Paper => ({
  id,
  title: "A paper",
  authors: ["Alice Chen"],
  year: 2024,
  abstract: "",
  sourceUrl: "",
  doi: "10.1234/a",
  arxivId: "2401.01234",
  arxivVersion: null,
  readingStatus: "unread",
  revision: 1,
  createdAt: "2024-01-01",
  updatedAt: "2024-01-01",
  ...values,
});

test("paper picker recognizes the auto-paired brackets and only replaces its own trigger", () => {
  const original = "Before [[quadratic]] after";
  const at = original.indexOf("]]");
  const trigger = paperTrigger(state(original), at);
  assert.ok(trigger);
  assert.equal(trigger.query, "quadratic");
  assert.equal(trigger.text, "[[quadratic]]");
  const replaced = state(original)
    .update({
      changes: {
        from: trigger.from,
        to: trigger.to,
        insert: paperMarkdown(paper("paper-1")),
      },
    })
    .state.doc.toString();
  assert.equal(replaced, "Before [A paper](kb://paper/paper-1) after");
  assert.equal(paperTrigger(state("[[]]"), 2)?.query, "");
  assert.equal(paperTrigger(state("[[unfinished"), 12)?.query, "unfinished");
});

test("paper trigger does not reinterpret escaped text, code, HTML or a link destination", () => {
  for (const [doc, at] of [
    ["\\[[alpha", 8],
    ["`[[alpha`", 8],
    ["```\n[[alpha\n```", 11],
    ["    [[alpha", 11],
    ["[name](https://example.org/[[alpha)", 32],
  ] as const)
    assert.equal(paperTrigger(state(doc), at), null, doc);
});

test("local paper search combines title, author, year and identifiers without preferring legacy reading status", () => {
  const unread = paper("1", { updatedAt: "2025-01-01" });
  const read = paper("2", { readingStatus: "read", title: "Another paper" });
  const unrelated = paper("3", {
    authors: ["Bob"],
    title: "Unrelated",
    year: 2000,
    doi: "",
    arxivId: "",
  });
  assert.deepEqual(
    searchPapers([unread, read, unrelated], "Chen 2024").map(
      (entry) => entry.id,
    ),
    ["1", "2"],
  );
  assert.deepEqual(
    searchPapers([unread, read], "10.1234/a").map((entry) => entry.id),
    ["1", "2"],
  );
  assert.equal(searchPapers([unread, read], "2401.01234").length, 2);
  assert.equal(searchPapers([unread, read], "missing").length, 0);
});

test("title matches outrank recency and picker results ignore reading-list membership", () => {
  const titleMatch = paper("title", { title: "Tensor learning", readingStatus: "unread" });
  const recentMention = paper("recent", {
    title: "Notes on tensor learning", updatedAt: "2025-01-01",
    readingStatus: "read", inReadingList: true,
  });
  const current = [recentMention, titleMatch];
  const expected = ["title", "recent"];
  assert.deepEqual(searchPapers(current, "tensor").map(({ id }) => id), expected);
  const legacyStatesChanged: Paper[] = current.map((entry) => ({
    ...entry,
    readingStatus: entry.readingStatus === "read" ? "unread" : "read",
    inReadingList: !entry.inReadingList,
  }));
  assert.deepEqual(searchPapers(legacyStatesChanged, "tensor").map(({ id }) => id), expected);
});

test("paper links escape Markdown punctuation without exposing arbitrary title markup", () => {
  assert.equal(
    paperMarkdown(paper("id", { title: "A [link] *claim*\n![]" })),
    "[A \\[link\\] \\*claim\\* \\!\\[\\]](kb://paper/id)",
  );
});

test("a delayed paper insertion preserves selected prose when its original trigger has changed", () => {
  const prose = "我的重要原文";
  const original = EditorState.create({
    doc: prose,
    selection: { anchor: 0, head: prose.length },
    extensions: [markdown()],
  });
  const stale = { from: 0, to: 5, text: "[[old", query: "old" };
  const next = original.update(
    paperInsertion(original, paper("new"), stale),
  ).state;
  assert.equal(next.doc.toString(), `${prose}[A paper](kb://paper/new)`);
  assert.equal(next.selection.main.empty, true);
  const withoutTrigger = original.update(
    paperInsertion(original, paper("new")),
  ).state;
  assert.equal(
    withoutTrigger.doc.toString(),
    `${prose}[A paper](kb://paper/new)`,
  );
});

test("a valid original trigger is the only text replaced during delayed insertion", () => {
  const text = "我的重要原文 [[old]] tail";
  const original = EditorState.create({
    doc: text,
    selection: { anchor: 0, head: 6 },
    extensions: [markdown()],
  });
  const trigger = paperTrigger(original, text.indexOf("]]"));
  assert.ok(trigger);
  const next = original.update(
    paperInsertion(original, paper("new"), trigger),
  ).state;
  assert.equal(
    next.doc.toString(),
    "我的重要原文 [A paper](kb://paper/new) tail",
  );
});
