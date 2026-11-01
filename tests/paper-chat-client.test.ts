import test from "node:test";
import assert from "node:assert/strict";
import { PaperChatClient, readChatEvents } from "../src/lib/paper-chat/client";
import type { ChatScope, ChatStreamEvent, PaperChatConfiguration, PaperChatConversation, PaperChatMessage } from "../src/lib/paper-chat/types";

const scope: ChatScope = {
  attachmentId: "pdf-a", attachmentSha256: "hash", pageIndices: [0, 1],
  totalPages: 2, characterCount: 500, truncated: false, historyMessages: 0, historyTruncated: false,
};
const message = (id: string, role: "user" | "assistant", body = "", status: PaperChatMessage["status"] = "completed"): PaperChatMessage => ({
  id, conversationId: "conversation-a", role, body, status, provider: "test", model: "test-model",
  scope: role === "assistant" ? scope : null, error: "", createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:01Z",
});
const conversation = (messages: PaperChatMessage[] = []): PaperChatConversation => ({
  id: "conversation-a", paperId: "paper-a", attachmentId: "pdf-a", attachmentSha256: "hash", title: "问题",
  createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:01Z", messages,
});
const startEvent = (history: PaperChatMessage[] = []): ChatStreamEvent => ({
  type: "start", conversationId: "conversation-a", conversation: conversation(history),
  userMessage: message("user-a", "user", "解释公式"), assistantMessage: message("assistant-a", "assistant", "", "pending"), scope,
});
const doneEvent = (): ChatStreamEvent => ({ type: "done", conversationId: "conversation-a", message: message("assistant-a", "assistant", "公式解释") });
const encode = (event: ChatStreamEvent) => new TextEncoder().encode(`${JSON.stringify(event)}\n`);
const json = (conversations: PaperChatConversation[]) => Response.json({ conversations });

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("state did not settle");
}

test("chat decoder handles split UTF-8, CRLF and final record without newline", async () => {
  const text = `${JSON.stringify({ type: "delta", text: "公式 α" })}\r\n${JSON.stringify(doneEvent())}`;
  const bytes = new TextEncoder().encode(text);
  const events: ChatStreamEvent[] = [];
  await readChatEvents(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }), (event) => events.push(event));
  assert.deepEqual(events, [{ type: "delta", text: "公式 α" }, doneEvent()]);
});

test("continued conversation retains history and fixed PDF attachment", async () => {
  const history = [message("old-user", "user", "旧问题"), message("old-assistant", "assistant", "旧回答")];
  let persisted = history;
  let posted: Record<string, unknown> = {};
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return json([conversation(persisted)]);
    posted = JSON.parse(String(init.body));
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encode(startEvent(history)));
      controller.enqueue(encode({ type: "delta", text: "公式" }));
      controller.enqueue(encode({ type: "delta", text: "解释" }));
      controller.enqueue(encode(doneEvent()));
      persisted = [...history, message("user-a", "user", "解释公式"), message("assistant-a", "assistant", "公式解释")];
      controller.close();
    } }));
  });
  await client.load();
  client.setDraft("解释公式");
  await client.send("another-pdf");
  assert.deepEqual(posted, { paperId: "paper-a", attachmentId: "pdf-a", conversationId: "conversation-a", message: "解释公式" });
  assert.equal(client.getSnapshot().conversations[0].messages.length, 4);
  assert.equal(client.getSnapshot().conversations[0].messages[3].body, "公式解释");
  assert.equal(client.getSnapshot().running, null);
  assert.equal(client.getSnapshot().draft, "");
  assert.equal(client.getSnapshot().error, "");
});

