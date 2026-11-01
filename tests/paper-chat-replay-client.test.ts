import test from "node:test";
import assert from "node:assert/strict";
import { PaperChatClient } from "../src/lib/paper-chat/client";
import type { ChatScope, ChatStreamEvent, PaperChatConfiguration, PaperChatConversation, PaperChatMessage } from "../src/lib/paper-chat/types";

const scope: ChatScope = {
  attachmentId: "source-pdf", attachmentSha256: "original-hash", pageIndices: [0, 1],
  totalPages: 2, characterCount: 300, truncated: false, historyMessages: 0, historyTruncated: false,
};
const configuration: PaperChatConfiguration = {
  provider: "openai-compatible", model: "default-model", configured: true, remote: true,
  credentialConfigured: true, environmentOverride: false, message: "configured", preferenceKey: "test-config",
};
function message(id: string, role: PaperChatMessage["role"], body: string,
  conversationId = "source-chat", status: PaperChatMessage["status"] = "completed"): PaperChatMessage {
  return { id, role, body, conversationId, status, provider: configuration.provider, model: "original-model",
    scope: role === "assistant" ? scope : null, error: "", createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:01Z" };
}
const original: PaperChatConversation = {
  id: "source-chat", paperId: "paper-a", attachmentId: "source-pdf", attachmentSha256: "original-hash", title: "原始讨论",
  createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:01Z",
  messages: [message("q1", "user", "第一个问题"), message("a1", "assistant", "第一个回答"),
    message("q2", "user", "第二个问题"), message("a2", "assistant", "第二个回答"),
    message("q3", "user", "最后一个问题"), message("a3", "assistant", "最后一个回答")],
};
const encode = (event: ChatStreamEvent) => new TextEncoder().encode(`${JSON.stringify(event)}\n`);
const history = (conversations = [original], config = configuration) => Response.json({ conversations, configuration: config });
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("state did not settle");
}
function replayEvents(sourceQuestion: string, body: string, model = "original-model", provider = configuration.provider) {
  const index = original.messages.findIndex((item) => item.id === sourceQuestion);
  const prefix = original.messages.slice(0, index).map((item) => ({ ...item, id: `clone-${item.id}`, conversationId: "branch-chat" }));
  const user = { ...message("branch-user", "user", body, "branch-chat"), provider, model };
  const assistant = { ...message("branch-assistant", "assistant", "", "branch-chat", "pending"), provider, model };
  const conversation = { ...original, id: "branch-chat", title: body, messages: [...prefix, user, assistant] };
  const answer = { ...assistant, body: "新回答 **Markdown**", status: "completed" as const };
  const start: ChatStreamEvent = { type: "start", conversationId: conversation.id, conversation,
    userMessage: user, assistantMessage: assistant, scope };
  const done: ChatStreamEvent = { type: "done", conversationId: conversation.id, message: answer };
  return { start, done, complete: { ...conversation, messages: [...prefix, user, answer] } };
}

test("retrying an earlier reply freezes the matching question, PDF and original model without sending the composer draft", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let posted: Record<string, unknown> = {};
  let persisted = [original];
  const events = replayEvents("q2", "第二个问题");
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return history(persisted);
    posted = JSON.parse(String(init.body));
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  });
  await client.load();
  client.setDraft("还没写完的追问");
  client.setModelOverride("retry-model");
  const pending = client.retryReply("a2");
  await until(() => Boolean(stream));
  assert.deepEqual(posted, { paperId: "paper-a", attachmentId: "source-pdf", message: "第二个问题", model: "original-model",
    replay: { sourceConversationId: "source-chat", sourceMessageId: "q2", kind: "retry" } });
  assert.equal(client.getSnapshot().activeId, "source-chat");
  assert.equal(client.getSnapshot().running?.model, "original-model");
  assert.equal(client.getSnapshot().running?.replay?.kind, "retry");
  client.setModelOverride("next-model");
  assert.equal(client.getSnapshot().running?.model, "original-model");
  stream.enqueue(encode(events.start));
  await until(() => client.getSnapshot().activeId === "branch-chat");
  assert.deepEqual(client.getSnapshot().conversations.find((item) => item.id === original.id), original);
  assert.deepEqual(client.getSnapshot().conversations[0].messages.map((item) => item.body), ["第一个问题", "第一个回答", "第二个问题", ""]);
  persisted = [events.complete, original];
  stream.enqueue(encode(events.done)); stream.close();
  assert.equal(await pending, true);
  assert.equal(client.getSnapshot().draft, "还没写完的追问");
  assert.equal(client.getSnapshot().activeId, "branch-chat");
  assert.equal(client.getSnapshot().modelOverride, "next-model");
  assert.deepEqual(client.getSnapshot().conversations.find((item) => item.id === original.id), original);
});

