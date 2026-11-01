import assert from "node:assert/strict";
import test from "node:test";
import {
  PaperAIRequest,
  type PaperAIInput,
  type PaperAITask,
} from "../src/lib/paper-ai-task";
import type { AIContent, Paper } from "../src/lib/types";
import type { PdfSelection } from "../src/components/pdf/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function paper(overrides: Partial<Paper> = {}): Paper {
  return {
    id: "paper-a", title: "A source paper", authors: ["Researcher"], year: 2026,
    abstract: "Source abstract", sourceUrl: "", doi: "", arxivId: "",
    arxivVersion: null, readingStatus: "reading", revision: 1,
    createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z",
    ...overrides,
  };
}

function selection(overrides: Partial<PdfSelection> = {}): PdfSelection {
  return {
    paperId: "paper-a", attachmentId: "attachment-a", pageIndex: 2,
    pageLabel: "3", selectedText: "The proposed objective converges.",
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
    ...overrides,
  };
}

function result(overrides: Partial<AIContent> = {}): AIContent {
  return {
    id: "result-a", paperId: "paper-a", kind: "explanation",
    body: "Contextual explanation", provider: "test", model: "boundary",
    sourceScope: "selection_context", sourceAttachmentId: "attachment-a",
    sourcePageIndices: [2], sourceText: "The proposed objective converges.",
    status: "completed", createdAt: "2026-10-29T00:00:00Z", ...overrides,
  };
}

function harness() {
  const calls: {
    input: PaperAIInput;
    signal: AbortSignal;
    completion: ReturnType<typeof deferred<AIContent>>;
  }[] = [];
  const tasks: (PaperAITask | null)[] = [];
  const results: AIContent[] = [];
  const request = new PaperAIRequest({
    run(input, signal) {
      const completion = deferred<AIContent>();
      calls.push({ input, signal, completion });
      return completion.promise;
    },
    onTask: (task) => tasks.push(structuredClone(task)),
    onResult: (value) => results.push(value),
  });
  return { request, calls, tasks, results, latest: () => tasks.at(-1) };
}

test("cancel aborts the actual transport signal and releases the visible request immediately", async () => {
  const h = harness();
  const pending = h.request.start(paper(), "explanation", selection());
  const signal = h.calls[0].signal;
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  let aborted = 0;
  signal.addEventListener("abort", () => { aborted += 1; });
  h.request.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(aborted, 1);
  assert.equal(h.latest()?.status, "cancelled");
  h.request.cancel();
  assert.equal(aborted, 1);
  h.calls[0].completion.reject(new DOMException("Cancelled", "AbortError"));
  await pending;
  assert.equal(h.latest()?.status, "cancelled");
  assert.deepEqual(h.results, []);
});

test("repeated start cannot dispatch concurrent work or replace a running request", async () => {
  const h = harness();
  const pending = h.request.start(paper(), "explanation", selection());
  const firstTask = h.latest();
  assert.equal(await h.request.start(paper({ id: "paper-b" }), "summary"), false);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.latest(), firstTask);
  h.request.dismiss();
  assert.deepEqual(h.latest(), firstTask);
  h.calls[0].completion.resolve(result());
  assert.equal(await pending, true);
  assert.equal(h.latest()?.status, "done");
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`a cancelled task's late ${outcome} cannot replace or finish a newer request`, async () => {
    const h = harness();
    const old = h.request.start(paper(), "explanation", selection());
    const oldId = h.latest()?.id;
    h.request.cancel();
    const next = h.request.start(paper({ id: "paper-b", title: "Another source" }), "summary");
    const active = h.latest();
    assert.notEqual(active?.id, oldId);
    assert.equal(active?.paperId, "paper-b");
    assert.equal(active?.status, "running");
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.calls[1].signal.aborted, false);
    const eventCount = h.tasks.length;
    if (outcome === "resolve") h.calls[0].completion.resolve(result());
    else h.calls[0].completion.reject(new Error("Old provider failure"));
    await old;
    assert.equal(h.tasks.length, eventCount);
    assert.deepEqual(h.latest(), active);
    assert.deepEqual(h.results, []);
    const response = result({ id: "result-b", paperId: "paper-b", kind: "summary" });
    h.calls[1].completion.resolve(response);
    await next;
    assert.deepEqual(h.results, [response]);
    assert.equal(h.latest()?.resultId, response.id);
    assert.equal(h.latest()?.paperId, response.paperId);
    assert.equal(h.latest()?.kind, response.kind);
    assert.equal(h.latest()?.status, "done");
  });
}

test("the selected excerpt, location and paper title remain the original request snapshot", async () => {
  const h = harness();
  const source = paper();
  const excerpt = selection();
  const expected = structuredClone(excerpt);
  const pending = h.request.start(source, "explanation", excerpt);
  excerpt.selectedText = "A different selection made while waiting";
  excerpt.pageIndex = 9;
  excerpt.attachmentId = "new-attachment";
  excerpt.rects[0].x = 0.8;
  source.title = "A later title";
  assert.deepEqual(h.calls[0].input, {
    paperId: "paper-a", kind: "explanation", selection: expected.selectedText,
    attachmentId: expected.attachmentId, pageIndex: expected.pageIndex,
  });
  h.calls[0].completion.resolve(result());
  await pending;
  assert.deepEqual(h.latest()?.selection, expected);
  assert.equal(h.latest()?.paperTitle, "A source paper");
});

