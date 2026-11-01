import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { KBStore, StoreError } from "../src/lib/db";
import { createBackup, exportMarkdown, restoreBackup } from "../src/lib/archive";
import type { Note, Topic } from "../src/lib/types";
import { beginIdeaTurn, expireIdeaLeases, ideaConversationSnapshot, ideaSummarySnapshot,
  requireIdeaConversation, saveIdeaSummary, updateIdeaMessage } from "../src/lib/idea-lab/store";
import { ideaSourceSnapshotSchema, ideaSummarySchema } from "../src/lib/idea-lab/schemas";
import type { IdeaMessage, IdeaSourceSnapshot, IdeaSummary } from "../src/lib/idea-lab/types";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-idea-lab-"));
  const store = new KBStore(path.join(root, "source"));
  const note = store.dispatch("note.create", { title: "TEST · 一个待推敲的想法", purpose: "idea", body: "# 我的原稿\n\n原有公式 $x^2$ 和自己的判断。" }) as Note;
  const other = store.dispatch("note.create", { title: "TEST · 资料笔记", purpose: "idea", body: "明确选择的资料原文。" }) as Note;
  const topic = store.dispatch("topic.create", { title: "TEST · 研究问题" }) as Topic;
  const source: IdeaSourceSnapshot = { id: `note:${other.id}:body:0:${other.body.length}:r1`, type: "note", entityId: other.id,
    field: "body", title: other.title, text: other.body, sourceHref: `kb://note/${other.id}`, revision: 1, start: 0, end: other.body.length };
  const begin = (fields: Partial<Parameters<typeof beginIdeaTurn>[1]> = {}) => beginIdeaTurn(store, {
    noteId: note.id, requestId: randomUUID(), message: "如何梳理这个软件测试想法？", sources: [source], provider: "test", model: "synthetic", ...fields,
  });
  const complete = (message: IdeaMessage) => updateIdeaMessage(store, { ...message, body: "软件测试回复：这不是科研结果。", status: "completed" });
  const summary = () => {
    const turn = begin();
    const reply = complete(turn.assistantMessage);
    return saveIdeaSummary(store, { id: randomUUID(), requestId: randomUUID(), noteId: note.id, conversationId: turn.conversation.id,
      title: "软件测试阶段笔记", sections: [{ id: "question", title: "当前问题", body: "明确输入和预期行为。", sourceIds: [source.id] },
        { id: "next", title: "下一步", body: "使用合成输入验证保存流程。", sourceIds: [] }], messageIds: [reply.id], messages: [reply],
      sources: [source], baseRevision: note.revision, provider: "test", model: "synthetic", createdAt: new Date().toISOString(), applications: [] });
  };
  return { root, store, note, other, topic, source, begin, complete, summary,
    cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("idea turns are durable pairs, idempotent, scoped to one owner and one active generation", () => {
  const f = fixture();
  try {
    const requestId = randomUUID();
    const first = f.begin({ requestId, expectedNoteRevision: f.note.revision });
    assert.equal(first.reused, false);
    const same = f.begin({ requestId });
    assert.equal(same.reused, true);
    assert.equal(same.assistantMessage.id, first.assistantMessage.id);
    assert.equal(ideaConversationSnapshot(f.store, f.note.id)[0].messages.length, 2);
    assert.throws(() => f.begin({ requestId, message: "同一个请求 ID 的另一条消息" }), /请求 ID/);
    assert.throws(() => f.begin(), /已有回复/);
    assert.throws(() => f.begin({ noteId: f.other.id, conversationId: first.conversation.id }), /不属于当前想法/);
    const reply = f.complete(first.assistantMessage);
    assert.deepEqual(reply.sources, ideaSourceSnapshotSchema.array().parse([f.source]));
    assert.throws(() => updateIdeaMessage(f.store, { ...reply, body: "不能改写已完成历史" }), /状态已改变/);
    const second = f.begin({ conversationId: first.conversation.id, expectedLastMessageId: reply.id });
    f.complete(second.assistantMessage);
    assert.equal(requireIdeaConversation(f.store, f.note.id, first.conversation.id).messages.length, 4);
    assert.throws(() => f.begin({ conversationId: first.conversation.id, expectedLastMessageId: reply.id }), /其他窗口更新/);
  } finally { f.cleanup(); }
});

test("stale note input and expired leases never silently restart an unfinished generation", () => {
  const f = fixture();
  try {
    assert.throws(() => f.begin({ expectedNoteRevision: 99 }), /工作笔记已更新/);
    const turn = f.begin();
    f.store.db.prepare("UPDATE idea_lab_messages SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(turn.assistantMessage.id);
    expireIdeaLeases(f.store);
    const restored = requireIdeaConversation(f.store, f.note.id, turn.conversation.id).messages.at(-1)!;
    assert.equal(restored.status, "failed");
    assert.match(restored.error, /中断/);
    assert.equal(f.begin({ requestId: turn.userMessage.requestId }).reused, true);
    assert.doesNotThrow(() => f.begin({ conversationId: turn.conversation.id }));
  } finally { f.cleanup(); }
});

test("summary provenance is immutable and cannot add foreign messages or invented source snapshots", () => {
  const f = fixture();
  try {
    const summary = f.summary();
    assert.equal(f.store.snapshot().notes.find((note) => note.id === f.note.id)!.body, f.note.body);
    assert.deepEqual(saveIdeaSummary(f.store, { ...summary, id: randomUUID() }), summary);
    assert.throws(() => saveIdeaSummary(f.store, { ...summary, requestId: randomUUID(), id: randomUUID(),
      sources: [{ ...f.source, text: "伪造来源的文字", end: "伪造来源的文字".length }] }), /不存在的资料快照/);
    const forged = { ...summary, id: randomUUID(), requestId: randomUUID(), messages: [{ ...summary.messages[0], body: "篡改的历史" }] };
    assert.throws(() => saveIdeaSummary(f.store, forged), /不属于此讨论/);
    assert.throws(() => saveIdeaSummary(f.store, { ...summary, requestId: randomUUID(), id: randomUUID(), noteId: f.other.id }), /不属于当前想法/);
  } finally { f.cleanup(); }
});

test("selected summary sections append to the latest note, preserve original snapshot and are retry-idempotent", () => {
  const f = fixture();
  try {
    const summary = f.summary();
    const latest = f.store.dispatch("note.update", { id: f.note.id, revision: f.note.revision, body: f.note.body + "\n\n生成后又写下的新内容。" }) as Note;
    const request = { noteId: f.note.id, summaryId: summary.id, requestId: randomUUID(), destination: { kind: "current" },
      revision: latest.revision, sectionIds: ["question"] };
    const result = f.store.dispatch("idea.summary.apply", request) as Note;
    assert.ok(result.body.startsWith(latest.body));
    assert.match(result.body, /明确输入和预期行为/);
    assert.doesNotMatch(result.body, /使用合成输入验证保存流程/);
    assert.match(result.body, new RegExp(`kb://note/${f.other.id}`));
    assert.ok(f.store.snapshot().noteRevisions!.some((record) => record.noteId === f.note.id && record.body === latest.body));
    assert.deepEqual(f.store.dispatch("idea.summary.apply", request), result);
    assert.throws(() => f.store.dispatch("idea.summary.apply", { ...request, sectionIds: ["next"] }), /请求 ID/);
    assert.throws(() => f.store.dispatch("idea.summary.apply", { ...request, requestId: randomUUID(), revision: result.revision }), /已写入目标/);
    const current = f.store.snapshot().notes.find((note) => note.id === f.note.id)!;
    assert.equal(current.revision, result.revision);
    const mirror = readFileSync(path.join(f.store.dataDir, "notes", `${result.id}.md`), "utf8");
    assert.match(mirror, /生成后又写下的新内容/);
  } finally { f.cleanup(); }
});

test("summary adoption supports a new note or question note with revision protection and no partial writes", () => {
  const f = fixture();
  try {
    const summary = f.summary();
    const newRequest = { noteId: f.note.id, summaryId: summary.id, requestId: randomUUID(),
      destination: { kind: "new", title: "已采纳的软件笔记" }, sectionIds: ["question", "next"] };
    const created = f.store.dispatch("idea.summary.apply", newRequest) as Note;
    assert.equal(created.title, "已采纳的软件笔记");
    assert.notEqual(created.id, f.note.id);
    assert.deepEqual(f.store.dispatch("idea.summary.apply", newRequest), created);
    const target = f.store.snapshot().notes.find((note) => note.id === f.topic.noteId)!;
    const topicRequest = { noteId: f.note.id, summaryId: summary.id, requestId: randomUUID(), destination: { kind: "topic", topicId: f.topic.id }, revision: target.revision, sectionIds: ["next"] };
    const stale = f.store.dispatch("note.update", { id: target.id, revision: target.revision, body: "用户的新正文" }) as Note;
    const before = f.store.snapshot();
    assert.throws(() => f.store.dispatch("idea.summary.apply", topicRequest), /目标笔记已更新/);
    assert.deepEqual(f.store.snapshot(), before);
    const updated = f.store.dispatch("idea.summary.apply", { ...topicRequest, revision: stale.revision }) as Note;
    assert.ok(updated.body.startsWith("用户的新正文"));
    assert.equal(updated.id, f.topic.noteId);
    assert.match(updated.body, /使用合成输入验证保存流程/);
  } finally { f.cleanup(); }
});

test("unclosed protected markup blocks append without changing body or application history", () => {
  const f = fixture();
  try {
    const summary = f.summary();
    const note = f.store.dispatch("note.update", { id: f.note.id, revision: f.note.revision, body: "```python\nnot_closed" }) as Note;
    const before = f.store.snapshot();
    assert.throws(() => f.store.dispatch("idea.summary.apply", { noteId: f.note.id, summaryId: summary.id,
      requestId: randomUUID(), destination: { kind: "current" }, revision: note.revision, sectionIds: ["question"] }), StoreError);
    assert.deepEqual(f.store.snapshot(), before);
  } finally { f.cleanup(); }
});

test("full backup restores discussion snapshots, summaries and adoption provenance into a fresh library", () => {
  const f = fixture();
  let restored: KBStore | undefined;
  try {
    const summary = f.summary();
    f.store.dispatch("idea.summary.apply", { noteId: f.note.id, summaryId: summary.id, requestId: randomUUID(),
      destination: { kind: "current" }, revision: f.note.revision, sectionIds: ["question"] });
    const before = f.store.snapshot();
    const result = restoreBackup(createBackup(f.store), f.root);
    restored = new KBStore(result.restoredDirectory);
    assert.deepEqual(restored.snapshot().ideaConversations, before.ideaConversations);
    assert.deepEqual(restored.snapshot().ideaSummaries, before.ideaSummaries);
    assert.deepEqual(restored.snapshot().notes, before.notes);
    assert.equal(ideaSummarySnapshot(restored, f.note.id)[0].applications.length, 1);
    const invalid = structuredClone(before);
    invalid.ideaConversations![0].noteId = f.topic.noteId;
    const target = new KBStore(path.join(f.root, "forged"));
    try {
      assert.throws(() => target.importSnapshot(invalid), /独立想法/);
      assert.equal(target.snapshot().notes.length, 0);
    } finally { target.close(); }
    const duplicate = structuredClone(before.ideaSummaries![0]);
    duplicate.applications.push(duplicate.applications[0]);
    assert.equal(ideaSummarySchema.safeParse(duplicate).success, false);
  } finally { restored?.close(); f.cleanup(); }
});

test("full Markdown export separates unaccepted discussion and summaries from the personal note export", () => {
  const f = fixture();
  try {
    const summary = f.summary();
    const before = f.store.snapshot();
    const complete = exportMarkdown(before);
    assert.match(complete, /# 想法讨论：/);
    assert.match(complete, /# 想法整理草稿：/);
    assert.ok(complete.includes(summary.sections[0].body));
    assert.ok(complete.includes(summary.sources[0].text));
    assert.match(complete, /尚未采纳，未自动写入个人正文/);
    const personal = exportMarkdown(before, f.note.id);
    assert.ok(personal.includes(f.note.body));
    assert.ok(!personal.includes(summary.sections[0].body));
    assert.doesNotMatch(personal, /# 想法讨论：|# 想法整理草稿：/);
    assert.deepEqual(f.store.snapshot(), before);
  } finally { f.cleanup(); }
});
