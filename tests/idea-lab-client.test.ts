import assert from "node:assert/strict";
import test from "node:test";
import { IdeaDiscussionClient, ideaCompletedTurns, ideaDiscussionIsLong, ideaDiscussionSources } from "../src/components/ideas/idea-client";
import { ideaMaterials, materialAdditionError, selectIdeaMaterial, type SelectedIdeaMaterial } from "../src/components/ideas/idea-materials";
import { originalTextOffset } from "../src/components/chat-context-selection";
import type { IdeaConversation, IdeaMessage, IdeaSourceSnapshot, IdeaSummary } from "../src/lib/idea-lab/types";
import type { KBState, Paper } from "../src/lib/types";
import type { ChatProgress } from "../src/lib/ai/chat-progress";
import type { PaperChatConfiguration } from "../src/lib/paper-chat/types";

const time = "2026-10-30T00:00:00.000Z";
const source: IdeaSourceSnapshot = { id: "note:source:body:0:4:r2", type: "note", entityId: "source", field: "body",
  revision: 2, title: "合成资料", text: "测试资料", sourceHref: "kb://note/source", start: 0, end: 4 };
const material: SelectedIdeaMaterial = { key: "note:source:body:full:full", input: { type: "note", id: "source", field: "body", revision: 2 },
  title: source.title, text: source.text, label: "已有想法", sourceHref: source.sourceHref, related: false };
function message(id: string, role: IdeaMessage["role"], body: string, status: IdeaMessage["status"] = "completed"): IdeaMessage {
  return { id, conversationId: "discussion", requestId: "synthetic-request", role, body, status, sources: [source],
    provider: "synthetic", model: "test-double", error: "", createdAt: time, updatedAt: time };
}
const question = message("question", "user", "测试提问");
const pending = message("answer", "assistant", "", "pending");
const answer = { ...pending, body: "测试答复", status: "completed" as const };
const conversation: IdeaConversation = { id: "discussion", noteId: "idea", title: "合成讨论", createdAt: time, updatedAt: time, messages: [question, answer] };
const summary: IdeaSummary = { id: "summary", requestId: "synthetic-summary", noteId: "idea", conversationId: "discussion", title: "合成整理",
  sections: [{ id: "section", title: "下一步", body: "验证软件行为。", sourceIds: [source.id] }], messageIds: [answer.id], messages: [answer],
  sources: [source], baseRevision: 3, provider: "synthetic", model: "test-double", createdAt: time, applications: [] };
const encode = (event: unknown) => new TextEncoder().encode(`${JSON.stringify(event)}\n`);
const start = { type: "start", conversationId: "discussion", conversation: { ...conversation, messages: [question, pending] },
  userMessage: question, assistantMessage: pending, usage: { historyMessages: 0, historyCharacters: 0, sourceCount: 1, sourceCharacters: 4 } };
const done = { type: "done", conversationId: "discussion", message: answer };
const history = (conversations: IdeaConversation[] = []) => Response.json({ conversations, summaries: [], configuration: {
  provider: "none", model: "", configured: false, remote: false, credentialConfigured: false, environmentOverride: false, message: "test", preferenceKey: "test",
} });
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.fail("controller state did not settle");
}
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null, removeItem: (key) => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); } };
}

test("a turn survives removing its view subscription and keeps the sources actually sent", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let posted: Record<string, unknown> = {};
  const client = new IdeaDiscussionClient("idea", async (_url, init) => {
    if (!init?.method) return history();
    posted = JSON.parse(String(init.body));
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  }, memoryStorage());
  await client.load(); client.setDraft("测试提问"); client.addMaterial(material);
  const unsubscribe = client.subscribe(() => {});
  const request = client.send(async () => 3);
  await until(() => Boolean(stream));
  unsubscribe(); stream.enqueue(encode(start)); stream.enqueue(encode({ type: "delta", text: "测试" }));
  await until(() => client.getSnapshot().conversations[0]?.messages[1]?.body === "测试");
  assert.equal(client.getSnapshot().running, true);
  assert.equal(client.getSnapshot().draft, "");
  assert.deepEqual(posted.sources, [material.input]);
  assert.equal(posted.includeCurrentNote, false);
  assert.equal(posted.revision, 3);
  stream.enqueue(encode(done)); stream.close(); await request;
  assert.equal(client.getSnapshot().running, false);
  assert.deepEqual(client.getSnapshot().conversations[0].messages[1].sources, [source]);
});

