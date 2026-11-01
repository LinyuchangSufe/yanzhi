import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { KBStore } from "../src/lib/db";
import { createCodexHistoryHandlers } from "../src/lib/codex-import/handlers";
import { codexHistoryHash, detachExternalDiscussionEntity, externalDiscussionSnapshot, importExternalDiscussions, initCodexImportSchema, linkExternalDiscussion, refreshCodexDiscussion, requireExternalDiscussion, resolveExternalDiscussionSource, saveCodexDiscussion } from "../src/lib/codex-import/store";
import type { CodexHistory, ExternalDiscussion } from "../src/lib/codex-import/types";

const at = "2026-10-31T00:00:00.000Z";
const history = (): CodexHistory => ({ thread: { id: "codex-thread-fixture", title: "TEST imported discussion", cwd: "/synthetic/project", createdAt: at, updatedAt: at }, source: { id: "synthetic-profile", label: "TEST local", host: "synthetic", home: "/synthetic/.codex", sqliteHome: null, binary: "fake-codex" }, complete: true, protocol: "paginated", turns: [
  { id: "turn-1", status: "completed", startedAt: at, messages: [{ id: "user-1", turnId: "turn-1", role: "user", text: "TEST question" }, { id: "assistant-1", turnId: "turn-1", role: "assistant", text: "TEST answer" }] },
  { id: "turn-2", status: "completed", startedAt: at, messages: [{ id: "user-2", turnId: "turn-2", role: "user", text: "TEST unrelated later question" }] },
] });
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kb-codex-import-")), store = new KBStore(dir); initCodexImportSchema(store);
  store.dispatch("topic.create", { title: "TEST topic", description: "TEST description" });
  store.dispatch("paper.create", { title: "TEST paper" });
  const state = store.snapshot(), topicId = state.topics[0]!.id, noteId = state.topics[0]!.noteId, paperId = state.papers[0]!.id;
  return { store, topicId, noteId, paperId, context: { paperIds: [paperId], topicIds: [topicId], noteIds: [noteId] }, close: () => { store.close(); rmSync(dir, { force: true, recursive: true }); } };
}
const status = (value: unknown) => value instanceof Error && "status" in value ? value.status : undefined;

