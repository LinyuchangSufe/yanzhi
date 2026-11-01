// Run against reading-chat-smoke's independent synthetic library and local mock.
// node --import tsx scripts/chat-actions-smoke.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { restoreBackup } from "../src/lib/archive.ts";
import { KBStore } from "../src/lib/db.ts";

const fixture = JSON.parse(fs.readFileSync("/private/tmp/kb-reading-chat-smoke.json", "utf8"));
assert.match(fixture.directory, /^\/private\/tmp\/kb-reading-chat-[\w-]+$/);
const base = "http://127.0.0.1:3133";
async function json(route, options) {
  const response = await fetch(base + route, options);
  const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return body;
}
async function chat(message, extra = {}) {
  const response = await fetch(base + "/api/kb/chat", {method: "POST", headers: {"Content-Type": "application/json", Origin: base},
    body: JSON.stringify({paperId: fixture.paperId, attachmentId: fixture.attachmentId, message, ...extra})});
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events[0].type, "start"); assert.equal(events.at(-1).type, "done");
  return events;
}
const before = await json("/api/kb");
const q1 = "合成验收：请解释这篇文章的方法。";
const q2 = "合成验收：请结合前一个回答解释公式。";
const first = await chat(q1);
const sourceId = first[0].conversationId;
await chat(q2, {conversationId: sourceId});
await json("/api/kb/chat", {method: "PATCH", headers: {"Content-Type": "application/json", Origin: base},
  body: JSON.stringify({paperId: fixture.paperId, conversationId: sourceId, title: "验收 · 原始两轮提问"})});
const original = (await json("/api/kb/chat?paperId=" + fixture.paperId)).conversations.find((item) => item.id === sourceId);
assert.equal(original.messages.length, 4);
const secondUser = original.messages[2];
const retry = await chat(q2, {replay: {sourceConversationId: sourceId, sourceMessageId: secondUser.id, kind: "retry"}});
assert.notEqual(retry[0].conversationId, sourceId);
assert.equal(retry[0].scope.historyMessages, 2);
let calls = JSON.parse(fs.readFileSync(fixture.directory + "/mock-requests.json", "utf8"));
assert.deepEqual(calls.at(-1).messages.filter((item) => item.role === "user").map((item) => item.content), [q1, q2]);
assert.equal(calls.at(-1).messages.filter((item) => item.role === "assistant").length, 1);
const editedText = "合成验收：请用修改后的问题解释关键假设。";
const edit = await chat(editedText, {model: "synthetic-alternate-model",
  replay: {sourceConversationId: sourceId, sourceMessageId: original.messages[0].id, kind: "edit"}});
assert.equal(edit[0].scope.historyMessages, 0);
assert.notEqual(edit[0].conversationId, sourceId);
calls = JSON.parse(fs.readFileSync(fixture.directory + "/mock-requests.json", "utf8"));
assert.equal(calls.at(-1).model, "synthetic-alternate-model");
assert.deepEqual(calls.at(-1).messages.filter((item) => item.role === "user").map((item) => item.content), [editedText]);
assert.equal(calls.at(-1).messages.filter((item) => item.role === "assistant").length, 0);
const after = await json("/api/kb");
assert.deepEqual(after.chatConversations.find((item) => item.id === sourceId), original);
assert.deepEqual(after.settings, before.settings);
assert.deepEqual(after.notes, before.notes);
const retrySaved = after.chatConversations.find((item) => item.id === retry[0].conversationId);
assert.equal(retrySaved.messages.length, 4);
assert.deepEqual(retrySaved.messages.slice(0, 2).map((item) => item.body), original.messages.slice(0, 2).map((item) => item.body));
assert.ok(retrySaved.messages.every((item) => !original.messages.some((other) => other.id === item.id)));
const restored = restoreBackup(Buffer.from(await (await fetch(base + "/api/kb/backup")).arrayBuffer()), "/private/tmp");
const restoredStore = new KBStore(restored.restoredDirectory);
try {assert.deepEqual(restoredStore.snapshot().chatConversations, after.chatConversations);}
finally {restoredStore.close();}
const report = {...fixture, verifiedAt: new Date().toISOString(), syntheticModelOnly: true,
  sourceConversationId: sourceId, retryConversationId: retry[0].conversationId, editConversationId: edit[0].conversationId,
  checks: ["retry uses prior prefix and original question only", "edit excludes old answer and all later questions", "each replay creates a new conversation and message IDs",
    "original conversation is unchanged", "selected model reaches provider", "notes and global settings unchanged", "backup restores all original and replay conversations"], result: "passed"};
fs.writeFileSync("test-results/chat-actions-http.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
