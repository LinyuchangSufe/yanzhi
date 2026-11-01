import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { KBStore, getStore } from "../src/lib/db";
import { createBackup, restoreBackup } from "../src/lib/archive";
import { runPaperChat } from "../src/lib/paper-chat/engine";
import { chatHistory } from "../src/lib/paper-chat/context";
import { buildChatUserContent, resolveChatContexts } from "../src/lib/paper-chat/references";
import { chatContextSchema, paperChatInputSchema, paperChatMessageSchema } from "../src/lib/paper-chat/schemas";
import { beginChatTurn, paperChatSnapshot, updateChatMessage } from "../src/lib/paper-chat/store";
import type { ChatContextInput, ChatScope, ChatStreamEvent } from "../src/lib/paper-chat/types";
import type { Note, Paper, Topic } from "../src/lib/types";

/** A deterministic, valid one-page text PDF; fixtures carry no research claims. */
function syntheticPDF() {
  const text = "BT /F1 10 Tf 50 740 Td (EXPLICIT SYNTHETIC PDF FIXTURE. No research result.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(source);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  source += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}

async function withLibrary(run: (store: KBStore, paper: Paper, attachmentId: string, root: string) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-chat-context-fixture-"));
  const previous = {...process.env};
  const originalFetch = globalThis.fetch;
  process.env.KB_DATA_DIR = path.join(root, "data");
  process.env.KB_AI_PROVIDER = "ollama";
  process.env.KB_OLLAMA_MODEL = "explicit-context-fixture";
  process.env.KB_OLLAMA_URL = "http://127.0.0.1:11434";
  const store = getStore();
  try {
    const paper = store.dispatch("paper.create", {title: "EXPLICIT CHAT CONTEXT TEST"}) as Paper;
    const attachment = store.addAttachment(paper.id, "fixture.pdf", syntheticPDF());
    await run(store, paper, attachment.id, root);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(root, {recursive: true, force: true});
  }
}
function createNote(store: KBStore, body: string, purpose: Note["purpose"] = "paper") {
  return store.dispatch("note.create", {title: `EXPLICIT ${purpose} FIXTURE`, body, purpose}) as Note;
}
function full(note: Note): ChatContextInput { return {noteId: note.id, revision: note.revision, mode: "full"}; }
function scopeFor(store: KBStore, attachmentId: string): ChatScope {
  const attachment = store.snapshot().attachments.find((item) => item.id === attachmentId)!;
  return {attachmentId, attachmentSha256: attachment.sha256, pageIndices: [0], totalPages: 1,
    characterCount: 55, truncated: false, historyMessages: 0, historyTruncated: false};
}
function startEvent(events: ChatStreamEvent[]) {
  const start = events.find((event) => event.type === "start");
  assert.ok(start?.type === "start");
  return start;
}
function captureAI() {
  const calls: {messages: {role: string; content: string}[]}[] = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(String(options?.body)) as typeof calls[number]);
    return new Response('{"model":"explicit-context-fixture","message":{"content":"EXPLICIT FIXTURE ANSWER"},"done":true}\n');
  };
  return calls;
}