test("only selected turns are imported, ID-set dedup is idempotent, and personal notes stay untouched", () => {
  const f = fixture(); try {
    const before = f.store.snapshot().notes;
    const result = saveCodexDiscussion(f.store, history(), ["turn-1"], f.context);
    assert.equal(result.reused, false); assert.equal(result.discussion.messages.length, 2);
    assert.ok(result.discussion.messages.every((message) => message.turnId === "turn-1"));
    const newer = history(); newer.turns[0]!.messages[1]!.text = "TEST changed source";
    const duplicate = saveCodexDiscussion(f.store, newer, ["turn-1"], f.context);
    assert.equal(duplicate.reused, true); assert.equal(duplicate.discussion.id, result.discussion.id);
    assert.equal(duplicate.discussion.messages[1]!.text, "TEST answer", "reimport does not silently refresh a saved copy");
    assert.equal(externalDiscussionSnapshot(f.store).length, 1); assert.deepEqual(f.store.snapshot().notes, before);
    assert.equal(result.discussion.sourceHref, "codex://threads/codex-thread-fixture");
  } finally { f.close(); }
});
test("refresh touches only selected turns, retains every referenced revision, and rejects stale/profile/missing-turn changes", () => {
  const f = fixture(); try {
    const first = saveCodexDiscussion(f.store, history(), ["turn-1"], f.context).discussion;
    const relinked = linkExternalDiscussion(f.store, first.id, first.revision, { ...f.context, paperIds: [] });
    const next = history(); next.turns[0]!.messages[1]!.text = "TEST updated answer"; next.thread.updatedAt = "2026-10-31T00:01:00.000Z";
    const result = refreshCodexDiscussion(f.store, first.id, relinked.revision, next);
    assert.equal(result.changed, true); assert.equal(result.discussion.messages.length, 2);
    assert.equal(result.discussion.messages[1]!.text, "TEST updated answer");
    assert.equal(resolveExternalDiscussionSource(f.store, { discussionId: first.id, revision: first.revision }).messages[1]!.text, "TEST answer");
    assert.equal(resolveExternalDiscussionSource(f.store, { discussionId: first.id, revision: relinked.revision }).messages[1]!.text, "TEST answer");
    assert.throws(() => refreshCodexDiscussion(f.store, first.id, first.revision, next), (error) => status(error) === 409);
    const wrong = history(); wrong.source.id = "different-home";
    assert.throws(() => refreshCodexDiscussion(f.store, first.id, result.discussion.revision, wrong), (error) => status(error) === 409);
    const missing = history(); missing.turns = missing.turns.slice(1);
    assert.throws(() => refreshCodexDiscussion(f.store, first.id, result.discussion.revision, missing), (error) => status(error) === 409);
    assert.deepEqual(requireExternalDiscussion(f.store, first.id), result.discussion, "failed refresh leaves the exact saved record intact");
    assert.throws(() => resolveExternalDiscussionSource(f.store, { discussionId: first.id, messageIds: ["not-in-import"] }), (error) => status(error) === 422);
  } finally { f.close(); }
});
test("context validation refuses missing/trashed papers and detach removes only association with a recoverable revision", () => {
  const f = fixture(); try {
    assert.throws(() => saveCodexDiscussion(f.store, history(), ["turn-1"], { ...f.context, topicIds: [randomUUID()] }), (error) => status(error) === 409);
    f.store.db.prepare("UPDATE papers SET deleted_at=? WHERE id=?").run(at, f.paperId);
    assert.throws(() => saveCodexDiscussion(f.store, history(), ["turn-1"], f.context), (error) => status(error) === 409);
    const first = saveCodexDiscussion(f.store, history(), ["turn-1"], { ...f.context, paperIds: [] }).discussion;
    f.store.db.exec("BEGIN IMMEDIATE"); detachExternalDiscussionEntity(f.store, "topic", f.topicId); f.store.db.exec("COMMIT");
    const result = requireExternalDiscussion(f.store, first.id); assert.deepEqual(result.topicIds, []); assert.equal(result.revision, first.revision + 1);
    assert.deepEqual(resolveExternalDiscussionSource(f.store, { discussionId: first.id, revision: 1 }).messages, first.messages);
  } finally { f.close(); }
});
test("backup helper preserves current and historic text, checks hashes, and rejects unknown ownership", () => {
  const f = fixture(); try {
    const first = saveCodexDiscussion(f.store, history(), ["turn-1"], f.context).discussion;
    const h = history(); h.turns[0]!.messages[1]!.text = "TEST revision two"; refreshCodexDiscussion(f.store, first.id, 1, h);
    const snapshot = externalDiscussionSnapshot(f.store);
    f.store.db.exec("DELETE FROM external_discussions"); importExternalDiscussions(f.store, snapshot);
    assert.deepEqual(externalDiscussionSnapshot(f.store), snapshot);
    f.store.db.exec("DELETE FROM external_discussions");
    const corrupt = structuredClone(snapshot); corrupt[0]!.messages[0]!.text = "TEST tampered";
    assert.throws(() => importExternalDiscussions(f.store, corrupt), (error) => status(error) === 422);
    assert.equal(externalDiscussionSnapshot(f.store).length, 0);
    assert.throws(() => importExternalDiscussions(f.store, [{ ...snapshot[0]!, topicIds: [randomUUID()] }]), (error) => status(error) === 409);
  } finally { f.close(); }
});
test("route lists/reads without saving, imports only server-read selected IDs, and prevents CSRF and changed-preview writes", async () => {
  const f = fixture(); let current = history(), reads = 0; const lists: unknown[] = [];
  const handlers = createCodexHistoryHandlers({ getStore: () => f.store, list: async (input) => { lists.push(input); return { data: [current.thread], nextCursor: "next", source: current.source }; }, read: async () => { reads++; return structuredClone(current); } });
  const get = (query = "") => new Request(`http://127.0.0.1:3000/api/kb/codex-history${query}`, { headers: { host: "127.0.0.1:3000" } });
  const post = (body: unknown, origin = "http://127.0.0.1:3000") => new Request("http://127.0.0.1:3000/api/kb/codex-history", { method: "POST", headers: { host: "127.0.0.1:3000", origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await handlers.GET(get("?search=TEST&cwd=%2Fsynthetic%2Fproject"))).status, 200); assert.equal(lists.length, 1);
    const preview = await (await handlers.GET(get("?threadId=codex-thread-fixture"))).json() as CodexHistory & { historyHash: string };
    assert.equal(preview.historyHash, codexHistoryHash(current)); assert.equal(externalDiscussionSnapshot(f.store).length, 0);
    const body = { action: "import", threadId: current.thread.id, sourceId: current.source.id, historyHash: preview.historyHash, selectedTurnIds: ["turn-1"], context: f.context };
    assert.equal((await handlers.POST(post(body, "https://evil.example"))).status, 403); assert.equal(reads, 1);
    assert.equal((await handlers.POST(post({ ...body, messages: [{ text: "TEST injected text" }] }))).status, 400);
    current.turns[0]!.messages[0]!.text = "TEST changed after preview";
    assert.equal((await handlers.POST(post(body))).status, 409); assert.equal(externalDiscussionSnapshot(f.store).length, 0);
    const imported = await handlers.POST(post({ ...body, historyHash: codexHistoryHash(current) })); assert.equal(imported.status, 200);
    const result = await imported.json() as { discussion: ExternalDiscussion }; assert.equal(result.discussion.messages.length, 2);
    assert.equal((await handlers.POST(post({ action: "refresh", id: result.discussion.id, revision: 999 }))).status, 409);
    assert.equal(externalDiscussionSnapshot(f.store).length, 1);
  } finally { f.close(); }
});
test("route cancellation never imports after a completed read; explicit refresh and link keep revisions and scope", async () => {
  const f = fixture(), controller = new AbortController(); let cancel = true, current = history();
  const handlers = createCodexHistoryHandlers({ getStore: () => f.store, read: async () => { if (cancel) controller.abort(); return structuredClone(current); } });
  const post = (body: unknown, signal?: AbortSignal) => new Request("http://localhost/api/kb/codex-history", { method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body), signal });
  try {
    const body = { action: "import", threadId: current.thread.id, sourceId: current.source.id, historyHash: codexHistoryHash(current), selectedTurnIds: ["turn-1"], context: f.context };
    assert.equal((await handlers.POST(post(body, controller.signal))).status, 499); assert.equal(externalDiscussionSnapshot(f.store).length, 0);
    cancel = false;
    const saved = await (await handlers.POST(post(body))).json() as { discussion: ExternalDiscussion };
    current.turns[0]!.status = "inProgress"; current.turns[0]!.messages[1]!.text = "TEST partial refreshed answer";
    const refreshed = await (await handlers.POST(post({ action: "refresh", id: saved.discussion.id, revision: saved.discussion.revision }))).json() as { discussion: ExternalDiscussion };
    assert.equal(refreshed.discussion.turnStatuses?.["turn-1"], "inProgress");
    assert.match(resolveExternalDiscussionSource(f.store, { discussionId: saved.discussion.id }).text, /尚未完整结束/);
    assert.equal(resolveExternalDiscussionSource(f.store, { discussionId: saved.discussion.id, revision: 1 }).messages[1]!.text, "TEST answer");
    const response = await handlers.POST(post({ action: "link", id: saved.discussion.id, revision: refreshed.discussion.revision, context: { paperIds: [], topicIds: [], noteIds: [] } }));
    assert.equal(response.status, 200); assert.deepEqual(requireExternalDiscussion(f.store, saved.discussion.id).topicIds, []);
    assert.equal(requireExternalDiscussion(f.store, saved.discussion.id).messages.length, 2);
  } finally { f.close(); }
});
