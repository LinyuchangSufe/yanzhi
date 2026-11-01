import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createLibrarySearch, emptyLibrarySearch, visibleLibrarySearch, type LibrarySearchSnapshot } from "../src/lib/library-search";
import type { SearchResult } from "../src/lib/types";

const result = (id: string): SearchResult => ({ type: "paper", id, title: id, snippet: id });

test("a new query becomes pending before debounce and never exposes the previous query's records", async () => {
  const changes: LibrarySearchSnapshot[] = [];
  const calls: string[] = [];
  const search = createLibrarySearch({ delayMs: 15, onChange: (value) => changes.push(value),
    load: async (query) => { calls.push(query); return [result(query)]; } });
  search.search("first");
  assert.equal(changes.at(-1)?.status, "pending");
  search.search(" second ");
  assert.deepEqual(changes.at(-1), { query: "second", status: "pending", results: [], error: "" });
  assert.deepEqual(calls, []);
  await delay(30);
  assert.deepEqual(calls, ["second"]);
  assert.deepEqual(changes.at(-1)?.results, [result("second")]);
  search.cancel();
});

test("late responses cannot replace the current query even when the transport ignores abort", async () => {
  const changes: LibrarySearchSnapshot[] = [];
  const pending = new Map<string, { signal: AbortSignal; resolve: (records: SearchResult[]) => void }>();
  const search = createLibrarySearch({ delayMs: 0, onChange: (value) => changes.push(value),
    load: (query, signal) => new Promise((resolve) => pending.set(query, { signal, resolve })) });
  search.search("old");
  await delay(5);
  search.search("new");
  await delay(5);
  assert.equal(pending.get("old")?.signal.aborted, true);
  pending.get("new")?.resolve([result("new")]);
  await delay(0);
  pending.get("old")?.resolve([result("old")]);
  await delay(0);
  assert.equal(changes.at(-1)?.query, "new");
  assert.deepEqual(changes.at(-1)?.results, [result("new")]);
  search.cancel();
});

test("a failed query has its own error with no stale records and can be retried", async () => {
  let state = emptyLibrarySearch;
  let fails = true;
  const search = createLibrarySearch({ delayMs: 0, onChange: (value) => { state = value; },
    load: async (query) => { if (fails) throw new Error("offline"); return [result(query)]; } });
  search.search("SGD");
  await delay(5);
  assert.equal(state.status, "error");
  assert.equal(state.error, "offline");
  assert.deepEqual(state.results, []);
  fails = false;
  search.search("SGD");
  assert.equal(state.status, "pending");
  await delay(5);
  assert.equal(state.status, "ready");
  assert.deepEqual(state.results, [result("SGD")]);
  search.search("");
  assert.equal(state, emptyLibrarySearch);
  search.cancel();
});

test("the render state cannot expose old records before the query effect runs", () => {
  const old: LibrarySearchSnapshot = { query: "old", status: "ready", results: [result("old")], error: "" };
  assert.equal(visibleLibrarySearch(old, "new").status, "pending");
  assert.deepEqual(visibleLibrarySearch(old, "new").results, []);
  assert.equal(visibleLibrarySearch(old, ""), emptyLibrarySearch);
});