test("editing a historical question submits only its replacement and retains the source conversation", async () => {
  let persisted = [original];
  const events = replayEvents("q2", "修订后的第二个问题");
  const posts: Record<string, unknown>[] = [];
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return history(persisted);
    posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encode(events.start)); controller.enqueue(encode(events.done)); controller.close();
      persisted = [events.complete, original];
    } }));
  });
  await client.load();
  client.setDraft("独立草稿");
  assert.equal(await client.editQuestion("q2", "  修订后的第二个问题  "), true);
  assert.deepEqual(posts[0], { paperId: "paper-a", attachmentId: "source-pdf", message: "修订后的第二个问题",
    replay: { sourceConversationId: "source-chat", sourceMessageId: "q2", kind: "edit" } });
  assert.equal(client.getSnapshot().draft, "独立草稿");
  assert.equal(client.getSnapshot().conversations[0].messages.length, 4);
  assert.deepEqual(client.getSnapshot().conversations[1], original);
  await client.send("reader-has-another-pdf", "继续新分支");
  assert.deepEqual(posts[1], { paperId: "paper-a", attachmentId: "source-pdf", conversationId: "branch-chat", message: "继续新分支" });
});

test("pre-start replay failure keeps the active history and the independent composer draft", async () => {
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return history();
    return Response.json({ error: "模型暂时不可用" }, { status: 503 });
  });
  await client.load();
  client.setDraft("保留我的草稿");
  assert.equal(await client.editQuestion("q1", "不要丢失的编辑文本"), false);
  assert.equal(client.getSnapshot().activeId, original.id);
  assert.deepEqual(client.getSnapshot().conversations, [original]);
  assert.equal(client.getSnapshot().draft, "保留我的草稿");
  assert.equal(client.getSnapshot().error, "模型暂时不可用");
  client.setDraft("");
  assert.equal(await client.retryReply("a1"), false);
  assert.equal(client.getSnapshot().draft, "");
});

test("replay rejects wrong roles, foreign messages, missing questions and requests during history loading", async () => {
  let posts = 0;
  let gets = 0;
  let release!: (value: Response) => void;
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (init?.method) { posts += 1; return Response.json({ error: "unexpected" }, { status: 500 }); }
    if (++gets === 1) return history();
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  await client.load();
  assert.equal(await client.editQuestion("a1", "新问题"), false);
  assert.equal(await client.retryReply("q1"), false);
  assert.equal(await client.editQuestion("foreign-question", "新问题"), false);
  client.select(null);
  assert.equal(await client.retryReply("a1"), false);
  client.select(original.id);
  assert.equal(await client.editQuestion("q1", "   "), false);
  const refreshing = client.load(true);
  assert.equal(await client.retryReply("a1"), false);
  assert.equal(await client.editQuestion("q1", "新问题"), false);
  release(history()); await refreshing;
  assert.equal(posts, 0);

  const orphan = new PaperChatClient("paper-a", async () => history([{ ...original, messages: [original.messages[1]] }]));
  await orphan.load();
  assert.equal(await orphan.retryReply("a1"), false);
  assert.match(orphan.getSnapshot().error, /找不到.*提问/);
});

test("stopping before a replay starts preserves its source and does not overwrite a new conversation draft", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let wasAborted = false;
  let posts = 0;
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return history();
    posts += 1;
    return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      init.signal?.addEventListener("abort", () => {
        wasAborted = true; controller.error(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    } }));
  });
  await client.load();
  const pending = client.editQuestion("q1", "待发送修改");
  await until(() => Boolean(stream));
  assert.equal(await client.retryReply("a2"), false);
  assert.equal(await client.editQuestion("q2", "另一次修改"), false);
  client.newConversation(); client.setDraft("新对话的问题");
  client.stop();
  assert.equal(await pending, false);
  assert.equal(wasAborted, true);
  assert.equal(posts, 1);
  assert.equal(client.getSnapshot().activeId, null);
  assert.equal(client.getSnapshot().draft, "新对话的问题");
  assert.deepEqual(client.getSnapshot().conversations, [original]);
});

test("stopping a replay after start retains partial output in its new conversation only", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let started = false;
  const events = replayEvents("q1", "第一个问题");
  const partial = { ...events.complete, messages: events.complete.messages.map((item) => item.role === "assistant"
    ? { ...item, body: "收到的部分", status: "pending" as const } : item) };
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return history(started ? [partial, original] : [original]);
    return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      controller.enqueue(encode(events.start)); controller.enqueue(encode({ type: "delta", text: "收到的部分" }));
      init.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      started = true;
    } }));
  });
  await client.load();
  const pending = client.retryReply("a1");
  await until(() => Boolean(stream) && client.getSnapshot().conversations[0]?.messages[1]?.body === "收到的部分");
  client.setDraft("生成时另写的草稿"); client.stop();
  assert.equal(await pending, true);
  const state = client.getSnapshot();
  assert.equal(state.conversations[0].messages[1].status, "cancelled");
  assert.equal(state.conversations[0].messages[1].body, "收到的部分");
  assert.deepEqual(state.conversations[1], original);
  assert.equal(state.draft, "生成时另写的草稿");
});