test("missing, whitespace-only, foreign selections and trashed papers fail before dispatch", async () => {
  const invalid = [
    { paper: paper(), kind: "explanation" as const, selection: undefined },
    { paper: paper(), kind: "translation" as const, selection: selection({ selectedText: " \n\t " }) },
    { paper: paper(), kind: "explanation" as const, selection: selection({ paperId: "paper-b" }) },
    { paper: paper({ deletedAt: "2026-10-29T01:00:00Z" }), kind: "summary" as const, selection: undefined },
    { paper: paper({ deletedAt: "2026-10-29T01:00:00Z" }), kind: "translation" as const, selection: selection() },
  ];
  for (const source of invalid) {
    const h = harness();
    assert.equal(await h.request.start(source.paper, source.kind, source.selection), true);
    assert.equal(h.calls.length, 0);
    assert.equal(h.latest()?.status, "error");
    assert.ok(h.latest()?.error);
    assert.deepEqual(h.results, []);
    h.request.dismiss();
    assert.equal(h.latest(), null);
  }
});

test("successful translation publishes only AI content with the matching paper and result identity", async () => {
  const h = harness();
  const source = paper();
  const excerpt = selection();
  const originals = structuredClone({ source, excerpt });
  const pending = h.request.start(source, "translation", excerpt);
  const response = result({ kind: "translation", body: "提出的目标会收敛。", sourceScope: "selection" });
  h.calls[0].completion.resolve(response);
  await pending;
  assert.deepEqual(h.results, [response]);
  assert.deepEqual({ source, excerpt }, originals);
  assert.equal(h.latest()?.paperId, response.paperId);
  assert.equal(h.latest()?.resultId, response.id);
  assert.equal(h.latest()?.kind, response.kind);
  assert.equal(h.latest()?.status, "done");
  assert.deepEqual(Object.keys(h.calls[0].input).sort(), [
    "attachmentId", "kind", "pageIndex", "paperId", "selection",
  ]);
});

test("transport failures remain attached to their source and allow a new request", async () => {
  const h = harness();
  const pending = h.request.start(paper(), "translation", selection());
  h.calls[0].completion.reject(new Error("Provider unavailable"));
  await pending;
  assert.equal(h.latest()?.status, "error");
  assert.equal(h.latest()?.paperId, "paper-a");
  assert.equal(h.latest()?.error, "Provider unavailable");
  assert.deepEqual(h.results, []);
  const next = h.request.start(paper(), "summary");
  assert.equal(h.calls.length, 2);
  h.calls[1].completion.resolve(result({ kind: "summary" }));
  await next;
  assert.equal(h.latest()?.status, "done");
});

for (const mismatch of [{ paperId: "paper-b" }, { kind: "summary" as const }]) {
  test(`an unrelated transport result (${JSON.stringify(mismatch)}) is never shown as this request's answer`, async () => {
    const h = harness();
    const pending = h.request.start(paper(), "explanation", selection());
    h.calls[0].completion.resolve(result(mismatch));
    await pending;
    assert.deepEqual(h.results, []);
    assert.equal(h.latest()?.status, "error");
    assert.ok(h.latest()?.error);
    assert.equal(h.latest()?.resultId, undefined);
  });
}

test("disposing aborts in-flight transport and prevents late callbacks", async () => {
  const h = harness();
  const pending = h.request.start(paper(), "explanation", selection());
  const eventCount = h.tasks.length;
  h.request.dispose();
  assert.equal(h.calls[0].signal.aborted, true);
  h.calls[0].completion.resolve(result());
  await pending;
  assert.equal(h.tasks.length, eventCount);
  assert.deepEqual(h.results, []);
});

test("whole-page Markdown recognition accepts an empty text layer and omits selection rectangles", async () => {
  for (const rects of [[], selection().rects]) {
    const h = harness();
    const page = selection({ extractionScope: "page", selectedText: "", rects });
    const pending = h.request.start(paper(), "markdown", page);
    assert.deepEqual(h.calls[0].input, {
      paperId: "paper-a", kind: "markdown", attachmentId: "attachment-a", pageIndex: 2,
    });
    assert.equal("rects" in h.calls[0].input, false);
    assert.equal("selection" in h.calls[0].input, false);
    assert.equal(h.latest()?.selection?.extractionScope, "page");
    const response = result({ kind: "markdown", sourceScope: "page_image", body: "A page with $x^2$." });
    h.calls[0].completion.resolve(response);
    await pending;
    assert.equal(h.latest()?.status, "done");
    assert.deepEqual(h.results, [response]);
  }
});