test("double send is ignored and edits made while saving are not cleared by the earlier turn", async () => {
  let release!: (revision: number) => void;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let posts = 0;
  const client = new IdeaDiscussionClient("idea", async () => {
    posts++; return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  }, memoryStorage());
  client.setDraft("测试提问"); client.addMaterial(material);
  const request = client.send(() => new Promise((resolve) => { release = resolve; }));
  await client.send(async () => assert.fail("second send must not prepare"));
  client.setDraft("下一条尚未发送的想法"); client.removeMaterial(material.key);
  release(4); await until(() => Boolean(stream));
  stream.enqueue(encode(start)); stream.enqueue(encode(done)); stream.close(); await request;
  assert.equal(posts, 1);
  assert.equal(client.getSnapshot().draft, "下一条尚未发送的想法");
  assert.deepEqual(client.getSnapshot().materials, []);
});

test("a failed started turn restores its input, retains partial output and retries with a fresh request id", async () => {
  const posts: Record<string, unknown>[] = [];
  const client = new IdeaDiscussionClient("idea", async (_url, init) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encode(start));
      if (posts.length === 1) controller.enqueue(encode({ type: "delta", text: "保留的部分回复" }));
      else controller.enqueue(encode(done));
      controller.close();
    } }));
  }, memoryStorage());
  client.setDraft("测试提问"); client.addMaterial(material);
  await client.send(async () => 3);
  assert.equal(client.getSnapshot().draft, "测试提问");
  assert.deepEqual(client.getSnapshot().materials, [material]);
  assert.equal(client.getSnapshot().conversations[0].messages[1].body, "保留的部分回复");
  assert.equal(client.getSnapshot().conversations[0].messages[1].status, "failed");
  assert.match(client.getSnapshot().error, /连接中断，已收到的部分正文保留/);
  assert.match(client.getSnapshot().conversations[0].messages[1].error, /已收到的部分正文保留/);
  client.setDraft("独立的新草稿"); client.removeMaterial(material.key);
  await client.send(async () => 3, true);
  assert.equal(posts[1].message, "测试提问");
  assert.deepEqual(posts[1].sources, [material.input]);
  assert.notEqual(posts[0].requestId, posts[1].requestId);
  assert.equal(client.getSnapshot().draft, "独立的新草稿");
  assert.equal(client.getSnapshot().failed, null);
});

test("stopping a partial response retains cancelled text and does not abort on unsubscription", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const client = new IdeaDiscussionClient("idea", async (_url, init) => new Response(new ReadableStream({
    start(controller) { stream = controller; init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Stopped", "AbortError")), { once: true }); },
  })), memoryStorage());
  client.setDraft("测试提问");
  const request = client.send(async () => 1);
  await until(() => Boolean(stream)); stream.enqueue(encode(start)); stream.enqueue(encode({ type: "delta", text: "停止后保留" }));
  await until(() => client.getSnapshot().conversations[0]?.messages[1].body === "停止后保留");
  client.stop(); await request;
  assert.equal(client.getSnapshot().running, false);
  assert.equal(client.getSnapshot().conversations[0].messages[1].status, "cancelled");
  assert.equal(client.getSnapshot().conversations[0].messages[1].body, "停止后保留");
  assert.match(client.getSnapshot().error, /讨论已停止，已收到的部分正文保留/);
  assert.match(client.getSnapshot().conversations[0].messages[1].error, /已收到的部分正文保留/);
  assert.equal(client.getSnapshot().draft, "测试提问");
});