test("personal context resolves exact Markdown and LaTeX text from notes, ideas, question bodies and descriptions", async () => {
  await withLibrary(async (store) => {
    const body = "# Explicit fixture\n\n**Selected** $E=mc^2$\n\nUnselected ending.";
    const note = createNote(store, body);
    const idea = createNote(store, "Explicit unverified idea.", "idea");
    const topic = store.dispatch("topic.create", {title: "EXPLICIT QUESTION", description: "Question description $x_0$."}) as Topic;
    const topicNote = store.snapshot().notes.find((item) => item.id === topic.noteId)!;
    const updated = store.dispatch("note.update", {id: topicNote.id, revision: topicNote.revision, body: "Question body **fixture**."}) as Note;
    const start = body.indexOf("**Selected**");
    const end = start + "**Selected** $E=mc^2$".length;
    const contexts = resolveChatContexts(store, [full(note), full(idea), full(updated),
      {noteId: note.id, revision: note.revision, mode: "excerpt", start, end},
      {noteId: topic.noteId, revision: topic.revision, mode: "full", field: "description"}]);
    assert.equal(contexts[0].text, body);
    assert.equal(contexts[0].sourceHref, `kb://note/${note.id}`);
    assert.equal(contexts[1].purpose, "idea");
    assert.equal(contexts[2].title, topic.title);
    assert.equal(contexts[2].topicId, topic.id);
    assert.equal(contexts[2].sourceHref, `kb://topic/${topic.id}`);
    assert.equal(contexts[3].text, "**Selected** $E=mc^2$");
    assert.equal(contexts[3].start, start);
    assert.equal(contexts[3].end, end);
    assert.equal(contexts[4].field, "description");
    assert.equal(contexts[4].text, topic.description);
    const parsed = JSON.parse(buildChatUserContent("COMPARE THE FIXTURES", contexts)) as {question: string; personalReferences: {text: string; kind: string}[]};
    assert.equal(parsed.question, "COMPARE THE FIXTURES");
    assert.equal(parsed.personalReferences[4].kind, "问题描述");
    assert.deepEqual(parsed.personalReferences.map((item) => item.text), contexts.map((item) => item.text));
    assert.equal(buildChatUserContent("PLAIN QUESTION"), "PLAIN QUESTION");
  });
});

test("context selection rejects stale revisions, invalid ranges, injected text, duplicates and exceeded budgets", async () => {
  await withLibrary(async (store) => {
    const note = createNote(store, "EXACT 😀 fixture text");
    const before = store.snapshot();
    const invalid = [
      {...full(note), revision: note.revision + 1}, {...full(note), noteId: randomUUID()},
      {...full(note), mode: "excerpt" as const, start: 0, end: 999},
      {...full(note), mode: "excerpt" as const, start: 7, end: 8},
      {...full(note), field: "description" as const},
    ];
    for (const input of invalid) assert.throws(() => resolveChatContexts(store, [input]));
    assert.throws(() => resolveChatContexts(store, [full(note), full(note)]), /重复/);
    const blank = createNote(store, " \n  ");
    assert.throws(() => resolveChatContexts(store, [full(blank)]), /不能为空/);
    const large = createNote(store, "x".repeat(16001));
    assert.throws(() => resolveChatContexts(store, [full(large)]), /16000/);
    assert.equal(resolveChatContexts(store, [{...full(large), mode: "excerpt", start: 0, end: 16000}])[0].text.length, 16000);
    const second = createNote(store, "y".repeat(9000));
    assert.throws(() => resolveChatContexts(store, [{...full(large), mode: "excerpt", start: 0, end: 16000}, full(second)]), /24000/);
    assert.throws(() => resolveChatContexts(store, Array.from({length: 9}, () => full(note))), /8/);
    assert.equal(store.snapshot().notes.find((item) => item.id === note.id)?.body, before.notes.find((item) => item.id === note.id)?.body);
    const base = {paperId: randomUUID(), attachmentId: randomUUID(), message: "EXPLICIT QUESTION", contexts: [full(note)]};
    assert.equal(paperChatInputSchema.safeParse(base).success, true);
    for (const value of [{...full(note), text: "INJECTED TEXT"}, {...full(note), sourceHref: "https://bad.invalid"},
      {...full(note), mode: "excerpt", start: 4, end: 4}, {...full(note), start: 0, end: 1},
      {...full(note), revision: 0}, {...full(note), field: "other"}])
      assert.equal(paperChatInputSchema.safeParse({...base, contexts: [value]}).success, false);
  });
});

