import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KBStore, StoreError } from "../src/lib/db";
import { createBackup, restoreBackup } from "../src/lib/archive";
import type { Annotation, Note, Paper, Topic } from "../src/lib/types";
import type { CodexHistory } from "../src/lib/codex-import/types";
import { refreshCodexDiscussion, requireExternalDiscussion, resolveExternalDiscussionSource, saveCodexDiscussion } from "../src/lib/codex-import/store";
import { mutateResearchItem } from "../src/lib/research-items/store";
import { researchSourceFingerprint } from "../src/lib/research-items/sources";
import { researchItemMarkdown } from "../src/lib/research-items/client";
import { researchItemDiscussionDraft } from "../src/lib/research-discussion";
import { exportResearchMarkdown } from "../src/lib/research-export";
import { searchState } from "../src/lib/search";
import { isWorkspaceLink, storedWorkspaceLocation, workspaceHref, workspaceLocation, type WorkspaceLocation } from "../src/lib/workspace-navigation";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-research-integration-"));
  const store = new KBStore(path.join(root, "source"));
  const topic = store.dispatch("topic.create", { title: "TEST · 待核验归属" }) as Topic;
  const paper = store.dispatch("paper.create", { title: "TEST · 合成文献" }) as Paper;
  const attachment = store.addAttachment(paper.id, "software-only.pdf", Buffer.from("%PDF-1.7\nSOFTWARE FIXTURE ONLY\n%%EOF"));
  const annotation = store.dispatch("annotation.create", { paperId: paper.id, attachmentId: attachment.id, kind: "highlight", pageIndex: 2, pageLabel: "1038",
    rects: [{ x: 0.1, y: 0.5, width: 0.5, height: 0.02 }], selectedText: "Synthetic original passage", comment: "Original personal observation" }) as Annotation;
  const note = store.dispatch("note.create", { title: "TEST · 我的假设", purpose: "idea", body: "SYNTHETIC_SNAPSHOT_NEEDLE：这是保存的个人假设，尚未核验。", topicIds: [topic.id] }) as Note;
  const at = "2026-10-31T00:00:00.000Z";
  const history: CodexHistory = { complete: true, protocol: "legacy", source: { id: "synthetic-source", label: "Synthetic Codex", host: "test", home: "/synthetic/not-read", sqliteHome: null, binary: "/not-executed" },
    thread: { id: "synthetic-thread", title: "SYNTHETIC_DISCUSSION_NEEDLE", cwd: "/synthetic", createdAt: at, updatedAt: at },
    turns: [{ id: "turn-1", status: "completed", startedAt: at, messages: [{ id: "user-item", turnId: "turn-1", role: "user", text: "Synthetic imported question" }, { id: "assistant-item", turnId: "turn-1", role: "assistant", text: "Synthetic unverified suggestion" }] }] };
  const discussion = saveCodexDiscussion(store, history, ["turn-1"], { paperIds: [paper.id], topicIds: [topic.id], noteIds: [note.id, topic.noteId] }).discussion;
  const create = (sourceRefs: unknown[] = []) => mutateResearchItem(store, { action: "create", id: randomUUID(), topicId: topic.id, title: "SYNTHETIC_ITEM_NEEDLE", body: "Software integration fixture, not a research result.", sourceRefs });
  return { root, store, topic, paper, attachment, annotation, note, history, discussion, create,
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("central snapshot and full backup restore both research collections and immutable source revisions", () => {
  const f = fixture();
  try {
    const item = f.create([{ kind: "annotation", id: f.annotation.id, revision: f.annotation.revision }, { kind: "externalDiscussion", id: f.discussion.id, revision: f.discussion.revision }, { kind: "note", id: f.note.id, revision: f.note.revision }]);
    const forgedSnapshot = structuredClone(f.store.snapshot()), forged = forgedSnapshot.researchItems![0].sourceRefs[0];
    forged.text = "Forged annotation content with a recomputed fingerprint"; forged.fingerprint = researchSourceFingerprint(forged);
    const rejected = new KBStore(path.join(f.root, "forged-snapshot"));
    try {
      assert.throws(() => rejected.importSnapshot(forgedSnapshot), /与所选原文不一致/);
      assert.deepEqual(rejected.snapshot().researchItems, []); assert.deepEqual(rejected.snapshot().externalDiscussions, []);
      assert.deepEqual(rejected.snapshot().notes, [], "the central import transaction rolls back all earlier inserts");
    } finally { rejected.close(); }
    const newer = structuredClone(f.history); newer.turns[0].messages[1].text = "A later unverified suggestion";
    refreshCodexDiscussion(f.store, f.discussion.id, f.discussion.revision, newer);
    f.store.dispatch("annotation.update", { id: f.annotation.id, revision: f.annotation.revision, comment: "Later personal observation" });
    f.store.dispatch("note.update", { id: f.note.id, revision: f.note.revision, body: "Later personal draft" });
    const archived = mutateResearchItem(f.store, { action: "archive", id: item.id, revision: item.revision });
    const snapshot = f.store.snapshot(), imported = new KBStore(path.join(f.root, "snapshot-only"));
    try {
      imported.importSnapshot(snapshot);
      assert.deepEqual(imported.snapshot().researchItems, [archived]);
      assert.deepEqual(imported.snapshot().externalDiscussions, snapshot.externalDiscussions);
      assert.deepEqual(imported.snapshot().notes, snapshot.notes);
      assert.deepEqual(resolveExternalDiscussionSource(imported, { discussionId: f.discussion.id, revision: 1 }).messages, f.discussion.messages);
    } finally { imported.close(); }
    const restored = new KBStore(restoreBackup(createBackup(f.store), f.root).restoredDirectory);
    try { assert.deepEqual(restored.snapshot(), snapshot); } finally { restored.close(); }
    const exported = exportResearchMarkdown(snapshot), plainExport = exported.replace(/^> ?/gm, "");
    for (const text of [item.id, f.discussion.id, item.sourceRefs[0].text, item.sourceRefs[1].text, item.sourceRefs[2].text, "A later unverified suggestion"])
      assert.ok(plainExport.includes(text), `complete export retains ${text}`);
    assert.match(exported, /已归档/);
  } finally { f.close(); }
});

test("core deletion protects archived owner and result references without partially detaching imported context", () => {
  const f = fixture();
  try {
    const item = f.create([{ kind: "note", id: f.note.id, revision: f.note.revision }]);
    const resolved = mutateResearchItem(f.store, { action: "update", id: item.id, revision: item.revision, status: "resolved", resolution: "User explicitly selected this synthetic observation as the software-test result.", resultRefs: [{ kind: "annotation", id: f.annotation.id, revision: f.annotation.revision }] });
    const archived = mutateResearchItem(f.store, { action: "archive", id: resolved.id, revision: resolved.revision });
    const before = f.store.snapshot();
    for (const [action, id] of [["topic.delete", f.topic.id], ["annotation.delete", f.annotation.id]] as const)
      assert.throws(() => f.store.dispatch(action, { id }), (error) => error instanceof StoreError && error.status === 409 && /归档条目/.test(error.message));
    assert.deepEqual(f.store.snapshot(), before, "failed physical deletes must preserve every owner, source and external revision");
    const second = f.store.dispatch("topic.create", { title: "TEST · Other owner" }) as Topic;
    const restored = mutateResearchItem(f.store, { action: "restore", id: archived.id, revision: archived.revision });
    mutateResearchItem(f.store, { action: "update", id: restored.id, revision: restored.revision, topicId: second.id });
    const topicNote = f.store.snapshot().notes.find(note => note.id === f.topic.noteId)!;
    const written = f.store.dispatch("note.update", { id: topicNote.id, revision: topicNote.revision, body: "A saved topic note used by a different research item." }) as Note;
    const crossOwner = mutateResearchItem(f.store, { action: "create", id: randomUUID(), topicId: second.id, title: "TEST · Cross-owner source", sourceRefs: [{ kind: "note", id: written.id, revision: written.revision }] });
    assert.ok(crossOwner.sourceRefs.length);
    assert.throws(() => f.store.dispatch("topic.delete", { id: f.topic.id }), (error) => error instanceof StoreError && error.status === 409);
  } finally { f.close(); }
});

test("deleting an unreferenced topic detaches only that context and preserves its converted idea note and discussion history", () => {
  const f = fixture();
  try {
    const note = f.store.snapshot().notes.find(note => note.id === f.topic.noteId)!;
    const written = f.store.dispatch("note.update", { id: note.id, revision: note.revision, body: "Preserved topic reasoning when it becomes an idea." }) as Note;
    const before = f.store.snapshot(), result = f.store.dispatch("topic.delete", { id: f.topic.id }) as { id: string; noteId: string };
    assert.equal(result.noteId, written.id);
    const after = f.store.snapshot(), converted = after.notes.find(note => note.id === written.id)!;
    assert.equal(converted.purpose, "idea"); assert.equal(converted.body, written.body); assert.equal(converted.title, written.title);
    assert.equal(after.topics.length, 0); assert.equal(after.relations.some(relation => relation.fromId === f.topic.id || relation.toId === f.topic.id), false);
    const detached = requireExternalDiscussion(f.store, f.discussion.id);
    assert.deepEqual(detached.topicIds, []); assert.deepEqual(detached.noteIds, f.discussion.noteIds); assert.ok(detached.noteIds.includes(converted.id)); assert.deepEqual(detached.paperIds, f.discussion.paperIds);
    assert.equal(detached.revision, f.discussion.revision + 1); assert.deepEqual(detached.messages, f.discussion.messages);
    assert.deepEqual(resolveExternalDiscussionSource(f.store, { discussionId: detached.id, revision: f.discussion.revision }).messages, f.discussion.messages);
    assert.deepEqual(after.annotations, before.annotations); assert.deepEqual(after.researchItems, []);
    const restored = new KBStore(restoreBackup(createBackup(f.store), f.root).restoredDirectory);
    try { assert.deepEqual(restored.snapshot(), after); } finally { restored.close(); }
  } finally { f.close(); }
});

test("research search and links find active items, omit archived items, and round-trip imported discussion locations", () => {
  const f = fixture();
  try {
    const item = f.create(), before = f.store.snapshot();
    assert.deepEqual(searchState(before, "SYNTHETIC_ITEM_NEEDLE").map(result => ({ type: result.type, id: result.id, topicId: result.topicId })), [{ type: "research-item", id: item.id, topicId: f.topic.id }]);
    assert.equal(searchState(before, "SYNTHETIC_DISCUSSION_NEEDLE").find(result => result.type === "discussion")?.id, f.discussion.id);
    const location: WorkspaceLocation = { view: { kind: "discussion", id: f.discussion.id }, section: "discussions", tab: "notes" };
    assert.deepEqual(workspaceLocation(new URL(workspaceHref(location), "http://localhost").search), location);
    assert.deepEqual(storedWorkspaceLocation(location), location);
    for (const kind of ["discussion", "research-item"]) { assert.equal(isWorkspaceLink(`#${kind}/${item.id}`), true); assert.equal(isWorkspaceLink(`#${kind}/../settings`), false); }
    const archived = mutateResearchItem(f.store, { action: "archive", id: item.id, revision: item.revision });
    assert.deepEqual(searchState(f.store.snapshot(), "SYNTHETIC_ITEM_NEEDLE"), []);
    mutateResearchItem(f.store, { action: "restore", id: item.id, revision: archived.revision });
    assert.equal(searchState(f.store.snapshot(), "SYNTHETIC_ITEM_NEEDLE")[0]?.id, item.id);
  } finally { f.close(); }
});

test("continue-discussing uses exact saved snapshots, refuses oversized drafts, and never changes AI, notes or verification state", () => {
  const f = fixture();
  try {
    const item = f.create([{ kind: "note", id: f.note.id, revision: f.note.revision }, { kind: "externalDiscussion", id: f.discussion.id, revision: f.discussion.revision }]);
    f.store.dispatch("note.update", { id: f.note.id, revision: f.note.revision, body: "Live note text must not replace the selected historical snapshot." });
    const before = f.store.snapshot(), draft = researchItemDiscussionDraft(item);
    assert.deepEqual(draft.sources, []); assert.ok(draft.prompt?.includes(item.sourceRefs[0].text));
    assert.ok(draft.prompt?.includes(item.sourceRefs[1].text)); assert.match(draft.prompt!, /仍需核验/);
    assert.ok(!draft.prompt?.includes("Live note text")); assert.equal(item.status, "pending");
    const written = researchItemMarkdown(item); assert.ok(written.includes(`kb://discussion/${f.discussion.id}`)); assert.match(written, /仍需核验/);
    assert.throws(() => researchItemDiscussionDraft({ ...item, body: "x".repeat(12000) }), /12,000/);
    assert.deepEqual(f.store.snapshot(), before, "preparing a draft or note insertion must not save, send or resolve anything");
  } finally { f.close(); }
});