test("stopping without reply text says no body arrived and preserves an independently edited next draft", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const client = new IdeaDiscussionClient("idea", async (_url, init) => new Response(new ReadableStream({ start(controller) {
    stream = controller; init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Stopped", "AbortError")), { once: true });
  } })), memoryStorage());
  client.setDraft("原提问"); const request = client.send(async () => 1);
  await until(() => Boolean(stream)); stream.enqueue(encode(start));
  await until(() => client.getSnapshot().conversations[0]?.messages[1]?.status === "pending");
  client.setDraft("停止前写下的独立新草稿"); client.stop(); await request;
  assert.match(client.getSnapshot().error, /讨论已停止，本次尚未收到正文，提问和笔记保留/);
  assert.match(client.getSnapshot().conversations[0].messages[1].error, /本次尚未收到正文，提问和笔记保留/);
  assert.doesNotMatch(client.getSnapshot().error, /部分正文保留/);
  assert.equal(client.getSnapshot().conversations[0].messages[1].status, "cancelled");
  assert.equal(client.getSnapshot().draft, "停止前写下的独立新草稿");
});

test("a stream ending before reply text clearly preserves the question without claiming partial body", async () => {
  const client = new IdeaDiscussionClient("idea", async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encode(start)); controller.close();
  } })), memoryStorage());
  client.setDraft("断流时保留的原提问"); await client.send(async () => 1);
  assert.match(client.getSnapshot().error, /连接中断，本次尚未收到正文，提问和笔记保留/);
  assert.doesNotMatch(client.getSnapshot().error, /部分正文保留/);
  assert.equal(client.getSnapshot().conversations[0].messages[1].status, "failed");
  assert.equal(client.getSnapshot().draft, "断流时保留的原提问");
});

test("save and configuration failures preserve the composer and expose a retryable original intent", async () => {
  let posts = 0;
  const client = new IdeaDiscussionClient("idea", async () => { posts++; return Response.json({ error: "AI 尚未配置" }, { status: 409 }); }, memoryStorage());
  client.setDraft("测试提问"); client.addMaterial(material); client.setIncludeNote(true);
  await client.send(async () => { throw new Error("笔记尚未保存"); });
  assert.equal(posts, 0); assert.match(client.getSnapshot().error, /尚未保存/);
  await client.send(async () => 2, true);
  assert.equal(posts, 1); assert.match(client.getSnapshot().error, /尚未配置/);
  assert.equal(client.getSnapshot().draft, "测试提问");
  assert.equal(client.getSnapshot().includeCurrentNote, true);
  assert.deepEqual(client.getSnapshot().materials, [material]);
});

test("per-note composer storage restores only that note and keeps an explicitly new discussion on refresh", async () => {
  const storage = memoryStorage();
  const first = new IdeaDiscussionClient("idea", async () => history([conversation]), storage);
  await first.load(); first.setDraft("未发送内容"); first.addMaterial(material); first.setIncludeNote(true);
  first.chooseConversation(""); await first.load(true);
  assert.equal(first.getSnapshot().activeId, "");
  const restored = new IdeaDiscussionClient("idea", async () => history([conversation]), storage);
  await restored.load();
  assert.equal(restored.getSnapshot().activeId, "");
  assert.equal(restored.getSnapshot().draft, "未发送内容");
  assert.deepEqual(restored.getSnapshot().materials, [material]);
  assert.equal(restored.getSnapshot().includeCurrentNote, true);
  const other = new IdeaDiscussionClient("other", async () => history(), storage); await other.load();
  assert.equal(other.getSnapshot().draft, "");
});

test("summary generation sends only marked messages and keeps an independent draft without mutating history", async () => {
  let posted: Record<string, unknown> = {};
  const client = new IdeaDiscussionClient("idea", async (_url, init) => {
    if (!init?.method) return history([conversation]);
    posted = JSON.parse(String(init.body)); return Response.json({ summary });
  }, memoryStorage());
  await client.load(); client.setDraft("整理期间未发送的念头"); client.addMaterial(material);
  assert.deepEqual(await client.summarize([answer.id], async () => 3), summary);
  assert.equal(posted.action, "summarize"); assert.deepEqual(posted.messageIds, [answer.id]);
  assert.equal(posted.revision, 3); assert.equal("sources" in posted, false);
  assert.deepEqual(client.getSnapshot().conversations, [conversation]);
  assert.equal(client.getSnapshot().draft, "整理期间未发送的念头");
  assert.deepEqual(client.getSnapshot().summaries, [summary]);
});