for (const selectedText of ["The equation is corrupted in the text layer.", ""]) {
  test(`Markdown ${selectedText ? "text selection" : "image-only region"} sends an immutable source rectangle snapshot`, async () => {
    const h = harness();
    const source = selection({ extractionScope: "selection", selectedText });
    const expected = structuredClone(source);
    const pending = h.request.start(paper(), "markdown", source);
    source.attachmentId = "later-attachment";
    source.pageIndex = 8;
    source.selectedText = "A later selection";
    source.extractionScope = "page";
    source.rects[0].x = 0.9;
    source.rects.push({ x: 0.5, y: 0.5, width: 0.2, height: 0.2 });
    assert.deepEqual(h.calls[0].input, {
      paperId: "paper-a", kind: "markdown", attachmentId: expected.attachmentId,
      pageIndex: expected.pageIndex, rects: expected.rects,
      ...(selectedText ? { selection: selectedText } : {}),
    });
    assert.equal("extractionScope" in h.calls[0].input, false);
    h.calls[0].completion.resolve(result({ kind: "markdown", sourceScope: "selection_image" }));
    await pending;
    assert.deepEqual(h.latest()?.selection, expected);
    assert.equal(h.latest()?.status, "done");
  });
}

test("Markdown requests with missing sources, foreign papers, invalid pages or empty selection rectangles fail before dispatch", async () => {
  const invalid: (PdfSelection | undefined)[] = [
    undefined,
    selection({ paperId: "paper-b" }),
    selection({ attachmentId: "" }),
    selection({ pageIndex: -1 }),
    selection({ pageIndex: 1.5 }),
    selection({ pageIndex: Number.NaN }),
    selection({ pageIndex: Number.POSITIVE_INFINITY }),
    selection({ extractionScope: "selection", rects: [] }),
    selection({ rects: [] }),
  ];
  for (const source of invalid) {
    const h = harness();
    assert.equal(await h.request.start(paper(), "markdown", source), true);
    assert.equal(h.calls.length, 0);
    assert.equal(h.latest()?.status, "error");
    assert.ok(h.latest()?.error);
    assert.deepEqual(h.results, []);
  }
  const h = harness();
  await h.request.start(paper({ deletedAt: "2026-10-29T01:00:00Z" }), "markdown", selection());
  assert.equal(h.calls.length, 0);
  assert.equal(h.latest()?.status, "error");
});

test("saved Markdown history opens its original result without dispatching recognition or replacing active work", async () => {
  const h = harness();
  const saved = result({ kind: "markdown", sourceScope: "selection_image", body: "$x_{t+1} = x_t$" });
  assert.equal(h.request.showSaved(paper(), saved), true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.latest()?.kind, "markdown");
  assert.equal(h.latest()?.status, "done");
  assert.equal(h.latest()?.resultId, saved.id);
  assert.equal(h.latest()?.selection, undefined);
  assert.deepEqual(h.results, [saved]);
  const shown = h.latest();
  assert.equal(h.request.showSaved(paper({ id: "paper-b" }), saved), false);
  assert.deepEqual(h.latest(), shown);
  const pending = h.request.start(paper(), "markdown", selection());
  const running = h.latest();
  assert.equal(h.request.showSaved(paper(), saved), false);
  assert.deepEqual(h.latest(), running);
  assert.equal(h.calls.length, 1);
  h.calls[0].completion.resolve(result({ id: "new-markdown", kind: "markdown" }));
  await pending;
  assert.equal(h.latest()?.resultId, "new-markdown");
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`cancelled Markdown recognition ignores a late ${outcome} while a new page is being recognized`, async () => {
    const h = harness();
    const first = h.request.start(paper(), "markdown", selection());
    h.request.cancel();
    const next = h.request.start(paper(), "markdown", selection({
      pageIndex: 4, extractionScope: "page", rects: [], selectedText: "",
    }));
    const running = h.latest();
    const events = h.tasks.length;
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.calls[1].signal.aborted, false);
    if (outcome === "resolve") h.calls[0].completion.resolve(result({ kind: "markdown" }));
    else h.calls[0].completion.reject(new Error("Late recognition failure"));
    await first;
    assert.equal(h.tasks.length, events);
    assert.deepEqual(h.latest(), running);
    assert.deepEqual(h.results, []);
    const response = result({ id: "page-five", kind: "markdown", sourcePageIndices: [4], sourceScope: "page_image" });
    h.calls[1].completion.resolve(response);
    await next;
    assert.deepEqual(h.results, [response]);
    assert.equal(h.latest()?.resultId, response.id);
    assert.equal(h.latest()?.selection?.pageIndex, 4);
  });
}

test("Markdown recognition rejects a transport reply belonging to a different AI operation", async () => {
  const h = harness();
  const pending = h.request.start(paper(), "markdown", selection());
  h.calls[0].completion.resolve(result({ kind: "translation" }));
  await pending;
  assert.equal(h.latest()?.status, "error");
  assert.equal(h.latest()?.resultId, undefined);
  assert.deepEqual(h.results, []);
});
