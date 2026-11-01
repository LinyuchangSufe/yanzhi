import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { KBStore, getStore } from "../src/lib/db";
import { createBackup, restoreBackup } from "../src/lib/archive";
import { runPaperChat } from "../src/lib/paper-chat/engine";
import { paperChatInputSchema } from "../src/lib/paper-chat/schemas";
import { beginChatTurn, paperChatSnapshot, renamePaperChat, resolveChatReplay, updateChatMessage } from "../src/lib/paper-chat/store";
import type { ChatScope, ChatStreamEvent, PaperChatMessage } from "../src/lib/paper-chat/types";
import type { Paper } from "../src/lib/types";

async function withLibrary(run: (store: KBStore, paper: Paper, attachmentId: string, root: string) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-chat-replay-fixture-"));
  const previous = {...process.env};
  const originalFetch = globalThis.fetch;
  process.env.KB_DATA_DIR = path.join(root, "data");
  process.env.KB_AI_PROVIDER = "ollama";
  process.env.KB_OLLAMA_MODEL = "fixture-current-default";
  process.env.KB_OLLAMA_URL = "http://127.0.0.1:11434";
  const store = getStore();
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText("EXPLICIT SYNTHETIC REPLAY TEST SOURCE. No research result.", {
      font: await pdf.embedFont(StandardFonts.Helvetica), size: 10,
    });
    const paper = store.dispatch("paper.create", {title: "EXPLICIT CHAT REPLAY TEST"}) as Paper;
    const attachment = store.addAttachment(paper.id, "fixture.pdf", Buffer.from(await pdf.save()));
    await run(store, paper, attachment.id, root);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(root, {recursive: true, force: true});
  }
}
function scopeFor(store: KBStore, attachmentId: string): ChatScope {
  const attachment = store.snapshot().attachments.find((item) => item.id === attachmentId)!;
  return {attachmentId, attachmentSha256: attachment.sha256, pageIndices: [0], totalPages: 1,
    characterCount: 50, truncated: false, historyMessages: 0, historyTruncated: false};
}
function seedTurn(store: KBStore, paperId: string, attachmentId: string, message: string, conversationId?: string,
  status: "completed" | "cancelled" | "failed" = "completed") {
  const turn = beginChatTurn(store, {paperId, attachmentId, conversationId, message,
    provider: "ollama", model: "fixture-original-model", scope: scopeFor(store, attachmentId)});
  updateChatMessage(store, {...turn.assistantMessage, body: `OLD ANSWER TO ${message}`, status,
    error: status === "completed" ? "" : "Explicit fixture interruption"});
  return turn;
}
const conversation = (store: KBStore, id: string) => paperChatSnapshot(store).find((item) => item.id === id)!;
function withoutIdentity(message: PaperChatMessage) {
  const {id: _id, conversationId: _conversationId, ...content} = message;
  return content;
}
function startEvent(events: ChatStreamEvent[]) {
  const start = events.find((event) => event.type === "start");
  assert.ok(start?.type === "start");
  return start;
}