test("a history response captured before replay start cannot erase the completed new conversation", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let release!: (response: Response) => void;
  let gets = 0;
  const events = replayEvents("q2", "第二个问题");
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) {
      if (++gets === 1) return history();
      return new Promise<Response>((resolve) => { release = resolve; });
    }
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  });
  await client.load();
  const replay = client.retryReply("a2");
  await until(() => Boolean(stream));
  const refresh = client.load(true);
  await until(() => Boolean(release));
  stream.enqueue(encode(events.start)); stream.enqueue(encode(events.done)); stream.close();
  await until(() => !client.getSnapshot().running);
  release(history());
  await Promise.all([replay, refresh]);
  assert.equal(client.getSnapshot().activeId, "branch-chat");
  assert.deepEqual(client.getSnapshot().conversations, [events.complete, original]);
});

test("switching away while replay prepares keeps the selected conversation and saves the new answer in background", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let persisted = [original];
  const events = replayEvents("q1", "第一个问题");
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return history(persisted);
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  });
  await client.load();
  const pending = client.retryReply("a1");
  await until(() => Boolean(stream));
  client.newConversation(); client.setDraft("新问题");
  persisted = [events.complete, original];
  stream.enqueue(encode(events.start)); stream.enqueue(encode(events.done)); stream.close();
  assert.equal(await pending, true);
  assert.equal(client.getSnapshot().activeId, null);
  assert.equal(client.getSnapshot().draft, "新问题");
  assert.deepEqual(client.getSnapshot().conversations, persisted);
});

test("a replay response cannot replace the original conversation instead of creating a branch", async () => {
  const sourceStart: ChatStreamEvent = { type: "start", conversationId: original.id, conversation: original,
    userMessage: original.messages[0], assistantMessage: original.messages[1], scope };
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return history();
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(encode(sourceStart)); controller.close(); } }));
  });
  await client.load();
  assert.equal(await client.retryReply("a1"), false);
  assert.match(client.getSnapshot().error, /来源不一致/);
  assert.deepEqual(client.getSnapshot().conversations, [original]);
});

test("switching provider refuses an old retry while editing a question can use the currently selected model", async () => {
  let config = configuration, persisted = [original];
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const posts: Record<string, unknown>[] = [];
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return history(persisted, config);
    posts.push(JSON.parse(String(init.body)));
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  });
  await client.load(); client.setDraft("切换服务时保留的独立草稿");
  config = { ...configuration, provider: "ollama", model: "current-default", preferenceKey: "different-provider" };
  await client.load(true); client.setModelOverride("current-model");
  assert.equal(await client.retryReply("a2"), false);
  assert.equal(posts.length, 0); assert.match(client.getSnapshot().error, /模型服务已切换/);
  assert.equal(client.getSnapshot().running, null); assert.deepEqual(client.getSnapshot().conversations, [original]);
  assert.equal(client.getSnapshot().draft, "切换服务时保留的独立草稿");
  const editing = client.editQuestion("q2", "换服务后重新提出的问题");
  await until(() => Boolean(stream));
  assert.deepEqual(posts[0], { paperId: "paper-a", attachmentId: "source-pdf", message: "换服务后重新提出的问题", model: "current-model",
    replay: { sourceConversationId: original.id, sourceMessageId: "q2", kind: "edit" } });
  assert.equal(client.getSnapshot().running?.model, "current-model"); client.setModelOverride("later-model");
  assert.equal(client.getSnapshot().running?.model, "current-model");
  const events = replayEvents("q2", "换服务后重新提出的问题", "current-model", "ollama");
  persisted = [events.complete, original]; stream.enqueue(encode(events.start)); stream.enqueue(encode(events.done)); stream.close();
  assert.equal(await editing, true);
  assert.equal(client.getSnapshot().conversations[0].messages.at(-1)?.provider, "ollama");
  assert.equal(client.getSnapshot().conversations[0].messages.at(-1)?.model, "current-model");
  assert.deepEqual(client.getSnapshot().conversations[1], original);
  assert.equal(client.getSnapshot().draft, "切换服务时保留的独立草稿");
  assert.equal(client.getSnapshot().modelOverride, "later-model");
});