test("material selection keeps UTF-16 and CRLF ranges and enforces explicit source limits", () => {
  const text = "标题\r\n🧠 $x^2$\r\n结尾";
  const displayed = text.replace(/\r\n?/g, "\n"); const start = displayed.indexOf("🧠");
  const selected = selectIdeaMaterial({ ...material, text }, originalTextOffset(text, start), originalTextOffset(text, start + 8));
  assert.equal(selected.text, text.slice(selected.input.start, selected.input.end));
  assert.equal(selected.input.start, text.indexOf("🧠"));
  assert.equal(materialAdditionError([], { ...material, text: "" }).length > 0, true);
  assert.match(materialAdditionError([material], material), /已在本轮/);
  assert.match(materialAdditionError([], { ...material, text: "x".repeat(16001) }), /16,000/);
  assert.match(materialAdditionError([{ ...material, text: "x".repeat(15000) }], { ...material, key: "different", text: "x".repeat(10000) }), /24,000/);
});

test("material candidates exclude recycled sources and distinguish topic description from its saved note revision", () => {
  const paper = (id: string, deletedAt: string | null): Paper => ({ id, deletedAt, title: id, abstract: "摘要", authors: [], year: null, sourceUrl: "", doi: "", arxivId: "",
    arxivVersion: null, readingStatus: "unread", revision: 1, createdAt: time, updatedAt: time });
  const state: KBState = { papers: [paper("active", null), paper("trashed", time)], attachments: [], annotations: [],
    notes: [{ id: "idea", title: "当前", body: "当前正文", purpose: "idea", revision: 1, createdAt: time, updatedAt: time },
      { id: "topic-note", title: "综合笔记", body: "原有研究笔记", purpose: "topic", revision: 7, createdAt: time, updatedAt: time },
      { id: "trashed-note", title: "回收论文笔记", body: "不应加入", purpose: "paper", revision: 1, createdAt: time, updatedAt: time }],
    topics: [{ id: "topic", title: "问题", description: "问题描述", noteId: "topic-note", revision: 4, createdAt: time, updatedAt: time }],
    relations: [{ id: "relation", fromType: "paper", fromId: "trashed", toType: "note", toId: "trashed-note", purpose: "manual", createdAt: time }],
    aiContents: [], tags: [], readingPositions: [], settings: { aiProvider: "none", codexModel: "", ollamaUrl: "", ollamaModel: "", openaiUrl: "", openaiModel: "", appearance: "light", splitRatio: .5 } };
  const candidates = ideaMaterials(state, "idea");
  assert.equal(candidates.some((item) => item.input.id === "trashed" || item.input.id === "trashed-note" || item.input.id === "idea"), false);
  assert.equal(candidates.find((item) => item.input.type === "topic" && item.input.field === "body")?.input.revision, 7);
  assert.equal(candidates.find((item) => item.input.type === "topic" && item.input.field === "description")?.input.revision, 4);
});

test("default phase selection and persistent references include only complete successful turns", () => {
  const failedUser = { ...question, id: "failed-user", requestId: "failed", sources: [{ ...source, id: "failed-source" }] };
  const failedReply = { ...answer, id: "failed-reply", requestId: "failed", status: "failed" as const };
  const pendingUser = { ...question, id: "pending-user", requestId: "pending" };
  const pendingReply = { ...pending, id: "pending-reply", requestId: "pending" };
  const messages = [failedUser, failedReply, question, answer, pendingUser, pendingReply];
  assert.deepEqual(ideaCompletedTurns(messages), [question, answer]);
  assert.deepEqual(ideaDiscussionSources(messages), [source]);
  assert.equal(ideaDiscussionIsLong(messages), false);
  const long = Array.from({ length: 20 }, (_, index) => [{ ...question, id: `q${index}`, requestId: `r${index}` }, { ...answer, id: `a${index}`, requestId: `r${index}` }]).flat();
  assert.equal(ideaDiscussionIsLong(long), true);
});

test("current note is attached once, then its saved snapshot remains visible without resending", async () => {
  const posts: Record<string, unknown>[] = [];
  const client = new IdeaDiscussionClient("idea", async (_url, init) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(encode(start)); controller.enqueue(encode(done)); controller.close(); } }));
  }, memoryStorage());
  client.setDraft("第一次引用工作笔记"); client.setIncludeNote(true);
  await client.send(async () => 3);
  assert.equal(posts[0].includeCurrentNote, true);
  assert.equal(client.getSnapshot().includeCurrentNote, false);
  assert.deepEqual(ideaDiscussionSources(client.getSnapshot().conversations[0].messages), [source]);
  client.setDraft("不重选资料，继续讨论"); await client.send(async () => 3);
  assert.equal(posts[1].includeCurrentNote, false);
  assert.deepEqual(posts[1].sources, []);
});