test("editing and retrying an old question branch only its earlier history; originals and backups remain exact", async () => {
  await withLibrary(async (store, paper, attachmentId, root) => {
    const first = seedTurn(store, paper.id, attachmentId, "FIRST QUESTION");
    const middle = seedTurn(store, paper.id, attachmentId, "MIDDLE QUESTION", first.conversation.id);
    seedTurn(store, paper.id, attachmentId, "LATER QUESTION", first.conversation.id);
    renamePaperChat(store, {paperId: paper.id, conversationId: first.conversation.id, title: "KEEP ORIGINAL CUSTOM TITLE"});
    const original = conversation(store, first.conversation.id);
    const settings = store.snapshot().settings;
    const calls: {model: string; messages: {role: string; content: string}[]}[] = [];
    globalThis.fetch = async (_url, options) => {
      calls.push(JSON.parse(String(options?.body)) as typeof calls[number]);
      return new Response('{"model":"fixture-actual-model","message":{"content":"NEW FIXTURE ANSWER"},"done":true}\n');
    };
    const base = {paperId: paper.id, attachmentId, replay: {
      sourceConversationId: original.id, sourceMessageId: middle.userMessage.id, kind: "edit" as const,
    }};
    const editEvents: ChatStreamEvent[] = [];
    await runPaperChat({...base, message: "EDITED MIDDLE QUESTION", model: "fixture-new-selection"}, (event) => editEvents.push(event));
    const edit = startEvent(editEvents);
    assert.notEqual(edit.conversationId, original.id);
    assert.equal(edit.conversation.title, "EDITED MIDDLE QUESTION · 已编辑");
    assert.deepEqual(edit.conversation.messages.map(withoutIdentity), original.messages.slice(0, 2).map(withoutIdentity));
    assert.ok(edit.conversation.messages.every((message) => message.conversationId === edit.conversationId &&
      original.messages.every((old) => old.id !== message.id)));
    assert.deepEqual(calls[0].messages.slice(1), [
      {role: "user", content: "FIRST QUESTION"}, {role: "assistant", content: "OLD ANSWER TO FIRST QUESTION"},
      {role: "user", content: "EDITED MIDDLE QUESTION"},
    ]);
    assert.equal(calls[0].model, "fixture-new-selection");
    assert.equal(edit.scope.historyMessages, 2);
    assert.equal(conversation(store, edit.conversationId).messages.at(-1)?.model, "fixture-actual-model");
    assert.deepEqual(conversation(store, original.id), original);
    const retryEvents: ChatStreamEvent[] = [];
    await runPaperChat({...base, message: "  MIDDLE QUESTION  ", replay: {...base.replay, kind: "retry"}}, (event) => retryEvents.push(event));
    const retry = startEvent(retryEvents);
    assert.notEqual(retry.conversationId, edit.conversationId);
    assert.equal(retry.conversation.title, "MIDDLE QUESTION · 重试");
    assert.equal(retry.userMessage.body, "MIDDLE QUESTION");
    assert.equal(calls[1].model, "fixture-original-model");
    assert.deepEqual(calls[1].messages.slice(1), [
      {role: "user", content: "FIRST QUESTION"}, {role: "assistant", content: "OLD ANSWER TO FIRST QUESTION"},
      {role: "user", content: "MIDDLE QUESTION"},
    ]);
    assert.deepEqual(conversation(store, original.id), original);
    assert.deepEqual(store.snapshot().settings, settings);
    const allMessages = paperChatSnapshot(store).flatMap((item) => item.messages);
    assert.equal(new Set(allMessages.map((message) => message.id)).size, allMessages.length);
    const restored = restoreBackup(createBackup(store), root);
    const backupStore = new KBStore(restored.restoredDirectory);
    try { assert.deepEqual(paperChatSnapshot(backupStore), paperChatSnapshot(store)); }
    finally { backupStore.close(); }
  });
});

test("a replay preserves incomplete prefix messages without sending partial answers; cancellation keeps its new branch", async () => {
  await withLibrary(async (store, paper, attachmentId) => {
    const first = seedTurn(store, paper.id, attachmentId, "FAILED FIRST QUESTION", undefined, "failed");
    const second = seedTurn(store, paper.id, attachmentId, "CANCELLED SECOND QUESTION", first.conversation.id, "cancelled");
    const third = seedTurn(store, paper.id, attachmentId, "SOURCE THIRD QUESTION", second.conversation.id);
    const original = conversation(store, first.conversation.id);
    const abort = new AbortController();
    let actualHistory: {role: string; content: string}[] = [];
    globalThis.fetch = async (_url, options) => {
      actualHistory = (JSON.parse(String(options?.body)) as {messages: typeof actualHistory}).messages.slice(1);
      return new Response(new ReadableStream<Uint8Array>({start(controller) {
        controller.enqueue(new TextEncoder().encode('{"message":{"content":"NEW PARTIAL FIXTURE"}}\n'));
        options?.signal?.addEventListener("abort", () => controller.error(new DOMException("Stopped", "AbortError")), {once: true});
      }}));
    };
    const events: ChatStreamEvent[] = [];
    await runPaperChat({paperId: paper.id, attachmentId, message: third.userMessage.body,
      replay: {sourceConversationId: original.id, sourceMessageId: third.userMessage.id, kind: "retry"}}, (event) => {
      events.push(event); if (event.type === "delta") abort.abort();
    }, abort.signal);
    const start = startEvent(events);
    assert.deepEqual(start.conversation.messages.map(withoutIdentity), original.messages.slice(0, 4).map(withoutIdentity));
    assert.deepEqual(actualHistory, ["FAILED FIRST QUESTION", "CANCELLED SECOND QUESTION", "SOURCE THIRD QUESTION"]
      .map((content) => ({role: "user", content})));
    const saved = conversation(store, start.conversationId);
    assert.equal(saved.messages.length, 6);
    assert.equal(saved.messages.at(-1)?.body, "NEW PARTIAL FIXTURE");
    assert.equal(saved.messages.at(-1)?.status, "cancelled");
    assert.deepEqual(conversation(store, original.id), original);
  });
});