test("only selected context enters the model, survives source changes in history and stays separate from PDF evidence", async () => {
  await withLibrary(async (store, paper, attachmentId) => {
    const note = createNote(store, "UNSELECTED PRIVATE BEFORE.\n**SELECTED FIXTURE** $z_1$\nUNSELECTED PRIVATE AFTER.");
    createNote(store, "UNREFERENCED PRIVATE RECORD");
    const start = note.body.indexOf("**SELECTED");
    const end = note.body.indexOf("\nUNSELECTED PRIVATE AFTER");
    const calls = captureAI();
    const events: ChatStreamEvent[] = [];
    await runPaperChat({paperId: paper.id, attachmentId, message: "COMPARE THIS EXPLICIT FIXTURE", contexts: [
      {noteId: note.id, revision: note.revision, mode: "excerpt", start, end},
    ]}, (event) => events.push(event));
    const first = startEvent(events);
    const saved = first.userMessage.contexts!;
    assert.equal(saved[0].text, "**SELECTED FIXTURE** $z_1$");
    assert.equal(first.userMessage.body, "COMPARE THIS EXPLICIT FIXTURE");
    assert.match(calls[0].messages[0].content, /个人.*不等于论文原文/);
    const all = JSON.stringify(calls[0].messages);
    assert.match(all, /SELECTED FIXTURE/);
    assert.doesNotMatch(all, /UNSELECTED PRIVATE|UNREFERENCED PRIVATE/);
    store.dispatch("note.update", {id: note.id, revision: note.revision, body: "CHANGED SOURCE MUST NOT REPLACE SAVED CONTEXT"});
    await runPaperChat({paperId: paper.id, attachmentId, conversationId: first.conversationId,
      message: "FOLLOW UP EXPLICIT FIXTURE"}, () => {});
    assert.equal(JSON.parse(calls[1].messages[1].content).personalReferences[0].text, saved[0].text);
    assert.doesNotMatch(JSON.stringify(calls[1].messages), /CHANGED SOURCE/);
    assert.deepEqual(paperChatSnapshot(store)[0].messages[0].contexts, saved);
  });
});

test("question description revision is checked independently and a stale selection rolls back without creating a conversation", async () => {
  await withLibrary(async (store, paper, attachmentId) => {
    const topic = store.dispatch("topic.create", {title: "EXPLICIT QUESTION", description: "EXPLICIT ORIGINAL DESCRIPTION"}) as Topic;
    const note = store.snapshot().notes.find((item) => item.id === topic.noteId)!;
    const updatedNote = store.dispatch("note.update", {id: note.id, revision: note.revision, body: "EXPLICIT NEW BODY"}) as Note;
    const input = {noteId: note.id, revision: topic.revision, mode: "full" as const, field: "description" as const};
    assert.equal(resolveChatContexts(store, [input])[0].text, topic.description);
    store.dispatch("topic.update", {id: topic.id, revision: topic.revision, description: "EXPLICIT CHANGED DESCRIPTION"});
    assert.throws(() => resolveChatContexts(store, [input]), /已更新/);
    assert.equal(resolveChatContexts(store, [full(updatedNote)])[0].text, updatedNote.body);
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("Stale context must not call AI"); };
    await assert.rejects(runPaperChat({paperId: paper.id, attachmentId, message: "EXPLICIT QUESTION", contexts: [input]}, () => {}), /已更新/);
    assert.equal(calls, 0);
    assert.deepEqual(paperChatSnapshot(store), []);
    assert.throws(() => beginChatTurn(store, {paperId: paper.id, attachmentId, message: "EXPLICIT QUESTION", contexts: [input],
      provider: "fixture", model: "fixture", scope: scopeFor(store, attachmentId)}), /已更新/);
    assert.deepEqual(paperChatSnapshot(store), []);
  });
});

test("a maximum 24000-character reference remains available to the next question within a bounded history", async () => {
  await withLibrary(async (store, paper, attachmentId) => {
    const first = createNote(store, "a".repeat(16000));
    const second = createNote(store, "b".repeat(8000));
    const calls = captureAI();
    const events: ChatStreamEvent[] = [];
    await runPaperChat({paperId: paper.id, attachmentId, message: "EXPLICIT LARGE CONTEXT QUESTION",
      contexts: [full(first), full(second)]}, (event) => events.push(event));
    const turn = startEvent(events);
    const followUp: ChatStreamEvent[] = [];
    await runPaperChat({paperId: paper.id, attachmentId, conversationId: turn.conversationId,
      message: "EXPLICIT FOLLOW UP TO LARGE CONTEXT"}, (event) => followUp.push(event));
    assert.equal(startEvent(followUp).scope.historyMessages, 2);
    assert.equal(startEvent(followUp).scope.historyTruncated, false);
    const previous = JSON.parse(calls[1].messages[1].content) as {personalReferences: {text: string}[]};
    assert.deepEqual(previous.personalReferences.map((item) => item.text.length), [16000, 8000]);
    const messages = paperChatSnapshot(store)[0].messages;
    const many = Array.from({length: 8}, () => messages.slice(0, 2)).flat();
    const history = chatHistory(many, 1000000);
    assert.ok(history.messages.reduce((sum, item) => sum + item.content.length, 0) <= 64000);
    assert.equal(history.truncated, true);
    assert.ok(history.messages.every((item) => item.role !== "user" || JSON.parse(item.content).personalReferences.length === 2));
    assert.equal(chatHistory(messages.slice(0, 2)).truncated, true, "ordinary history keeps its existing default budget");
  });
});