test("stage handoff is a protected draft, preserves the follow-up and pending materials, and never auto-calls AI", async () => {
  const storage = memoryStorage(); let posts = 0;
  const bootstrap = () => Response.json({ conversations: [conversation], summaries: [summary], configuration: {} });
  const client = new IdeaDiscussionClient("idea", async (_url, init) => {
    if (!init?.method) return bootstrap();
    posts++; return Response.json({ error: "合成失败" }, { status: 503 });
  }, storage);
  await client.load(); client.setDraft("需要保留的后续问题"); client.addMaterial(material);
  await client.send(async () => 3);
  assert.ok(client.getSnapshot().failed);
  assert.equal(client.startFromSummary(summary), true);
  assert.equal(posts, 1);
  assert.equal(client.getSnapshot().activeId, "");
  assert.equal(client.getSnapshot().failed, null);
  assert.match(client.getSnapshot().draft, /AI 辅助整理/);
  assert.match(client.getSnapshot().draft, /不代表重新读取原文/);
  assert.ok(client.getSnapshot().draft.includes(source.sourceHref));
  assert.ok(client.getSnapshot().draft.includes("需要保留的后续问题"));
  assert.deepEqual(client.getSnapshot().materials, [material]);
  assert.deepEqual(client.getSnapshot().conversations, [conversation]);
  const reloaded = new IdeaDiscussionClient("idea", async () => bootstrap(), storage);
  await reloaded.load();
  assert.equal(reloaded.getSnapshot().activeId, "");
  assert.equal(reloaded.getSnapshot().draft, client.getSnapshot().draft);
  assert.deepEqual(reloaded.getSnapshot().materials, [material]);
});

test("an oversized or foreign handoff never truncates the draft or changes its discussion", async () => {
  const large = { ...summary, sections: [{ ...summary.sections[0], body: "x".repeat(12001) }] };
  const client = new IdeaDiscussionClient("idea", async () => Response.json({ conversations: [conversation], summaries: [large], configuration: {} }), memoryStorage());
  await client.load(); client.setDraft("独立草稿");
  assert.equal(client.startFromSummary(large), false);
  assert.equal(client.getSnapshot().draft, "独立草稿");
  assert.equal(client.getSnapshot().activeId, conversation.id);
  assert.match(client.getSnapshot().error, /12,000/);
  assert.equal(client.startFromSummary({ ...summary, noteId: "foreign" }), false);
  assert.equal(client.getSnapshot().draft, "独立草稿");
});

test("phase selection over 100 messages refuses clearly before saving or calling a model", async () => {
  let posts = 0;
  const client = new IdeaDiscussionClient("idea", async (_url, init) => { if (init?.method) posts++; return history([conversation]); }, memoryStorage());
  await client.load();
  const result = await client.summarize(Array.from({ length: 101 }, (_, index) => `message-${index}`), async () => assert.fail("must not prepare an oversized selection"));
  assert.equal(result, null); assert.equal(posts, 0);
  assert.match(client.getSnapshot().error, /最多 100/);
  assert.deepEqual(client.getSnapshot().conversations, [conversation]);
});

test("typing the next question during save consumes only sent references and the one-time note toggle", async () => {
  let release!: (revision: number) => void;
  const posts: Record<string, unknown>[] = [];
  const client = new IdeaDiscussionClient("idea", async (_url, init) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(encode(start)); controller.enqueue(encode(done)); controller.close(); } }));
  }, memoryStorage());
  client.setDraft("首轮提问"); client.addMaterial(material); client.setIncludeNote(true);
  const first = client.send(() => new Promise((resolve) => { release = resolve; }));
  const next = { ...material, key: "next-material", input: { ...material.input, id: "next-source" } };
  client.setDraft("保存期间写下的下一轮问题"); client.addMaterial(next);
  release(3); await first;
  assert.equal(client.getSnapshot().draft, "保存期间写下的下一轮问题");
  assert.equal(client.getSnapshot().includeCurrentNote, false);
  assert.deepEqual(client.getSnapshot().materials, [next]);
  await client.send(async () => 3);
  assert.deepEqual(posts.map((post) => post.includeCurrentNote), [true, false]);
  assert.deepEqual(posts[1].sources, [next.input]);
});

