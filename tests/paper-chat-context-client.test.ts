import test from "node:test";
import assert from "node:assert/strict";
import { PaperChatClient } from "../src/lib/paper-chat/client";
import type { ChatContext, ChatScope, ChatStreamEvent, PaperChatConversation, PaperChatMessage } from "../src/lib/paper-chat/types";

const scope: ChatScope = {
  attachmentId: "pdf-a", attachmentSha256: "hash", pageIndices: [0], totalPages: 1,
  characterCount: 100, truncated: false, historyMessages: 0, historyTruncated: false,
};
const context = (id = "note-a", text = "我的研究记录", mode: ChatContext["mode"] = "full"): ChatContext => ({
  noteId: id, title: id, purpose: "paper", revision: 3, mode, text,
  start: mode === "full" ? 0 : 2, end: (mode === "full" ? 0 : 2) + text.length, sourceHref: `kb://note/${id}`,
});
function message(id: string, role: PaperChatMessage["role"], body: string,
  conversationId = "chat-a", status: PaperChatMessage["status"] = "completed", contexts?: ChatContext[]): PaperChatMessage {
  return { id, role, body, conversationId, status, provider: "test", model: "model-a", ...(contexts ? { contexts } : {}),
    scope: role === "assistant" ? scope : null, error: "", createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:01Z" };
}
const conversation = (messages: PaperChatMessage[] = [], id = "chat-a"): PaperChatConversation => ({
  id, paperId: "paper-a", attachmentId: "pdf-a", attachmentSha256: "hash", title: "测试对话", messages,
  createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:01Z",
});
const encode = (event: ChatStreamEvent) => new TextEncoder().encode(`${JSON.stringify(event)}\n`);
const history = (conversations: PaperChatConversation[] = []) => Response.json({ conversations });
function events(contexts: ChatContext[] = [], id = "chat-a") {
  const user = message("user-a", "user", "结合记录分析", id, "completed", contexts);
  const assistant = message("assistant-a", "assistant", "", id, "pending");
  const answer = { ...assistant, status: "completed" as const, body: "分析完成" };
  const start: ChatStreamEvent = { type: "start", conversationId: id, conversation: conversation([], id),
    userMessage: user, assistantMessage: assistant, scope };
  const done: ChatStreamEvent = { type: "done", conversationId: id, message: answer };
  return { start, done, complete: conversation([user, answer], id) };
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("state did not settle");
}

test("context drafts copy selected snapshots, reject duplicates and remove by index", () => {
  const client = new PaperChatClient("paper-a");
  const selected = context();
  assert.equal(client.addContext(selected), true);
  selected.text = "外部对象被改写";
  assert.equal(client.getSnapshot().draftContexts[0].text, "我的研究记录");
  assert.equal(client.addContext(context()), false);
  assert.match(client.getSnapshot().error, /已经/);
  assert.equal(client.addContext(context("note-a", "研究", "excerpt")), true);
  client.removeContext(-1);
  client.removeContext(100);
  assert.equal(client.getSnapshot().draftContexts.length, 2);
  client.removeContext(0);
  assert.equal(client.getSnapshot().draftContexts[0].mode, "excerpt");
  client.clearContexts();
  assert.deepEqual(client.getSnapshot().draftContexts, []);
});

test("context limits guard item size, total characters and count independently", () => {
  const client = new PaperChatClient("paper-a");
  assert.equal(client.addContext(context("empty", " \n")), false);
  assert.equal(client.addContext(context("large", "a".repeat(16_001))), false);
  assert.equal(client.addContext(context("large", "a".repeat(16_000))), true);
  assert.equal(client.addContext(context("remaining", "b".repeat(8_000))), true);
  assert.equal(client.addContext(context("overflow", "c")), false);
  client.clearContexts();
  for (let index = 0; index < 8; index++) assert.equal(client.addContext(context(`note-${index}`, "a")), true);
  assert.equal(client.addContext(context("ninth", "a")), false);
  assert.equal(client.getSnapshot().draftContexts.length, 8);
});

test("a whole research question adds its description and note atomically and deduplicates default body fields", () => {
  const client = new PaperChatClient("paper-a");
  const body = context();
  const description = { ...context("note-a", "研究问题的描述"), field: "description" as const };
  assert.equal(client.addContexts([description, body]), true);
  assert.deepEqual(client.getSnapshot().draftContexts, [description, body]);
  assert.equal(client.addContext({ ...body, field: "body" }), false);
  client.clearContexts();
  assert.equal(client.addContexts([description, context("invalid", "a".repeat(16_001))]), false);
  assert.deepEqual(client.getSnapshot().draftContexts, []);
  assert.equal(client.addContexts([body, { ...body, field: "body" }]), false);
  assert.deepEqual(client.getSnapshot().draftContexts, []);
  assert.equal(client.addContexts([body, { ...body, mode: "excerpt" }]), false);
  assert.deepEqual(client.getSnapshot().draftContexts, []);
});

test("normal sends freeze context snapshots but transport only source IDs, revision and excerpt offsets", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let posted: Record<string, unknown> = {};
  let persisted: PaperChatConversation[] = [];
  const full = context();
  const excerpt = { ...context("note-b", "$x^2$", "excerpt"), field: "description" as const };
  const result = events([full, excerpt]);
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return history(persisted);
    posted = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  });
  await client.load();
  client.setDraft("结合记录分析");
  client.addContext(full); client.addContext(excerpt);
  const sending = client.send("pdf-a");
  await until(() => Boolean(stream));
  assert.deepEqual(posted, { paperId: "paper-a", attachmentId: "pdf-a", message: "结合记录分析", contexts: [
    { noteId: "note-a", revision: 3, mode: "full" },
    { noteId: "note-b", revision: 3, mode: "excerpt", field: "description", start: 2, end: 7 },
  ] });
  assert.deepEqual(client.getSnapshot().draftContexts, []);
  assert.deepEqual(client.getSnapshot().running?.contexts, [full, excerpt]);
  client.setDraft("下一轮问题"); client.addContext(context("next-note"));
  assert.deepEqual(client.getSnapshot().running?.contexts, [full, excerpt]);
  stream.enqueue(encode(result.start)); stream.enqueue(encode(result.done)); stream.close();
  persisted = [result.complete];
  await sending;
  assert.equal(client.getSnapshot().draft, "下一轮问题");
  assert.equal(client.getSnapshot().draftContexts[0].noteId, "next-note");
  assert.deepEqual(client.getSnapshot().conversations[0].messages[0].contexts, [full, excerpt]);
});