test("stopping preserves received Markdown even if reload observes pending server record", async () => {
  let bodyController: ReadableStreamDefaultController<Uint8Array>;
  let started = false;
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return json(started ? [conversation([
      message("user-a", "user", "解释公式"), message("assistant-a", "assistant", "**部分**", "pending"),
    ])] : []);
    started = true;
    return new Response(new ReadableStream({ start(controller) {
      bodyController = controller;
      controller.enqueue(encode(startEvent()));
      controller.enqueue(encode({ type: "delta", text: "**部分**" }));
      init.signal?.addEventListener("abort", () => bodyController.error(new DOMException("Aborted", "AbortError")), { once: true });
    } }));
  });
  await client.load();
  client.setDraft("解释公式");
  const pending = client.send("pdf-a");
  await until(() => client.getSnapshot().conversations[0]?.messages[1]?.body === "**部分**");
  client.stop();
  await pending;
  assert.equal(client.getSnapshot().running, null);
  const reply = client.getSnapshot().conversations[0].messages[1];
  assert.equal(reply.status, "cancelled");
  assert.equal(reply.body, "**部分**");
  assert.equal(client.getSnapshot().error, "");
});

test("removing the UI subscriber keeps the stream running for background reading", async () => {
  let finish: (() => void) | undefined;
  let aborted = false;
  let stored = false;
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return json(stored ? [conversation([message("user-a", "user", "解释公式"), message("assistant-a", "assistant", "公式解释")])] : []);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encode(startEvent()));
      init.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      finish = () => { stored = true; controller.enqueue(encode(doneEvent())); controller.close(); };
    } }));
  });
  await client.load();
  const unsubscribe = client.subscribe(() => {});
  client.setDraft("解释公式");
  const pending = client.send("pdf-a");
  await until(() => Boolean(client.getSnapshot().running?.assistantId));
  unsubscribe();
  assert.equal(aborted, false);
  finish!();
  await pending;
  assert.equal(client.getSnapshot().conversations[0].messages[1].body, "公式解释");
  assert.equal(client.getSnapshot().conversations[0].messages[1].status, "completed");
});

test("bad response before start keeps the prompt editable and exposes an error", async () => {
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return json([]);
    return new Response("not valid JSON\n");
  });
  await client.load();
  client.setDraft("解释公式");
  await client.send("pdf-a");
  assert.equal(client.getSnapshot().draft, "解释公式");
  assert.match(client.getSnapshot().error, /响应格式不正确/);
  assert.equal(client.getSnapshot().running, null);
});

test("a background response saves its answer without redirecting a newly chosen conversation", async () => {
  let finish: (() => void) | undefined;
  let completed = false;
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return json(completed ? [conversation([message("user-a", "user", "解释公式"), message("assistant-a", "assistant", "公式解释")])] : []);
    return new Response(new ReadableStream({ start(controller) {
      finish = () => {
        controller.enqueue(encode(startEvent())); controller.enqueue(encode(doneEvent()));
        completed = true; controller.close();
      };
    } }));
  });
  await client.load();
  client.setDraft("解释公式");
  const pending = client.send("pdf-a");
  await until(() => Boolean(finish));
  client.newConversation();
  finish!();
  await pending;
  assert.equal(client.getSnapshot().activeId, null);
  assert.equal(client.getSnapshot().conversations[0].messages[1].body, "公式解释");
});

test("concurrent history refresh cannot replace streamed text with a stale pending record", async () => {
  let finish: (() => void) | undefined;
  let started = false;
  let completed = false;
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return json(started ? [conversation([
      message("user-a", "user", "解释公式"),
      message("assistant-a", "assistant", completed ? "公式解释" : "", completed ? "completed" : "pending"),
    ])] : []);
    started = true;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encode(startEvent()));
      controller.enqueue(encode({ type: "delta", text: "公式" }));
      finish = () => {
        completed = true; controller.enqueue(encode(doneEvent())); controller.close();
      };
    } }));
  });
  await client.load();
  const pending = client.send("pdf-a", "解释公式");
  await until(() => client.getSnapshot().conversations[0]?.messages[1]?.body === "公式");
  await client.load(true);
  assert.equal(client.getSnapshot().conversations[0].messages[1].body, "公式");
  finish!();
  await pending;
  assert.equal(client.getSnapshot().conversations[0].messages[1].body, "公式解释");
});