test("explicitly reselecting a source or note while a request prepares preserves that new choice", async () => {
  let release!: (revision: number) => void;
  const client = new IdeaDiscussionClient("idea", async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encode(start)); controller.enqueue(encode(done)); controller.close();
  } })), memoryStorage());
  client.setDraft("首轮提问"); client.addMaterial(material); client.setIncludeNote(true);
  const first = client.send(() => new Promise((resolve) => { release = resolve; }));
  client.removeMaterial(material.key); client.addMaterial(material);
  client.setIncludeNote(false); client.setIncludeNote(true);
  release(3); await first;
  assert.deepEqual(client.getSnapshot().materials, [material]);
  assert.equal(client.getSnapshot().includeCurrentNote, true);
});

const modelConfiguration = (overrides: Partial<PaperChatConfiguration> = {}): PaperChatConfiguration => ({
  provider: "openai-compatible", model: "global-model", configured: true, remote: true, credentialConfigured: true,
  environmentOverride: false, message: "合成配置", preferenceKey: "provider-a", ...overrides,
});
const configuredHistory = (configuration: PaperChatConfiguration, conversations: IdeaConversation[] = []) => Response.json({ conversations, summaries: [], configuration });

test("model history refresh after stopping keeps the retry notice and retry still uses its original model", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let persisted: IdeaConversation[] = [];
  const posts: Record<string, unknown>[] = [];
  const client = new IdeaDiscussionClient("idea", async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ provider: "openai-compatible", models: [{ id: "model-b", label: "下一轮模型" }] });
    if (!init?.method) return configuredHistory(modelConfiguration(), persisted);
    posts.push(JSON.parse(String(init.body)));
    return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      if (posts.length > 1) { controller.enqueue(encode(start)); controller.enqueue(encode(done)); controller.close(); return; }
      init.signal?.addEventListener("abort", () => {
        persisted = [{ ...conversation, messages: [question, { ...pending, status: "cancelled", error: "后端保留的停止记录" }] }];
        controller.error(new DOMException("Stopped", "AbortError"));
      }, { once: true });
    } }));
  }, memoryStorage(), memoryStorage());
  await client.load(); client.setModelOverride("model-a"); client.setDraft("需要重试的原提问");
  const request = client.send(async () => 1);
  await until(() => Boolean(stream)); stream.enqueue(encode(start));
  await until(() => client.getSnapshot().conversations[0]?.messages[1]?.status === "pending");
  client.stop(); await request;
  const notice = client.getSnapshot().error; assert.match(notice, /本次尚未收到正文/);
  await client.load(true); await client.loadModelOptions(); client.setModelOverride("model-b");
  assert.equal(posts.length, 1, "opening model settings must not issue another AI request");
  assert.equal(client.getSnapshot().error, notice); assert.equal(client.getSnapshot().failed?.model, "model-a");
  client.setDraft("模型设置期间写下的下一轮草稿"); await client.send(async () => 1, true);
  assert.equal(posts[1].model, "model-a"); assert.equal(posts[1].message, "需要重试的原提问");
  assert.equal(client.getSnapshot().modelOverride, "model-b"); assert.equal(client.getSnapshot().draft, "模型设置期间写下的下一轮草稿");
});