test("HTTP 200 validation errors before start restore the full unsent question and references", async () => {
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return history();
    return new Response(`${JSON.stringify({ type: "error", message: "引用已更新，请重新选择" })}\n`);
  });
  await client.load();
  client.setDraft("  保留问题原有空白\n"); client.addContext(context());
  await client.send("pdf-a");
  assert.equal(client.getSnapshot().draft, "  保留问题原有空白\n");
  assert.deepEqual(client.getSnapshot().draftContexts, [context()]);
  assert.equal(client.getSnapshot().running, null);
  assert.equal(client.getSnapshot().error, "引用已更新，请重新选择");
});

test("HTTP failures and malformed pre-start streams preserve attached context for a retry", async () => {
  for (const failedResponse of [Response.json({ error: "暂不可用" }, { status: 503 }), new Response("broken\n")]) {
    const client = new PaperChatClient("paper-a", async (_url, init) => !init?.method ? history() : failedResponse);
    await client.load(); client.setDraft("重试这个问题"); client.addContext(context());
    await client.send("pdf-a");
    assert.equal(client.getSnapshot().draft, "重试这个问题");
    assert.deepEqual(client.getSnapshot().draftContexts, [context()]);
    assert.ok(client.getSnapshot().error);
  }
});

test("a failed preparing send cannot overwrite a newer draft or mix its references into it", async () => {
  let respond!: (value: Response) => void;
  const client = new PaperChatClient("paper-a", async (_url, init) => !init?.method ? history() :
    new Promise<Response>((resolve) => { respond = resolve; }));
  await client.load(); client.setDraft("旧问题"); client.addContext(context());
  const sending = client.send("pdf-a");
  await until(() => Boolean(respond));
  client.setDraft("新问题"); client.addContext(context("new-note"));
  respond(Response.json({ error: "旧请求失败" }, { status: 503 }));
  await sending;
  assert.equal(client.getSnapshot().draft, "新问题");
  assert.deepEqual(client.getSnapshot().draftContexts, [context("new-note")]);
});