test("returning to a preparing background conversation follows the eventual saved conversation", async () => {
  let finish: (() => void) | undefined;
  let completed = false;
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return json(completed ? [conversation([message("user-a", "user", "解释公式"), message("assistant-a", "assistant", "公式解释")])] : []);
    return new Response(new ReadableStream({ start(controller) {
      finish = () => {
        controller.enqueue(encode(startEvent())); controller.enqueue(encode(doneEvent()));
        completed = true; controller.close();
      };
    } }));
  });
  await client.load();
  const pending = client.send("pdf-a", "解释公式");
  await until(() => Boolean(finish));
  client.newConversation();
  assert.equal(client.revealRunning(), true);
  assert.equal(client.getSnapshot().running?.optimisticVisible, true);
  finish!();
  await pending;
  assert.equal(client.getSnapshot().activeId, "conversation-a");
});

test("default transport calls browser fetch without using the chat client as its receiver", async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  let persisted = false;
  globalThis.fetch = function(this: unknown, _input, init) {
    // Window.fetch rejects class-instance receivers even though Node's fetch accepts them.
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    methods.push(init?.method || "GET");
    if (!init?.method) return Promise.resolve(json(persisted ? [conversation([
      message("user-a", "user", "解释公式"), message("assistant-a", "assistant", "公式解释"),
    ])] : []));
    return Promise.resolve(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encode(startEvent())); controller.enqueue(encode(doneEvent()));
      persisted = true; controller.close();
    } })));
  };
  try {
    const client = new PaperChatClient("paper-a");
    await client.load();
    assert.equal(client.getSnapshot().loaded, true);
    assert.equal(client.getSnapshot().error, "");
    await client.send("pdf-a", "解释公式");
    assert.equal(client.getSnapshot().conversations[0].messages[1].body, "公式解释");
    assert.equal(client.getSnapshot().error, "");
    assert.deepEqual(methods, ["GET", "POST", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const configuration = (values: Partial<PaperChatConfiguration> = {}): PaperChatConfiguration => ({
  provider: "openai-compatible", model: "global-model", configured: true, remote: true,
  credentialConfigured: true, environmentOverride: false, message: "configured", preferenceKey: "config-a", ...values,
});
function modelStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("renaming during generation changes metadata without replacing streamed Markdown", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let completeRename!: (value: Response) => void;
  let title = "问题";
  let finished = false;
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return json([{ ...conversation(finished ? [
      message("user-a", "user", "解释公式"), message("assistant-a", "assistant", "公式解释"),
    ] : []), title }]);
    if (init.method === "PATCH") {
      assert.deepEqual(JSON.parse(String(init.body)), { paperId: "paper-a", conversationId: "conversation-a", title: "我的公式讨论" });
      return new Promise<Response>((resolve) => { completeRename = resolve; });
    }
    return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      controller.enqueue(encode(startEvent()));
      controller.enqueue(encode({ type: "delta", text: "公式" }));
    } }));
  });
  await client.load();
  const sending = client.send("pdf-a", "解释公式");
  await until(() => client.getSnapshot().conversations[0]?.messages[1]?.body === "公式");
  const renaming = client.renameConversation("conversation-a", " 我的公式讨论 ");
  await until(() => Boolean(completeRename));
  stream.enqueue(encode({ type: "delta", text: "解释" }));
  await until(() => client.getSnapshot().conversations[0]?.messages[1]?.body === "公式解释");
  title = "我的公式讨论";
  completeRename(Response.json({ conversation: { ...conversation(), title } }));
  assert.equal(await renaming, "");
  assert.equal(client.getSnapshot().conversations[0].title, title);
  assert.equal(client.getSnapshot().conversations[0].messages[1].body, "公式解释");
  assert.ok(client.getSnapshot().running);
  finished = true;
  stream.enqueue(encode(doneEvent())); stream.close();
  await sending;
  assert.equal(client.getSnapshot().conversations[0].title, title);
  assert.equal(client.getSnapshot().conversations[0].messages[1].status, "completed");
});