test("idea model preference belongs to this note and provider, without loading a catalog or changing global settings", async () => {
  const storage = memoryStorage(); let config = modelConfiguration(); let calls = 0;
  const transport: typeof fetch = async () => { calls++; return configuredHistory(config); };
  const client = new IdeaDiscussionClient("idea", transport, null, storage);
  await client.load(); assert.equal(calls, 1); assert.deepEqual(client.getSnapshot().modelOptions, []);
  assert.equal(client.setModelOverride(" custom-a "), true);
  assert.equal(client.getSnapshot().configuration?.model, "global-model");
  const restored = new IdeaDiscussionClient("idea", transport, null, storage); await restored.load();
  assert.equal(restored.getSnapshot().modelOverride, "custom-a");
  const other = new IdeaDiscussionClient("other", transport, null, storage); await other.load();
  assert.equal(other.getSnapshot().modelOverride, "");
  config = modelConfiguration({ provider: "ollama", preferenceKey: "provider-b" }); await restored.load(true);
  assert.equal(restored.getSnapshot().modelOverride, ""); restored.setModelOverride("local-b");
  config = modelConfiguration(); await restored.load(true); assert.equal(restored.getSnapshot().modelOverride, "custom-a");
  assert.equal(restored.setModelOverride("invalid\nmodel"), false);
  assert.equal(restored.getSnapshot().modelOverride, "custom-a");
  restored.setModelOverride("");
  const reset = new IdeaDiscussionClient("idea", transport, null, storage); await reset.load(); assert.equal(reset.getSnapshot().modelOverride, "");
});

test("model catalog is requested explicitly and keeps manual selection usable after failure or provider changes", async () => {
  let config = modelConfiguration(), fail = false;
  let resolveCatalog!: (response: Response) => void;
  const client = new IdeaDiscussionClient("idea", async (url) => {
    if (!String(url).endsWith("/models")) return configuredHistory(config);
    if (fail) return Response.json({ error: "目录暂不可用，可手动填写" }, { status: 502 });
    return new Promise((resolve) => { resolveCatalog = resolve; });
  }, null, memoryStorage());
  await client.load();
  const first = client.loadModelOptions(); await until(() => Boolean(resolveCatalog));
  resolveCatalog(Response.json({ provider: "openai-compatible", models: [{ id: "catalog-a", label: "目录模型" }, { id: "catalog-a", label: "重复" }, { id: "bad\nmodel", label: "非法" }] }));
  await first; assert.deepEqual(client.getSnapshot().modelOptions, [{ id: "catalog-a", label: "目录模型" }]);
  fail = true; await client.loadModelOptions(); assert.match(client.getSnapshot().modelOptionsWarning, /手动填写/);
  assert.equal(client.setModelOverride("manual-model"), true);
  fail = false; resolveCatalog = undefined as unknown as typeof resolveCatalog;
  const stale = client.loadModelOptions(); await until(() => Boolean(resolveCatalog));
  config = modelConfiguration({ provider: "ollama", preferenceKey: "provider-b" }); await client.load(true);
  resolveCatalog(Response.json({ provider: "openai-compatible", models: [{ id: "stale", label: "旧目录" }] })); await stale;
  assert.deepEqual(client.getSnapshot().modelOptions, []); assert.equal(client.getSnapshot().modelOptionsLoading, false);
});

test("send freezes its chosen model before saving and retries the original model without consuming later edits", async () => {
  let release!: (revision: number) => void;
  const posts: Record<string, unknown>[] = [];
  const client = new IdeaDiscussionClient("idea", async (_url, init) => {
    if (!init?.method) return configuredHistory(modelConfiguration());
    posts.push(JSON.parse(String(init.body)));
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encode({ ...start, assistantMessage: { ...pending, model: "model-a" } }));
      if (posts.length === 1) controller.enqueue(encode({ type: "delta", text: "保留的部分" }));
      else controller.enqueue(encode(done)); controller.close();
    } }));
  }, memoryStorage(), memoryStorage());
  await client.load(); client.setModelOverride("model-a"); client.setDraft("首轮提问"); client.addMaterial(material); client.setIncludeNote(true);
  const send = client.send(() => new Promise((resolve) => { release = resolve; }));
  assert.equal(client.getSnapshot().runModel, "model-a"); client.setModelOverride("model-b");
  release(3); await send;
  assert.equal(posts[0].model, "model-a"); assert.equal(client.getSnapshot().failed?.model, "model-a");
  client.setDraft("独立新草稿"); client.removeMaterial(material.key);
  await client.send(async () => 3, true);
  assert.equal(posts[1].model, "model-a"); assert.equal(client.getSnapshot().modelOverride, "model-b");
  assert.equal(client.getSnapshot().draft, "独立新草稿"); assert.equal(client.getSnapshot().progress, null);
});

