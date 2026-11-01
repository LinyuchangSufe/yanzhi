import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getPaperChatActivities, getPaperChatClient, PaperChatClient, readChatEvents, subscribePaperChatActivities } from "../src/lib/paper-chat/client";
import type { ChatProgress } from "../src/lib/ai/chat-progress";
import type { ChatScope, ChatStreamEvent, PaperChatConversation, PaperChatMessage } from "../src/lib/paper-chat/types";

const startedAt = "2026-10-30T00:00:00.000Z";
const activityAt = "2026-10-30T00:00:05.000Z";
const heartbeatAt = "2026-10-30T00:00:45.000Z";
const finishedAt = "2026-10-30T00:00:50.000Z";
const progress = (overrides: Partial<ChatProgress> = {}): ChatProgress => ({
  startedAt, phase: "waiting", lastActivityAt: null, heartbeatAt: startedAt, processRunning: true, ...overrides,
});
const encode = (event: unknown) => new TextEncoder().encode(`${JSON.stringify(event)}\n`);
const history = (conversations: PaperChatConversation[] = []) => Response.json({ conversations });
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("chat progress state did not settle");
}
function fixture(paperId = "synthetic-progress-paper") {
  const scope: ChatScope = { attachmentId: "synthetic-pdf", attachmentSha256: "synthetic-sha", pageIndices: [0], totalPages: 1,
    characterCount: 20, truncated: false, historyMessages: 0, historyTruncated: false };
  const message = (status: PaperChatMessage["status"], body = "", savedProgress = progress()): PaperChatMessage => ({
    id: "synthetic-answer", conversationId: "synthetic-conversation", role: "assistant", status, body, progress: savedProgress,
    scope, provider: "synthetic", model: "test-double", error: "", createdAt: startedAt, updatedAt: status === "pending" ? startedAt : finishedAt,
  });
  const user: PaperChatMessage = { ...message("completed"), id: "synthetic-question", role: "user", body: "解释合成测试里的公式 🧠", scope: null };
  delete user.progress;
  const conversation = (messages: PaperChatMessage[] = []): PaperChatConversation => ({ id: "synthetic-conversation", paperId,
    attachmentId: scope.attachmentId, attachmentSha256: scope.attachmentSha256, title: "合成进度测试", createdAt: startedAt, updatedAt: finishedAt, messages });
  const start: ChatStreamEvent = { type: "start", conversationId: "synthetic-conversation", conversation: conversation(),
    userMessage: user, assistantMessage: message("pending"), scope };
  return { scope, message, user, conversation, start };
}
function pendingReply(client: PaperChatClient) {
  const message = client.getSnapshot().conversations[0]?.messages.find((item) => item.role === "assistant");
  assert.ok(message, "the pending reply must remain available even without text");
  return message;
}

test("progress and reply events decode across fragmented UTF-8, CRLF and an unterminated final record", async () => {
  const events: ChatStreamEvent[] = [fixture().start, { type: "delta", text: "公式 α 与脑图 🧠" },
    { type: "progress", progress: progress({ phase: "thinking", lastActivityAt: activityAt, heartbeatAt }) },
    { type: "delta", text: "继续回答。" }, { type: "progress", progress: progress({ heartbeatAt, processRunning: null }) }];
  const bytes = new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join("\r\n"));
  const received: ChatStreamEvent[] = [];
  await readChatEvents(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 2) controller.enqueue(bytes.slice(offset, offset + 2));
    controller.close();
  } }), (event) => received.push(event));
  assert.deepEqual(received, events);
});

test("invalid progress is rejected before it can reach a chat subscriber", async (context) => {
  const invalid: { label: string; value: unknown }[] = [
    { label: "missing progress", value: { type: "progress" } },
    { label: "unknown phase", value: { type: "progress", progress: { ...progress(), phase: "imagined-thinking" } } },
    { label: "invalid activity time", value: { type: "progress", progress: { ...progress(), lastActivityAt: "yesterday" } } },
    { label: "invalid heartbeat", value: { type: "progress", progress: { ...progress(), heartbeatAt: 123 } } },
    { label: "invalid process state", value: { type: "progress", progress: { ...progress(), processRunning: "alive" } } },
    { label: "unexpected reasoning payload", value: { type: "progress", progress: { ...progress(), reasoning: "must not enter progress state" } } },
  ];
  for (const item of invalid) await context.test(item.label, async () => {
    const received: ChatStreamEvent[] = [];
    await assert.rejects(readChatEvents(new ReadableStream({ start(controller) {
      controller.enqueue(encode({ type: "delta", text: "已经收到的正文" }));
      controller.enqueue(encode(item.value)); controller.close();
    } }), (event) => received.push(event)), /对话进度格式不正确/);
    assert.deepEqual(received, [{ type: "delta", text: "已经收到的正文" }]);
  });
});