test("renaming while a delayed start event arrives retains the user-chosen title", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let title = "问题";
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return json([{ ...conversation(), title }]);
    if (init.method === "PATCH") {
      title = "保留的名称";
      return Response.json({ conversation: { ...conversation(), title } });
    }
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  });
  await client.load();
  const sending = client.send("pdf-a", "解释公式");
  await until(() => Boolean(stream));
  assert.equal(await client.renameConversation("conversation-a", "保留的名称"), "");
  stream.enqueue(encode(startEvent()));
  await until(() => Boolean(client.getSnapshot().running?.assistantId));
  assert.equal(client.getSnapshot().conversations[0].title, "保留的名称");
  stream.enqueue(encode(doneEvent())); stream.close();
  await sending;
});

test("a stale history response cannot undo a completed rename", async () => {
  let refresh!: (value: Response) => void;
  let gets = 0;
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (init?.method === "PATCH") return Response.json({ conversation: { ...conversation(), title: "新名称" } });
    if (++gets === 1) return json([conversation()]);
    return new Promise<Response>((resolve) => { refresh = resolve; });
  });
  await client.load();
  const refreshing = client.load(true);
  await until(() => Boolean(refresh));
  assert.equal(await client.renameConversation("conversation-a", "新名称"), "");
  refresh(json([conversation()]));
  await refreshing;
  assert.equal(client.getSnapshot().conversations[0].title, "新名称");
});

test("opening model controls with an older history snapshot does not erase newly streamed messages", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return json([conversation(finished ? [
      message("user-a", "user", "解释公式"), message("assistant-a", "assistant", "公式解释"),
    ] : [])]);
    return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      controller.enqueue(encode(startEvent()));
      controller.enqueue(encode({ type: "delta", text: "公式" }));
    } }));
  });
  await client.load();
  const sending = client.send("pdf-a", "解释公式");
  await until(() => client.getSnapshot().conversations[0]?.messages[1]?.body === "公式");
  await client.load(true);
  assert.equal(client.getSnapshot().conversations[0].messages[1].body, "公式");
  stream.enqueue(encode({ type: "delta", text: "解释" }));
  await until(() => client.getSnapshot().conversations[0]?.messages[1]?.body === "公式解释");
  finished = true;
  stream.enqueue(encode(doneEvent())); stream.close();
  await sending;
});

test("rename validation and failure leave saved conversations and message drafts intact", async () => {
  let patches = 0;
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return json([conversation()]);
    patches += 1;
    return Response.json({ error: "暂时无法保存名称" }, { status: 503 });
  });
  await client.load();
  client.setDraft("还在写的问题");
  assert.match(await client.renameConversation("conversation-a", "  "), /1–120/);
  assert.equal(patches, 0);
  assert.equal(await client.renameConversation("conversation-a", "输入的名称"), "暂时无法保存名称");
  assert.equal(client.getSnapshot().conversations[0].title, "问题");
  assert.equal(client.getSnapshot().draft, "还在写的问题");
});