test("retry after a provider configuration change stops before sending the old model to another service", async () => {
  let config = modelConfiguration(); let posts = 0;
  const client = new IdeaDiscussionClient("idea", async (_url, init) => {
    if (!init?.method) return configuredHistory(config);
    posts++; return Response.json({ error: "合成失败" }, { status: 503 });
  }, memoryStorage(), memoryStorage());
  await client.load(); client.setModelOverride("original-model"); client.setDraft("测试原提问"); await client.send(async () => 1);
  config = modelConfiguration({ provider: "ollama", preferenceKey: "provider-b" }); await client.load(true);
  await client.send(async () => assert.fail("must not prepare after provider changed"), true);
  assert.equal(posts, 1); assert.match(client.getSnapshot().error, /服务配置已变化/);
  assert.equal(client.getSnapshot().failed?.model, "original-model"); assert.equal(client.getSnapshot().draft, "测试原提问");
});

test("summary freezes the model at invocation and uses a local wait timer without inventing provider activity", async () => {
  let release!: (revision: number) => void; let posted: Record<string, unknown> = {};
  const client = new IdeaDiscussionClient("idea", async (_url, init) => {
    if (!init?.method) return configuredHistory(modelConfiguration(), [conversation]);
    posted = JSON.parse(String(init.body)); return Response.json({ summary });
  }, memoryStorage(), memoryStorage());
  await client.load(); client.setModelOverride("summary-a");
  const request = client.summarize([answer.id], () => new Promise((resolve) => { release = resolve; }));
  assert.ok(client.getSnapshot().runStartedAt); assert.equal(client.getSnapshot().progress, null);
  assert.equal(client.getSnapshot().runModel, "summary-a"); client.setModelOverride("summary-b"); release(3); await request;
  assert.equal(posted.model, "summary-a"); assert.equal(client.getSnapshot().modelOverride, "summary-b");
  assert.equal(client.getSnapshot().summarizing, false); assert.equal(client.getSnapshot().progress, null); assert.ok(client.getSnapshot().runFinishedAt);
});

test("server heartbeats preserve real activity separately, never add reasoning text, and clear dynamic progress on completion", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const client = new IdeaDiscussionClient("idea", async () => new Response(new ReadableStream({ start(controller) { stream = controller; } })), memoryStorage());
  client.setDraft("观察进度的合成提问"); const request = client.send(async () => 1);
  await until(() => Boolean(stream)); stream.enqueue(encode(start));
  const progress: ChatProgress = { startedAt: time, phase: "waiting", lastActivityAt: null, heartbeatAt: "2026-10-30T00:05:00.000Z", processRunning: true };
  stream.enqueue(encode({ type: "progress", progress })); await until(() => client.getSnapshot().progress?.heartbeatAt === progress.heartbeatAt);
  assert.equal(client.getSnapshot().progress?.phase, "waiting"); assert.equal(client.getSnapshot().progress?.lastActivityAt, null);
  assert.equal(client.getSnapshot().conversations[0].messages[1].body, ""); assert.equal(client.getSnapshot().running, true);
  const heartbeat = { ...progress, heartbeatAt: "2026-10-30T00:06:00.000Z" };
  stream.enqueue(encode({ type: "progress", progress: heartbeat })); await until(() => client.getSnapshot().progress?.heartbeatAt === heartbeat.heartbeatAt);
  assert.equal(client.getSnapshot().conversations[0].messages[1].progress?.lastActivityAt, null);
  stream.enqueue(encode(done)); stream.close(); await request;
  assert.equal(client.getSnapshot().progress, null); assert.equal(client.getSnapshot().runFinishedAt, answer.updatedAt);
  assert.equal(client.getSnapshot().running, false);
});

test("malformed progress fails safely with its original input and partial body retained", async () => {
  const client = new IdeaDiscussionClient("idea", async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encode(start)); controller.enqueue(encode({ type: "delta", text: "已接收正文" }));
    controller.enqueue(encode({ type: "progress", progress: { phase: "raw-cli-log" } })); controller.close();
  } })), memoryStorage());
  client.setDraft("合成提问"); await client.send(async () => 1);
  assert.match(client.getSnapshot().error, /运行进度格式异常/); assert.equal(client.getSnapshot().progress, null);
  assert.equal(client.getSnapshot().conversations[0].messages[1].body, "已接收正文"); assert.equal(client.getSnapshot().draft, "合成提问");
});