test("a new conversation clears references without resurrecting a failed background send", async () => {
  let respond!: (value: Response) => void;
  const client = new PaperChatClient("paper-a", async (_url, init) => !init?.method ? history() :
    new Promise<Response>((resolve) => { respond = resolve; }));
  await client.load(); client.setDraft("旧问题"); client.addContext(context());
  const sending = client.send("pdf-a");
  await until(() => Boolean(respond));
  client.newConversation();
  respond(Response.json({ error: "旧请求失败" }, { status: 503 }));
  await sending;
  assert.equal(client.getSnapshot().draft, "");
  assert.deepEqual(client.getSnapshot().draftContexts, []);
  client.addContext(context()); client.newConversation();
  assert.deepEqual(client.getSnapshot().draftContexts, []);
});

test("revealing a preparing request does not prevent recovery of its unsent references", async () => {
  let respond!: (value: Response) => void;
  const client = new PaperChatClient("paper-a", async (_url, init) => !init?.method ? history() :
    new Promise<Response>((resolve) => { respond = resolve; }));
  await client.load(); client.setDraft("待恢复的问题"); client.addContext(context());
  const sending = client.send("pdf-a");
  await until(() => Boolean(respond));
  client.select("previous-chat");
  assert.equal(client.revealRunning(), true);
  respond(Response.json({ error: "引用已更新" }, { status: 409 }));
  await sending;
  assert.equal(client.getSnapshot().draft, "待恢复的问题");
  assert.deepEqual(client.getSnapshot().draftContexts, [context()]);
});

test("context selection survives UI detachment and stays isolated between paper clients", () => {
  const first = new PaperChatClient("paper-a");
  const second = new PaperChatClient("paper-b");
  const unsubscribe = first.subscribe(() => {});
  first.addContext(context()); unsubscribe(); first.select("other-chat");
  assert.deepEqual(first.getSnapshot().draftContexts, [context()]);
  assert.deepEqual(second.getSnapshot().draftContexts, []);
});

test("retry and edit inherit historical contexts without sending or consuming composer references", async () => {
  const oldContext = context("historical-note", "原提问时的记录");
  const original = conversation([message("user-a", "user", "结合记录分析", "chat-a", "completed", [oldContext]),
    message("assistant-a", "assistant", "原回答")]);
  for (const kind of ["retry", "edit"] as const) {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let posted: Record<string, unknown> = {};
    let persisted = [original];
    const result = events([oldContext], "branch-chat");
    const client = new PaperChatClient("paper-a", async (_url, init) => {
      if (!init?.method) return history(persisted);
      posted = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
    });
    await client.load(); client.setDraft("独立的新问题"); client.addContext(context("composer-note"));
    const sending = kind === "retry" ? client.retryReply("assistant-a") : client.editQuestion("user-a", "修订的提问");
    await until(() => Boolean(stream));
    assert.equal("contexts" in posted, false);
    assert.deepEqual(posted.replay, { sourceConversationId: "chat-a", sourceMessageId: "user-a", kind });
    assert.deepEqual(client.getSnapshot().running?.contexts, [oldContext]);
    assert.deepEqual(client.getSnapshot().draftContexts, [context("composer-note")]);
    persisted = [result.complete, original];
    stream.enqueue(encode(result.start)); stream.enqueue(encode(result.done)); stream.close();
    assert.equal(await sending, true);
    assert.equal(client.getSnapshot().draft, "独立的新问题");
    assert.deepEqual(client.getSnapshot().draftContexts, [context("composer-note")]);
    assert.deepEqual(client.getSnapshot().conversations[1], original);
  }
});

test("stopping before start restores references while stopping after start leaves them in history", async () => {
  for (const started of [false, true]) {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let persisted: PaperChatConversation[] = [];
    const result = events([context()]);
    const client = new PaperChatClient("paper-a", async (_url, init) => {
      if (!init?.method) return history(persisted);
      return new Response(new ReadableStream({ start(controller) {
        stream = controller;
        init.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      } }));
    });
    await client.load(); client.setDraft("结合记录分析"); client.addContext(context());
    const sending = client.send("pdf-a");
    await until(() => Boolean(stream));
    if (started) {
      stream.enqueue(encode(result.start));
      persisted = [conversation([message("user-a", "user", "结合记录分析", "chat-a", "completed", [context()]),
        message("assistant-a", "assistant", "", "chat-a", "pending")])];
      await until(() => Boolean(client.getSnapshot().running?.assistantId));
    }
    client.stop(); await sending;
    assert.deepEqual(client.getSnapshot().draftContexts, started ? [] : [context()]);
    assert.equal(client.getSnapshot().draft, started ? "" : "结合记录分析");
    if (started) assert.deepEqual(client.getSnapshot().conversations[0].messages[0].contexts, [context()]);
  }
});