test("pending progress survives navigation and stale history, then completion keeps actual activity distinct from heartbeat", async () => {
  const f = fixture();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const terminalProgress = progress({ phase: "responding", lastActivityAt: activityAt, heartbeatAt, processRunning: false });
  const completed = f.message("completed", "最终合成回复。", terminalProgress);
  let stored: PaperChatMessage = f.message("pending");
  const client = new PaperChatClient("synthetic-progress-paper", async (_url, init) => {
    if (!init?.method) return history([f.conversation([f.user, stored])]);
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  }, null);
  await client.load();
  const unsubscribe = client.subscribe(() => {});
  const sending = client.send(f.scope.attachmentId, f.user.body);
  await until(() => Boolean(stream)); stream.enqueue(encode(f.start));
  const thinking = progress({ phase: "thinking", lastActivityAt: activityAt, heartbeatAt: activityAt });
  stream.enqueue(encode({ type: "progress", progress: thinking }));
  await until(() => client.getSnapshot().running?.progress?.phase === "thinking");
  assert.equal(client.getSnapshot().running?.startedAt, startedAt);
  assert.equal(pendingReply(client).status, "pending"); assert.equal(pendingReply(client).body, "");
  assert.deepEqual(pendingReply(client).progress, thinking);
  unsubscribe(); client.select(null);
  const heartbeatOnly = { ...thinking, heartbeatAt };
  stream.enqueue(encode({ type: "progress", progress: heartbeatOnly }));
  await until(() => client.getSnapshot().running?.progress?.heartbeatAt === heartbeatAt);
  await client.load(true);
  assert.equal(client.getSnapshot().activeId, null);
  assert.deepEqual(pendingReply(client).progress, heartbeatOnly);
  assert.equal(pendingReply(client).progress?.lastActivityAt, activityAt);
  stored = completed;
  stream.enqueue(encode({ type: "done", conversationId: completed.conversationId, message: completed })); stream.close();
  await sending;
  assert.equal(client.getSnapshot().running, null);
  assert.equal(pendingReply(client).status, "completed"); assert.equal(pendingReply(client).updatedAt, finishedAt);
  assert.deepEqual(pendingReply(client).progress, terminalProgress);
  assert.notEqual(pendingReply(client).progress?.lastActivityAt, pendingReply(client).progress?.heartbeatAt);
});

test("background activity subscribers receive progress without any mounted chat listener", async () => {
  const paperId = `synthetic-background-progress-${randomUUID()}`;
  const f = fixture(paperId);
  const originalFetch = globalThis.fetch;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let stored = f.message("pending");
  let aborted = false;
  let sending: Promise<boolean> | undefined;
  const phases: string[] = [];
  const client = getPaperChatClient(paperId);
  client.paperTitle = "合成后台进度测试";
  const unsubscribeActivities = subscribePaperChatActivities(() => {
    const activity = getPaperChatActivities().find((item) => item.paperId === paperId);
    if (activity?.progress) phases.push(activity.progress.phase);
  });
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /^\/api\/kb\/chat(?:\?|$)/, "no other request may reach the network");
    if (!init?.method) return history([f.conversation([f.user, stored])]);
    return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      init.signal?.addEventListener("abort", () => { aborted = true; controller.error(new DOMException("Stopped", "AbortError")); }, { once: true });
    } }));
  };
  try {
    await client.load();
    const unsubscribeView = client.subscribe(() => {});
    sending = client.send(f.scope.attachmentId, f.user.body);
    await until(() => Boolean(stream)); stream.enqueue(encode(f.start));
    await until(() => Boolean(client.getSnapshot().running?.assistantId));
    unsubscribeView(); client.select(null);
    const waiting = progress({ heartbeatAt });
    stream.enqueue(encode({ type: "progress", progress: waiting }));
    await until(() => getPaperChatActivities().find((item) => item.paperId === paperId)?.progress?.heartbeatAt === heartbeatAt);
    const activity = getPaperChatActivities().find((item) => item.paperId === paperId);
    assert.ok(activity);
    assert.equal(activity?.paperTitle, "合成后台进度测试"); assert.equal(activity?.startedAt, startedAt);
    assert.deepEqual(activity?.progress, waiting);
    assert.equal(activity.progress?.lastActivityAt, null); assert.equal(aborted, false);
    const thinking = progress({ phase: "thinking", heartbeatAt, lastActivityAt: activityAt });
    stream.enqueue(encode({ type: "progress", progress: thinking }));
    await until(() => getPaperChatActivities().find((item) => item.paperId === paperId)?.progress?.phase === "thinking");
    assert.ok(phases.includes("waiting")); assert.ok(phases.includes("thinking"));
    stored = f.message("completed", "后台回复", { ...thinking, processRunning: false });
    stream.enqueue(encode({ type: "done", conversationId: stored.conversationId, message: stored })); stream.close();
    await sending;
    assert.equal(getPaperChatActivities().some((item) => item.paperId === paperId), false);
    assert.equal(pendingReply(client).status, "completed");
  } finally {
    try {
      if (client.getSnapshot().running) {
        stored = f.message("cancelled", "", progress({ heartbeatAt, processRunning: false }));
        client.stop();
      }
      await sending;
    } finally { unsubscribeActivities(); globalThis.fetch = originalFetch; }
  }
});