test("replay rejects invalid sources, changed text, ownership/version mismatches and pending source replies without mutation", async () => {
  await withLibrary(async (store, paper, attachmentId) => {
    const source = seedTurn(store, paper.id, attachmentId, "SOURCE QUESTION");
    const original = conversation(store, source.conversation.id);
    const base = {paperId: paper.id, attachmentId, message: "SOURCE QUESTION", replay: {
      sourceConversationId: original.id, sourceMessageId: source.userMessage.id, kind: "retry" as const,
    }};
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("Invalid replay must not call provider"); };
    await assert.rejects(runPaperChat({...base, message: "DIFFERENT QUESTION"}, () => {}), /原提问不一致/);
    await assert.rejects(runPaperChat({...base, replay: {...base.replay, sourceMessageId: source.assistantMessage.id}}, () => {}), /原提问不存在/);
    await assert.rejects(runPaperChat({...base, replay: {...base.replay, sourceMessageId: randomUUID()}}, () => {}), /原提问不存在/);
    await assert.rejects(runPaperChat({...base, replay: {...base.replay, sourceConversationId: randomUUID()}}, () => {}), /附件版本/);
    const other = seedTurn(store, paper.id, attachmentId, "OTHER QUESTION");
    await assert.rejects(runPaperChat({...base, replay: {...base.replay, sourceMessageId: other.userMessage.id}}, () => {}), /原提问不存在/);
    const otherPaper = store.dispatch("paper.create", {title: "OTHER FIXTURE PAPER"}) as Paper;
    await assert.rejects(runPaperChat({...base, paperId: otherPaper.id}, () => {}), /附件与文献不匹配/);
    const otherPdf = await PDFDocument.create(); otherPdf.addPage();
    const otherAttachment = store.addAttachment(paper.id, "other-fixture.pdf", Buffer.from(await otherPdf.save()));
    await assert.rejects(runPaperChat({...base, attachmentId: otherAttachment.id}, () => {}), /附件版本/);
    store.db.prepare("UPDATE attachments SET sha256=? WHERE id=?").run("f".repeat(64), attachmentId);
    await assert.rejects(runPaperChat(base, () => {}), /附件版本/);
    store.db.prepare("UPDATE attachments SET sha256=? WHERE id=?").run(original.attachmentSha256, attachmentId);
    assert.deepEqual(conversation(store, original.id), original);
    const pending = beginChatTurn(store, {paperId: paper.id, attachmentId, conversationId: original.id,
      message: "PENDING LATER QUESTION", provider: "fixture", model: "fixture", scope: scopeFor(store, attachmentId)});
    store.db.prepare("UPDATE paper_chat_messages SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(pending.assistantMessage.id);
    const beforePending = conversation(store, original.id);
    await assert.rejects(runPaperChat(base, () => {}), /正在生成/);
    assert.deepEqual(conversation(store, original.id), beforePending, "replaying must not expire a lease in the source conversation");
    assert.equal(calls, 0);
    assert.equal(paperChatSnapshot(store).length, 2);
  });
});

test("replay validates again after PDF extraction and atomically rejects stale source snapshots", async () => {
  await withLibrary(async (store, paper, attachmentId) => {
    const source = seedTurn(store, paper.id, attachmentId, "SOURCE QUESTION");
    const input = {paperId: paper.id, attachmentId, message: "SOURCE QUESTION", replay: {
      sourceConversationId: source.conversation.id, sourceMessageId: source.userMessage.id, kind: "retry" as const,
    }};
    const replay = resolveChatReplay(store, input);
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("Stale replay must not call provider"); };
    const request = runPaperChat(input, () => {});
    renamePaperChat(store, {paperId: paper.id, conversationId: source.conversation.id, title: "RENAMED WHILE PDF LOADS"});
    const changed = conversation(store, source.conversation.id);
    await assert.rejects(request, /其他窗口更新/);
    assert.throws(() => beginChatTurn(store, {...input, expectedReplayFingerprint: replay.fingerprint,
      provider: "fixture", model: "fixture", scope: scopeFor(store, attachmentId)}), /其他窗口更新/);
    assert.deepEqual(paperChatSnapshot(store), [changed]);
    assert.equal(calls, 0);
  });
});

test("replay request schema is strict, bounded and mutually exclusive with ordinary continuation", () => {
  const base = {paperId: randomUUID(), attachmentId: randomUUID(), message: "Fixture question", replay: {
    sourceConversationId: randomUUID(), sourceMessageId: randomUUID(), kind: "edit",
  }};
  assert.equal(paperChatInputSchema.parse(base).replay?.kind, "edit");
  for (const input of [{...base, conversationId: randomUUID()}, {...base, message: " "}, {...base, message: "x".repeat(12001)},
    {...base, replay: {...base.replay, kind: "delete"}}, {...base, replay: {...base.replay, sourceMessageId: "bad-id"}},
    {...base, replay: {...base.replay, prefix: []}}, {...base, replay: null}]) {
    assert.equal(paperChatInputSchema.safeParse(input).success, false);
  }
});
