import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { KBStore } from "../src/lib/db";
import { createBackup, restoreBackup } from "../src/lib/archive";
import type { Note, Paper, Topic } from "../src/lib/types";
import { initResearchItemSchema, importResearchItems, mutateResearchItem, researchItemReferences, researchItemsSnapshot } from "../src/lib/research-items/store";
import { researchSourceFingerprint, resolveResearchSource, validateResearchSource } from "../src/lib/research-items/sources";
import { saveCodexDiscussion, refreshCodexDiscussion } from "../src/lib/codex-import/store";
import type { CodexHistory } from "../src/lib/codex-import/types";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-research-items-")), directory = path.join(root, "source"), store = new KBStore(directory);
  initResearchItemSchema(store);
  const topic = store.dispatch("topic.create", { title: "TEST · 轻量核验问题" }) as Topic;
  const note = store.dispatch("note.create", { title: "TEST · 来源原稿", purpose: "idea", body: "原文前缀：这是软件验收选段，不是科研结论。保留我的原稿。", topicIds: [topic.id] }) as Note;
  const request = { action: "create" as const, id: randomUUID(), topicId: topic.id, title: "这个合成假设是否成立？", body: "软件验收问题，尚未验证。", nextAction: "核对合成输入", sourceRefs: [{ kind: "noteSelection" as const, id: note.id, revision: note.revision, from: 5, to: 20 }] };
  return { root, directory, store, topic, note, request, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("create is explicit, pending and durable; retries reuse the same item and snapshots survive note edits", () => {
  const f = fixture();
  try {
    const before = f.store.snapshot().notes, item = mutateResearchItem(f.store, f.request);
    assert.equal(item.status, "pending"); assert.deepEqual(item.resultRefs, []); assert.equal(item.resolution, "");
    assert.equal(item.sourceRefs[0].text, f.note.body.slice(5, 20)); assert.equal(item.sourceRefs[0].sourceHref, `kb://note/${f.note.id}`);
    assert.deepEqual(mutateResearchItem(f.store, f.request), item); assert.equal(researchItemsSnapshot(f.store).length, 1);
    assert.throws(() => mutateResearchItem(f.store, { ...f.request, title: "同 ID 不能改成其他创建请求" }), /请求 ID/);
    assert.deepEqual(f.store.snapshot().notes, before, "creating an item must not rewrite personal notes");
    f.store.dispatch("note.update", { id: f.note.id, revision: f.note.revision, body: "后来的原稿，旧选段应在待核验快照中保留。" });
    const updated = mutateResearchItem(f.store, { action: "update", id: item.id, revision: item.revision, sourceRefs: item.sourceRefs.map(source => source.input), nextAction: "继续核对旧引用快照" });
    assert.deepEqual(updated.sourceRefs, item.sourceRefs);
    const second = new KBStore(f.directory);
    try { assert.deepEqual(researchItemsSnapshot(second), [updated]); } finally { second.close(); }
  } finally { f.close(); }
});

test("two SQLite connections reject stale revisions and archive/restore keeps data and reference protection", () => {
  const f = fixture(), other = new KBStore(f.directory);
  try {
    const item = mutateResearchItem(f.store, f.request);
    const live = mutateResearchItem(f.store, { action: "update", id: item.id, revision: item.revision, status: "in_progress" });
    assert.throws(() => mutateResearchItem(other, { action: "update", id: item.id, revision: item.revision, title: "过期写入" }), /已在其他位置更新/);
    assert.equal(researchItemsSnapshot(other)[0].title, item.title);
    const archived = mutateResearchItem(f.store, { action: "archive", id: live.id, revision: live.revision });
    assert.ok(archived.archivedAt); assert.deepEqual(researchItemReferences(f.store, "note", f.note.id), [item.id]);
    assert.deepEqual(researchItemReferences(f.store, "topic", f.topic.id), [item.id]);
    assert.throws(() => mutateResearchItem(f.store, { action: "update", id: archived.id, revision: archived.revision, body: "未恢复不能编辑" }), /先恢复/);
    const restored = mutateResearchItem(f.store, { action: "restore", id: archived.id, revision: archived.revision });
    assert.equal(restored.archivedAt, null); assert.equal(restored.status, "in_progress"); assert.deepEqual(restored.sourceRefs, item.sourceRefs);
    const destination = f.store.dispatch("topic.create", { title: "TEST · 新归属" }) as Topic;
    const moved = mutateResearchItem(f.store, { action: "update", id: restored.id, revision: restored.revision, topicId: destination.id });
    assert.equal(moved.topicId, destination.id); assert.deepEqual(researchItemReferences(f.store, "topic", f.topic.id), []);
    assert.throws(() => mutateResearchItem(f.store, { action: "update", id: moved.id, revision: moved.revision, topicId: randomUUID() }), /研究问题不存在/);
  } finally { other.close(); f.close(); }
});

test("resolved requires a user's judgment and explicit result refs; no suggestion or imported item becomes resolved automatically", () => {
  const f = fixture();
  try {
    const item = mutateResearchItem(f.store, f.request);
    for (const patch of [{ status: "resolved" }, { status: "resolved", resolution: "声称完成但未选择结果" }, { status: "resolved", resultRefs: [{ kind: "note", id: f.note.id, revision: f.note.revision }], resolution: " " }]) {
      assert.throws(() => mutateResearchItem(f.store, { action: "update", id: item.id, revision: item.revision, ...patch }), /解决时请选择/);
      assert.equal(researchItemsSnapshot(f.store)[0].status, "pending");
    }
    const resolved = mutateResearchItem(f.store, { action: "update", id: item.id, revision: item.revision, status: "resolved", resolution: "用户确认：仅完成本次软件保存验收，并非科研证明。", resultRefs: [{ kind: "note", id: f.note.id, revision: f.note.revision }] });
    assert.equal(resolved.status, "resolved"); assert.equal(resolved.resultRefs[0].input.kind, "note");
    assert.deepEqual(f.store.snapshot().notes.find(note => note.id === f.note.id), f.note);
  } finally { f.close(); }
});

test("guide questions and selected evidence retain actual attachment/page IDs and do not masquerade as verified results", () => {
  const f = fixture();
  try {
    const paper = f.store.dispatch("paper.create", { title: "TEST · 合成来源论文" }) as Paper;
    const attachment = f.store.addAttachment(paper.id, "software-fixture.pdf", Buffer.from("%PDF-1.7\nSOFTWARE FIXTURE ONLY\n%%EOF"));
    const ai = f.store.saveAI({ paperId: paper.id, kind: "guide", body: "Software QA guide only", provider: "fixture", model: "no-inference", sourceScope: "full_text", sourceAttachmentId: attachment.id, sourcePageIndices: [0], sourceText: "Synthetic original", status: "completed",
      guideData: { version: 1, mode: "guide", overview: "合成报告", sections: [], evidence: [{ id: "fixture-evidence", paperId: paper.id, attachmentId: attachment.id, attachmentSha256: attachment.sha256, pageIndex: 0, pageLabel: "1038", blockId: "fixture-block", quote: "Synthetic quoted source", title: "软件验收证据", explanation: "This is not a real research result", category: "method", matched: true }], readingOrder: ["fixture-evidence"], questions: ["待核验的软件问题？"], warnings: [], paperIds: [paper.id], sources: [{ paperId: paper.id, paperTitle: paper.title, attachmentId: attachment.id, attachmentSha256: attachment.sha256, filename: attachment.filename, pageCount: 1, parsedPages: [0], emptyPages: [], characterCount: 25 }] } });
    const input = { ...f.request, sourceRefs: [{ kind: "guideQuestion", id: ai.id, questionIndex: 0 }, { kind: "guideEvidence", id: ai.id, evidenceId: "fixture-evidence" }] };
    const item = mutateResearchItem(f.store, input);
    assert.equal(item.status, "pending"); assert.equal(item.sourceRefs[0].origin, "ai"); assert.equal(item.sourceRefs[1].attachmentId, attachment.id); assert.equal(item.sourceRefs[1].pageIndex, 0); assert.equal(item.sourceRefs[1].pageLabel, "1038");
    assert.throws(() => mutateResearchItem(f.store, { action: "update", id: item.id, revision: item.revision, status: "resolved", resolution: "仅复述AI问题", resultRefs: [input.sourceRefs[0]] }), /不能作为已解决/);
    assert.throws(() => resolveResearchSource(f.store, { kind: "guideEvidence", id: ai.id, evidenceId: "foreign-evidence" }), /证据不存在/);
  } finally { f.close(); }
});

test("imported Codex references select saved messages and retain their historical revision after refresh", () => {
  const f = fixture();
  try {
    const at = "2026-10-31T00:00:00.000Z";
    const history: CodexHistory = { complete: true, protocol: "legacy", source: { id: "test-source", label: "Synthetic Codex", host: "test", home: "/synthetic/not-read", sqliteHome: null, binary: "/not-executed" },
      thread: { id: "synthetic-thread", title: "TEST · 导入讨论", cwd: "/synthetic", createdAt: at, updatedAt: at }, turns: [{ id: "turn-1", status: "completed", startedAt: at, messages: [{ id: "user-item", turnId: "turn-1", role: "user", text: "合成问题" }, { id: "assistant-item", turnId: "turn-1", role: "assistant", text: "合成模型建议，未核验" }] }] };
    const discussion = saveCodexDiscussion(f.store, history, ["turn-1"], { paperIds: [], topicIds: [f.topic.id], noteIds: [] }).discussion;
    const item = mutateResearchItem(f.store, { ...f.request, sourceRefs: [{ kind: "externalDiscussion", id: discussion.id, revision: discussion.revision, messageIds: ["assistant-item"] }] });
    assert.equal(item.status, "pending"); assert.equal(item.sourceRefs[0].text, "AI：合成模型建议，未核验"); assert.ok(!item.sourceRefs[0].text.includes("合成问题"));
    const revised = structuredClone(history); revised.turns[0].messages[1].text = "新的合成建议，仍未核验";
    refreshCodexDiscussion(f.store, discussion.id, discussion.revision, revised);
    assert.deepEqual(validateResearchSource(f.store, item.sourceRefs[0]), item.sourceRefs[0]);
    assert.deepEqual(researchItemReferences(f.store, "externalDiscussion", discussion.id), [item.id]);
    const archive = mutateResearchItem(f.store, { action: "archive", id: item.id, revision: item.revision });
    const restored = new KBStore(restoreBackup(createBackup(f.store), f.root).restoredDirectory);
    try { assert.deepEqual(restored.snapshot().researchItems, [archive]); } finally { restored.close(); }
  } finally { f.close(); }
});

test("complete backups preserve archived items and historical note snapshots, while malformed imports roll back atomically", () => {
  const f = fixture();
  try {
    const item = mutateResearchItem(f.store, f.request);
    f.store.dispatch("note.update", { id: f.note.id, revision: f.note.revision, body: "修改后的个人原稿" });
    const archived = mutateResearchItem(f.store, { action: "archive", id: item.id, revision: item.revision });
    const restored = new KBStore(restoreBackup(createBackup(f.store), f.root).restoredDirectory);
    try { assert.deepEqual(restored.snapshot(), f.store.snapshot()); } finally { restored.close(); }
    const broken = structuredClone(archived); broken.id = randomUUID(); broken.sourceRefs[0].text += "伪造正文";
    assert.throws(() => importResearchItems(f.store, { researchItems: [broken] }), /指纹不一致/);
    assert.equal(researchItemsSnapshot(f.store).length, 1);
    const fresh = { ...archived, id: randomUUID() };
    assert.throws(() => importResearchItems(f.store, { researchItems: [fresh, archived] }), /UNIQUE/);
    assert.deepEqual(researchItemsSnapshot(f.store), [archived], "a later conflict rolls back earlier inserts in the same import");
  } finally { f.close(); }
});

test("missing owners, stale revisions, invalid ranges and spoofed current source text never create dangling entries", () => {
  const f = fixture();
  try {
    assert.throws(() => mutateResearchItem(f.store, { ...f.request, topicId: randomUUID() }), /研究问题不存在/);
    assert.throws(() => mutateResearchItem(f.store, { ...f.request, sourceRefs: [{ kind: "noteSelection", id: f.note.id, revision: 999, from: 0, to: 2 }] }), /已更新/);
    assert.throws(() => mutateResearchItem(f.store, { ...f.request, sourceRefs: [{ kind: "noteSelection", id: f.note.id, revision: 1, from: 0, to: 9000 }] }), /超出原文/);
    const source = resolveResearchSource(f.store, { kind: "note", id: f.note.id, revision: 1 });
    const forged = { ...source, text: "伪造来源" }; forged.fingerprint = researchSourceFingerprint(forged);
    assert.throws(() => validateResearchSource(f.store, forged), /与所选原文不一致/);
    assert.deepEqual(researchItemsSnapshot(f.store), []);
  } finally { f.close(); }
});