test("stopping before any reply text preserves a cancelled record and never invents model activity", async () => {
  const f = fixture();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let stopped = false;
  const terminalProgress = progress({ heartbeatAt: finishedAt, processRunning: false });
  const cancelled = f.message("cancelled", "", terminalProgress);
  const client = new PaperChatClient("synthetic-progress-paper", async (_url, init) => {
    if (!init?.method) return history(stopped ? [f.conversation([f.user, cancelled])] : []);
    return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      init.signal?.addEventListener("abort", () => { stopped = true; controller.error(new DOMException("Stopped", "AbortError")); }, { once: true });
    } }));
  }, null);
  await client.load();
  const sending = client.send(f.scope.attachmentId, f.user.body);
  await until(() => Boolean(stream)); stream.enqueue(encode(f.start));
  stream.enqueue(encode({ type: "progress", progress: progress({ heartbeatAt }) }));
  await until(() => client.getSnapshot().running?.progress?.heartbeatAt === heartbeatAt);
  client.stop();
  assert.equal(pendingReply(client).status, "cancelled"); assert.equal(pendingReply(client).body, "");
  assert.equal(pendingReply(client).progress?.lastActivityAt, null);
  assert.equal(client.getSnapshot().running?.stopping, true);
  await sending;
  assert.equal(client.getSnapshot().running, null); assert.equal(client.getSnapshot().error, "");
  assert.deepEqual(pendingReply(client), cancelled);
  assert.equal(pendingReply(client).progress?.lastActivityAt, null);
  assert.equal(pendingReply(client).progress?.startedAt, startedAt);
});

test("an error clears the active run while preserving the terminal provider activity and heartbeat timestamps", async () => {
  const f = fixture();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let terminal = false;
  const terminalProgress = progress({ phase: "retrying", lastActivityAt: activityAt, heartbeatAt, processRunning: false });
  const failed = { ...f.message("failed", "保留的部分回复", terminalProgress), error: "合成服务连接失败" };
  const client = new PaperChatClient("synthetic-progress-paper", async (_url, init) => {
    if (!init?.method) return history(terminal ? [f.conversation([f.user, failed])] : []);
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  }, null);
  await client.load();
  const sending = client.send(f.scope.attachmentId, f.user.body);
  await until(() => Boolean(stream)); stream.enqueue(encode(f.start));
  stream.enqueue(encode({ type: "delta", text: "保留的部分回复" }));
  stream.enqueue(encode({ type: "progress", progress: { ...terminalProgress, processRunning: true } }));
  await until(() => client.getSnapshot().running?.progress?.heartbeatAt === heartbeatAt);
  assert.equal(pendingReply(client).body, "保留的部分回复");
  terminal = true;
  stream.enqueue(encode({ type: "error", status: 502, message: failed.error, conversationId: failed.conversationId, messageRecord: failed })); stream.close();
  await sending;
  assert.equal(client.getSnapshot().running, null); assert.equal(client.getSnapshot().error, failed.error);
  assert.deepEqual(pendingReply(client), failed);
  assert.equal(pendingReply(client).progress?.lastActivityAt, activityAt);
  assert.equal(pendingReply(client).progress?.heartbeatAt, heartbeatAt);
  assert.equal(pendingReply(client).updatedAt, finishedAt);
});
