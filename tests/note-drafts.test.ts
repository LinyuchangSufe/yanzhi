import assert from "node:assert/strict";
import test from "node:test";
import {
  clearMatchingDraft,
  draftKey,
  editorSessionId,
  readRecoveryDraft,
  writeDraft,
  type NoteDraft,
} from "../src/lib/editor/note-drafts";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const saved = { title: "Research question", body: "Saved understanding" };
const draft = (values: Partial<NoteDraft> = {}): NoteDraft => ({
  ...saved,
  body: "Unsaved understanding",
  revision: 3,
  ...values,
});

test("a page has one session UUID and SSR never seeds a later browser session", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  try {
    Reflect.deleteProperty(globalThis, "document");
    assert.equal(editorSessionId(), "server");
    assert.equal(editorSessionId(), "server");
    Object.defineProperty(globalThis, "document", {
      value: {},
      configurable: true,
    });
    const first = editorSessionId();
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(editorSessionId(), first);
    Object.defineProperty(globalThis, "document", {
      value: {},
      configurable: true,
    });
    assert.notEqual(editorSessionId(), first);
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("saving window A clears only its matching draft and preserves window B for recovery", () => {
  const storage = new MemoryStorage();
  const a = draftKey("note-a", "window-a");
  const b = draftKey("note-a", "window-b");
  const aDraft = draft();
  const bDraft = draft({ body: "Different work in window B" });
  writeDraft(storage, a, aDraft);
  writeDraft(storage, b, bDraft);
  const before = storage.getItem(b);
  clearMatchingDraft(storage, a, aDraft);
  assert.equal(storage.getItem(a), null);
  assert.equal(storage.getItem(b), before);
  assert.equal(readRecoveryDraft(storage, "note-a", aDraft)?.key, b);
  assert.equal(storage.getItem(b), before);
});

test("a late save cannot erase newer content, a renamed title, or a new base revision", () => {
  for (const changed of [
    { body: "Typed during save" },
    { title: "Renamed during save" },
    { revision: 4 },
  ]) {
    const storage = new MemoryStorage();
    const key = draftKey("note-a", "window-a");
    writeDraft(storage, key, draft(changed));
    const before = storage.getItem(key);
    clearMatchingDraft(storage, key, draft());
    assert.equal(storage.getItem(key), before);
  }
});

test("recovery supports the legacy slot and chooses the newest differing scoped draft", () => {
  const storage = new MemoryStorage();
  const legacy = "research-note-draft:note-a";
  storage.setItem(legacy, JSON.stringify(draft()));
  assert.deepEqual(readRecoveryDraft(storage, "note-a", saved), {
    key: legacy,
    value: draft(),
  });
  const older = draftKey("note-a", "older-window");
  const newest = draftKey("note-a", "newest-window");
  storage.setItem(newest, JSON.stringify(draft({ body: "Newest work", updatedAt: 200 })));
  storage.setItem(older, JSON.stringify(draft({ body: "Older work", updatedAt: 100 })));
  assert.equal(readRecoveryDraft(storage, "note-a", saved)?.key, newest);
  assert.equal(storage.length, 3);
});

test("matching content produces no recovery notice regardless of revision or timestamp", () => {
  const storage = new MemoryStorage();
  storage.setItem("research-note-draft:note-a", JSON.stringify({ ...saved, revision: 1 }));
  storage.setItem(draftKey("note-a", "window-b"), JSON.stringify({ ...saved, revision: 9, updatedAt: Date.now() }));
  assert.equal(readRecoveryDraft(storage, "note-a", saved), null);
  const recoverable = draftKey("note-a", "window-c");
  storage.setItem(recoverable, JSON.stringify(draft({ updatedAt: 1 })));
  assert.equal(readRecoveryDraft(storage, "note-a", saved)?.key, recoverable);
});

test("unrelated notes, malformed slots, invalid JSON and invalid draft shapes cannot offer recovery", () => {
  const storage = new MemoryStorage();
  for (const key of [
    "research-note-draft:note-a-other:window",
    "research-note-draft:note-b:window",
    "research-note-draft:note-a:",
    "research-note-draft:note-a:window:extra",
    "unrelated",
  ]) storage.setItem(key, JSON.stringify(draft({ updatedAt: 999 })));
  const invalid = [
    "{not JSON",
    "null",
    "[]",
    JSON.stringify({ title: 1, body: "text", revision: 3 }),
    JSON.stringify({ title: "title", body: null, revision: 3 }),
    JSON.stringify({ title: "title", body: "text" }),
    JSON.stringify(draft({ revision: 0 })),
    JSON.stringify(draft({ revision: 1.5 })),
    JSON.stringify({ ...draft(), revision: "3" }),
  ];
  for (const [index, raw] of invalid.entries())
    storage.setItem(draftKey("note-a", `invalid-${index}`), raw);
  assert.equal(readRecoveryDraft(storage, "note-a", saved), null);
  const invalidKey = draftKey("note-a", "invalid-0");
  clearMatchingDraft(storage, invalidKey, draft());
  assert.equal(storage.getItem(invalidKey), "{not JSON");
});

test("writing refreshes the timestamp without mutating input, and storage failures reach the caller", () => {
  const storage = new MemoryStorage();
  const value = draft({ updatedAt: 1 });
  const key = draftKey("note-a", "window-a");
  const before = Date.now();
  writeDraft(storage, key, value);
  const stored = JSON.parse(storage.getItem(key)!);
  assert.ok(stored.updatedAt >= before && stored.updatedAt <= Date.now());
  assert.equal(value.updatedAt, 1);
  storage.setItem = () => { throw new Error("Storage quota exceeded"); };
  assert.throws(() => writeDraft(storage, key, draft()), /quota/);
});