test("model override applies to the next request while the running request keeps its original model", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const posts: Record<string, unknown>[] = [];
  const config = configuration();
  const client = new PaperChatClient("paper-a", async (_url, init) => {
    if (!init?.method) return Response.json({ conversations: [conversation()], configuration: config });
    posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  }, modelStorage());
  await client.load();
  assert.equal(client.setModelOverride(" model-one "), true);
  const first = client.send("pdf-a", "解释公式");
  await until(() => posts.length === 1);
  assert.equal(client.getSnapshot().running?.model, "model-one");
  client.setModelOverride("model-two");
  assert.equal(posts[0].model, "model-one");
  assert.equal(client.getSnapshot().running?.model, "model-one");
  stream.enqueue(encode(startEvent())); stream.enqueue(encode(doneEvent())); stream.close();
  await first;
  const second = client.send("pdf-a", "再解释一次");
  await until(() => posts.length === 2);
  assert.equal(posts[1].model, "model-two");
  stream.enqueue(encode(startEvent())); stream.enqueue(encode(doneEvent())); stream.close();
  await second;
  client.setModelOverride("");
  const third = client.send("pdf-a", "使用默认");
  await until(() => posts.length === 3);
  assert.equal(Object.hasOwn(posts[2], "model"), false);
  stream.enqueue(encode(startEvent())); stream.enqueue(encode(doneEvent())); stream.close();
  await third;
});

test("model preferences persist per paper and safe provider configuration, with explicit default reset", async () => {
  let config = configuration();
  const storage = modelStorage();
  const request: typeof fetch = async () => Response.json({ conversations: [], configuration: config });
  const first = new PaperChatClient("paper-a", request, storage);
  await first.load();
  first.setModelOverride("custom-a");
  const refreshed = new PaperChatClient("paper-a", request, storage);
  await refreshed.load();
  assert.equal(refreshed.getSnapshot().modelOverride, "custom-a");
  const otherPaper = new PaperChatClient("paper-b", request, storage);
  await otherPaper.load();
  assert.equal(otherPaper.getSnapshot().modelOverride, "");
  config = configuration({ provider: "ollama", preferenceKey: "config-b" });
  await refreshed.load(true);
  assert.equal(refreshed.getSnapshot().modelOverride, "");
  refreshed.setModelOverride("local-model");
  config = configuration();
  await refreshed.load(true);
  assert.equal(refreshed.getSnapshot().modelOverride, "custom-a");
  refreshed.setModelOverride("");
  const reset = new PaperChatClient("paper-a", request, storage);
  await reset.load();
  assert.equal(reset.getSnapshot().modelOverride, "");
});

test("blocked model preference storage does not break live selection or history loading", async () => {
  const client = new PaperChatClient("paper-a", async () => Response.json({ conversations: [], configuration: configuration() }), {
    getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); },
  });
  await client.load();
  assert.equal(client.getSnapshot().loaded, true);
  assert.equal(client.setModelOverride("manual-model"), true);
  assert.equal(client.getSnapshot().modelOverride, "manual-model");
  assert.match(client.getSnapshot().modelNotice, /无法保存偏好/);
  assert.equal(client.setModelOverride("line\nbreak"), false);
  assert.equal(client.getSnapshot().modelOverride, "manual-model");
});

test("model lists come from the current service and failures still allow a manually entered model", async () => {
  let status: "available" | "failed" | "other-provider" = "available";
  const client = new PaperChatClient("paper-a", async (url) => {
    if (!String(url).endsWith("/models")) return Response.json({ conversations: [], configuration: configuration() });
    if (status === "failed") return Response.json({ error: "模型服务未提供列表，可手动填写" }, { status: 502 });
    return Response.json({ provider: status === "other-provider" ? "ollama" : "openai-compatible",
      models: [{ id: "service-model", label: "Service model" }], warning: "" });
  });
  await client.load();
  await client.loadModelOptions();
  assert.deepEqual(client.getSnapshot().modelOptions, [{ id: "service-model", label: "Service model" }]);
  status = "failed";
  await client.loadModelOptions();
  assert.match(client.getSnapshot().modelOptionsWarning, /手动填写/);
  assert.equal(client.setModelOverride("manually-available-model"), true);
  status = "other-provider";
  await client.loadModelOptions();
  assert.match(client.getSnapshot().modelOptionsWarning, /配置已变化/);
  assert.equal(client.getSnapshot().modelOverride, "manually-available-model");
});
