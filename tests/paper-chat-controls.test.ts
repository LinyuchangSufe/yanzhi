import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { KBStore, getStore } from "../src/lib/db";
import { createBackup, restoreBackup } from "../src/lib/archive";
import { GET, PATCH, POST } from "../src/app/api/kb/chat/route";
import { beginChatTurn, paperChatSnapshot, updateChatMessage } from "../src/lib/paper-chat/store";
import type { ChatScope, ChatStreamEvent, PaperChatConfiguration, PaperChatConversation } from "../src/lib/paper-chat/types";
import type { Paper } from "../src/lib/types";

const routeUrl = "http://127.0.0.1:3000/api/kb/chat";
function jsonRequest(method: "PATCH" | "POST", body: unknown, headers?: Record<string, string>) {
  return new Request(routeUrl, {method, headers: {"content-type": "application/json", ...headers}, body: JSON.stringify(body)});
}
async function withLibrary(run: (store: KBStore, paper: Paper, attachmentId: string, root: string) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-chat-controls-fixture-"));
  const previous = {...process.env};
  const originalFetch = globalThis.fetch;
  process.env.KB_DATA_DIR = path.join(root, "data");
  process.env.KB_AI_PROVIDER = "ollama";
  process.env.KB_OLLAMA_MODEL = "fixture-default-model";
  process.env.KB_OLLAMA_URL = "http://127.0.0.1:11434";
  process.env.KB_OPENAI_API_KEY = "private-fixture-key-never-return";
  const store = getStore();
  try {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    page.drawText("EXPLICIT SYNTHETIC TEST SOURCE. No actual paper findings.", {font: await pdf.embedFont(StandardFonts.Helvetica), size: 10});
    const paper = store.dispatch("paper.create", {title: "EXPLICIT CHAT CONTROLS TEST"}) as Paper;
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
function beginFixture(store: KBStore, paperId: string, attachmentId: string) {
  const attachment = store.snapshot().attachments.find((item) => item.id === attachmentId)!;
  const scope: ChatScope = {attachmentId, attachmentSha256: attachment.sha256, pageIndices: [0], totalPages: 1,
    characterCount: 50, truncated: false, historyMessages: 0, historyTruncated: false};
  return beginChatTurn(store, {paperId, attachmentId, message: "Automatic fixture title", provider: "fixture-provider", model: "fixture-model", scope});
}

test("chat rename persists through streaming message saves, reopen, and backup without changing message data", async () => {
  await withLibrary(async (store, paper, attachmentId, root) => {
    const turn = beginFixture(store, paper.id, attachmentId);
    const before = paperChatSnapshot(store, paper.id)[0];
    const response = await PATCH(jsonRequest("PATCH", {paperId: paper.id, conversationId: turn.conversation.id, title: "  我的自定义研究对话  "}));
    assert.equal(response.status, 200);
    const renamed = (await response.json() as {conversation: PaperChatConversation}).conversation;
    assert.equal(renamed.title, "我的自定义研究对话");
    assert.deepEqual(renamed.messages, before.messages);
    assert.equal(renamed.attachmentSha256, before.attachmentSha256);
    updateChatMessage(store, {...turn.assistantMessage, body: "Fixture increment after rename"});
    updateChatMessage(store, {...turn.assistantMessage, body: "Fixture final after rename", status: "completed"});
    const snapshot = paperChatSnapshot(store, paper.id)[0];
    assert.equal(snapshot.title, renamed.title, "late generation saves must never rewrite the conversation title");
    const reopened = new KBStore(store.dataDir);
    try { assert.equal(paperChatSnapshot(reopened, paper.id)[0].title, renamed.title); }
    finally { reopened.close(); }
    const restored = restoreBackup(createBackup(store), root);
    const backupStore = new KBStore(restored.restoredDirectory);
    try { assert.deepEqual(paperChatSnapshot(backupStore, paper.id), paperChatSnapshot(store, paper.id)); }
    finally { backupStore.close(); }
  });
});

test("chat rename rejects cross-paper, cross-site, invalid, oversized, and unknown payloads", async () => {
  await withLibrary(async (store, paper, attachmentId) => {
    const turn = beginFixture(store, paper.id, attachmentId);
    const base = {paperId: paper.id, conversationId: turn.conversation.id, title: "Fixture renamed"};
    const otherPaper = store.dispatch("paper.create", {title: "OTHER FIXTURE PAPER"}) as Paper;
    assert.equal((await PATCH(jsonRequest("PATCH", {...base, paperId: otherPaper.id}))).status, 404);
    assert.equal((await PATCH(jsonRequest("PATCH", base, {origin: "https://cross-site.fixture"}))).status, 403);
    for (const body of [{...base, title: "   "}, {...base, title: "x".repeat(121)}, {...base, title: 12},
      {...base, paperId: "bad-id"}, {...base, model: "not-allowed"}]) {
      assert.equal((await PATCH(jsonRequest("PATCH", body))).status, 400);
    }
    assert.equal(paperChatSnapshot(store, paper.id)[0].title, turn.conversation.title);
    store.dispatch("paper.trash", {id: paper.id, revision: paper.revision});
    assert.equal((await PATCH(jsonRequest("PATCH", base))).status, 409);
  });
});

test("chat model selection reaches the provider only for that request, records actual model, and keeps global settings", async () => {
  await withLibrary(async (store, paper, attachmentId) => {
    const settings = store.snapshot().settings;
    const calls: {url: string; body: {model: string}}[] = [];
    globalThis.fetch = async (url, options) => {
      calls.push({url: String(url), body: JSON.parse(String(options?.body)) as {model: string}});
      return new Response('{"model":"fixture-resolved-model","message":{"content":"Explicit fixture answer"},"done":true}\n');
    };
    const response = await POST(jsonRequest("POST", {paperId: paper.id, attachmentId, message: "First fixture question", model: "  fixture-selected-model  "}));
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as ChatStreamEvent);
    const done = events.find((event) => event.type === "done");
    assert.ok(done && done.type === "done");
    assert.equal(calls[0].url, "http://127.0.0.1:11434/api/chat");
    assert.equal(calls[0].body.model, "fixture-selected-model");
    assert.equal(done.message.model, "fixture-resolved-model");
    const conversation = paperChatSnapshot(store, paper.id)[0];
    assert.equal(conversation.messages[0].model, "fixture-selected-model");
    assert.equal(conversation.messages[1].model, "fixture-resolved-model");
    const next = await POST(jsonRequest("POST", {paperId: paper.id, attachmentId, conversationId: conversation.id, message: "Next fixture question"}));
    await next.text();
    assert.equal(calls[1].body.model, "fixture-default-model", "omitting an override follows the current default again");
    assert.deepEqual(store.snapshot().settings, settings, "per-request model changes must never write global settings");
    for (const extra of [{model: ""}, {model: "x".repeat(301)}, {model: "line\nbreak"}, {model: null},
      {provider: "openai-compatible"}, {endpoint: "https://untrusted.fixture/v1"}, {apiKey: "not-allowed"}]) {
      const invalid = await POST(jsonRequest("POST", {paperId: paper.id, attachmentId, message: "Invalid fixture question", ...extra}));
      assert.equal(invalid.status, 400);
    }
    assert.equal(calls.length, 2, "invalid input must never invoke a model");
  });
});

test("chat configuration exposes only safe fields and isolates preferences when the active service changes", async () => {
  await withLibrary(async (_store, paper) => {
    const load = async () => {
      const response = await GET(new Request(`${routeUrl}?paperId=${paper.id}`));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.text();
      assert.ok(!body.includes("private-fixture-key-never-return"));
      assert.ok(!body.includes("11434"));
      assert.ok(!body.includes("KB_DATA_DIR"));
      return JSON.parse(body) as {conversations: PaperChatConversation[]; configuration: PaperChatConfiguration};
    };
    const first = await load();
    assert.deepEqual(first.conversations, []);
    assert.deepEqual(Object.keys(first.configuration).sort(), ["provider", "model", "configured", "remote", "credentialConfigured", "environmentOverride", "message", "preferenceKey"].sort());
    assert.equal(first.configuration.model, "fixture-default-model");
    assert.equal(first.configuration.provider, "ollama");
    assert.equal(first.configuration.environmentOverride, true);
    assert.match(first.configuration.preferenceKey, /^[a-f0-9]{64}$/);
    assert.equal((await load()).configuration.preferenceKey, first.configuration.preferenceKey);
    process.env.KB_OLLAMA_URL = "http://127.0.0.1:11435";
    assert.notEqual((await load()).configuration.preferenceKey, first.configuration.preferenceKey);
  });
});