test("retry and edit retain immutable reference snapshots after source deletion, including backup restoration", async () => {
  await withLibrary(async (store, paper, attachmentId, root) => {
    const note = createNote(store, "EXPLICIT SAVED CONTEXT $a^2$", "idea");
    const calls = captureAI();
    const events: ChatStreamEvent[] = [];
    await runPaperChat({paperId: paper.id, attachmentId, message: "EXPLICIT ORIGINAL QUESTION", contexts: [full(note)]}, (event) => events.push(event));
    const first = startEvent(events);
    const original = paperChatSnapshot(store)[0];
    store.db.prepare("DELETE FROM notes WHERE id=?").run(note.id);
    for (const kind of ["retry", "edit"] as const) {
      const branchEvents: ChatStreamEvent[] = [];
      await runPaperChat({paperId: paper.id, attachmentId,
        message: kind === "retry" ? first.userMessage.body : "EXPLICIT EDITED QUESTION",
        replay: {sourceConversationId: first.conversationId, sourceMessageId: first.userMessage.id, kind}},
      (event) => branchEvents.push(event));
      assert.deepEqual(startEvent(branchEvents).userMessage.contexts, first.userMessage.contexts);
      const payload = JSON.parse(calls.at(-1)!.messages.at(-1)!.content) as {personalReferences: {text: string}[]};
      assert.equal(payload.personalReferences[0].text, note.body);
    }
    assert.deepEqual(paperChatSnapshot(store).find((item) => item.id === original.id), original);
    const restored = restoreBackup(createBackup(store), root);
    const backupStore = new KBStore(restored.restoredDirectory);
    try { assert.deepEqual(paperChatSnapshot(backupStore), paperChatSnapshot(store)); }
    finally { backupStore.close(); }
    const replay = {sourceConversationId: first.conversationId, sourceMessageId: first.userMessage.id, kind: "retry" as const};
    assert.equal(paperChatInputSchema.safeParse({paperId: paper.id, attachmentId, message: first.userMessage.body,
      replay, contexts: []}).success, false);
    assert.throws(() => beginChatTurn(store, {paperId: paper.id, attachmentId, message: first.userMessage.body,
      replay, contexts: [], provider: "fixture", model: "fixture", scope: scopeFor(store, attachmentId)}), /沿用原引用/);
  });
});

test("stored context schema rejects forged links, inconsistent text bounds and assistant references; old messages remain compatible", async () => {
  await withLibrary(async (store, paper, attachmentId) => {
    const note = createNote(store, "EXPLICIT STORED SNAPSHOT");
    const context = resolveChatContexts(store, [full(note)])[0];
    assert.equal(chatContextSchema.safeParse(context).success, true);
    for (const invalid of [{...context, sourceHref: "https://bad.invalid"}, {...context, end: context.end + 1},
      {...context, field: "description"}, {...context, text: " "}, {...context, mode: "full", start: 1}])
      assert.equal(chatContextSchema.safeParse(invalid).success, false);
    const turn = beginChatTurn(store, {paperId: paper.id, attachmentId, message: "EXPLICIT PLAIN QUESTION",
      provider: "fixture", model: "fixture", scope: scopeFor(store, attachmentId)});
    assert.equal(paperChatMessageSchema.safeParse(turn.userMessage).success, true);
    assert.equal(paperChatMessageSchema.safeParse({...turn.assistantMessage, contexts: [context]}).success, false);
    assert.equal(paperChatMessageSchema.safeParse({...turn.userMessage, contexts: Array.from({length: 9}, () => context)}).success, false);
    updateChatMessage(store, {...turn.assistantMessage, body: "EXPLICIT FIXTURE ANSWER", status: "completed"});
  });
});
