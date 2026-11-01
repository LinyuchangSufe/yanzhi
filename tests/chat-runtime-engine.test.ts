import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStore, KBStore } from "../src/lib/db";
import { runIdeaChat, summarizeIdea, type IdeaChatStreamEvent } from "../src/lib/idea-lab/engine";
import { beginIdeaTurn, expireIdeaLeases, ideaConversationSnapshot } from "../src/lib/idea-lab/store";
import { runPaperChat } from "../src/lib/paper-chat/engine";
import { expirePaperChatLeases, paperChatSnapshot } from "../src/lib/paper-chat/store";
import type { ChatStreamEvent } from "../src/lib/paper-chat/types";
import type { Note, Paper } from "../src/lib/types";

async function fixture(run: (data: { store: KBStore; dir: string; idea: Note; paper: Paper; attachmentId: string }) => Promise<void>) {
  const previous = { ...process.env }, originalFetch = globalThis.fetch;
  const dir = mkdtempSync(path.join(os.tmpdir(), "kb-chat-runtime-engine-"));
  process.env.KB_DATA_DIR = dir; process.env.KB_AI_PROVIDER = "ollama";
  process.env.KB_OLLAMA_URL = "http://127.0.0.1:11434"; process.env.KB_OLLAMA_MODEL = "fixture-default-model";
  delete process.env.KB_CHAT_TIMEOUT_MS;
  const store = getStore();
  try {
    const idea = store.dispatch("note.create", { purpose: "idea", title: "TEST · Runtime", body: "UNSENT_WORKING_NOTE" }) as Note;
    const paper = store.dispatch("paper.create", { title: "TEST · Runtime paper" }) as Paper;
    const attachment = store.addAttachment(paper.id, "fixture.pdf", readFileSync("tests/fixtures/reading-fixture.pdf"));
    await run({ store, dir, idea, paper, attachmentId: attachment.id });
  } finally {
    globalThis.fetch = originalFetch; store.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous); rmSync(dir, { recursive: true, force: true });
  }
}
const response = (text: string) => new Response(JSON.stringify({ model: "fixture-actual-model", message: { content: text }, done: true }) + "\n");

for (const kind of ["idea", "paper"] as const) {
  test(`${kind} runtime independently renews a zero-output request beyond five minutes and accurately records cancellation`, async (t) => fixture(async ({ store, dir, idea, paper, attachmentId }) => {
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date(idea.createdAt) });
    const abort = new AbortController();
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => { ready = resolve; });
    globalThis.fetch = async (_url, options) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      options?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      ready();
    } }));
    const events: (IdeaChatStreamEvent | ChatStreamEvent)[] = [];
    const request = kind === "idea"
      ? runIdeaChat({ noteId: idea.id, revision: idea.revision, requestId: randomUUID(), message: "EXPLICIT_FIXTURE_QUESTION" }, (event) => events.push(event), abort.signal)
      : runPaperChat({ paperId: paper.id, attachmentId, message: "EXPLICIT_FIXTURE_QUESTION" }, (event) => events.push(event), abort.signal);
    await waiting;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const snapshot = (reader: KBStore) => kind === "idea" ? ideaConversationSnapshot(reader)[0].messages[1] : paperChatSnapshot(reader)[0].messages[1];
    const initial = snapshot(store);
    const actualActivity = initial.progress?.lastActivityAt;
    const reader = new KBStore(dir);
    try {
      for (let interval = 0; interval < 37; interval++) {
        t.mock.timers.tick(10000);
        if (kind === "idea") expireIdeaLeases(reader); else expirePaperChatLeases(reader);
        assert.equal(snapshot(reader).status, "pending", "another process must not expire a live, silent request");
      }
      const live = snapshot(reader);
      assert.equal(live.body, ""); assert.equal(live.progress?.startedAt, initial.createdAt);
      assert.equal(live.progress?.lastActivityAt, actualActivity, "heartbeats must never impersonate model activity");
      assert.equal(live.progress?.heartbeatAt, new Date().toISOString());
      assert.ok(events.filter((event) => event.type === "progress").length >= 37);
      assert.equal(events.some((event) => event.type === "delta"), false);
      abort.abort(); await request;
      const cancelled = snapshot(reader);
      assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.body, "");
      assert.match(cancelled.error, /尚未收到正文/); assert.doesNotMatch(cancelled.error, /部分正文已保留/);
      assert.equal(cancelled.progress?.processRunning, null, "HTTP providers do not expose an owned process");
      const count = events.length;
      t.mock.timers.tick(60000);
      assert.equal(events.length, count, "terminal requests must clear their heartbeat interval");
      assert.deepEqual(snapshot(reader), cancelled);
      if (kind === "idea") {
        beginIdeaTurn(store, { noteId: idea.id, requestId: randomUUID(), message: "DEAD_PROCESS_FIXTURE", sources: [], provider: "fixture", model: "fixture" });
        t.mock.timers.tick(310000); expireIdeaLeases(reader);
        const dead = ideaConversationSnapshot(reader).flatMap((conversation) => conversation.messages).find((message) => message.role === "assistant" && message.status === "failed");
        assert.ok(dead); assert.equal(dead.progress?.processRunning, null);
      }
    } finally { abort.abort(); await request; reader.close(); }
  }));
}

test("idea discussion and summary model overrides are per-request, persisted, validated and replayed without a second invocation", async () => fixture(async ({ store, idea }) => {
  const models: string[] = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body)) as { model: string; stream: boolean };
    models.push(body.model);
    return body.stream ? response("SYNTHETIC_DISCUSSION") : Response.json({ message: { content: JSON.stringify({ title: "TEST", sections: [
      { id: "question", title: "待验证问题", body: "这是测试整理稿，不是实验结果。", sourceIds: [] },
    ] }) } });
  };
  const before = store.snapshot().settings;
  const input = { noteId: idea.id, revision: idea.revision, requestId: randomUUID(), message: "MODEL_OVERRIDE_FIXTURE", model: "  fixture-selected-model  " };
  await runIdeaChat(input, () => {});
  const conversation = ideaConversationSnapshot(store)[0];
  assert.equal(models[0], "fixture-selected-model");
  assert.equal(conversation.messages[0].model, "fixture-selected-model");
  assert.equal(conversation.messages[1].model, "fixture-actual-model");
  await runIdeaChat({ ...input, model: undefined }, () => {});
  await assert.rejects(runIdeaChat({ ...input, model: "different-model" }, () => {}), /请求 ID/);
  const summarize = { noteId: idea.id, conversationId: conversation.id, messageIds: conversation.messages.map((message) => message.id),
    revision: idea.revision, requestId: randomUUID(), model: "fixture-summary-model" };
  const summary = await summarizeIdea(summarize);
  assert.equal(summary.model, "fixture-summary-model"); assert.equal(summary.requestedModel, "fixture-summary-model");
  assert.deepEqual(await summarizeIdea(summarize), summary);
  await assert.rejects(summarizeIdea({ ...summarize, model: "different-model" }), /请求 ID/);
  await assert.rejects(runIdeaChat({ ...input, requestId: randomUUID(), model: "invalid\nmodel" }, () => {}));
  assert.deepEqual(models, ["fixture-selected-model", "fixture-summary-model"]);
  assert.deepEqual(store.snapshot().settings, before);
}));

test("paper retry preserves the original model and refuses an implicit provider change", async () => fixture(async ({ store, paper, attachmentId }) => {
  const models: string[] = [];
  globalThis.fetch = async (_url, options) => { models.push((JSON.parse(String(options?.body)) as { model: string }).model); return response("SYNTHETIC_PAPER_REPLY"); };
  const before = store.snapshot().settings;
  await runPaperChat({ paperId: paper.id, attachmentId, message: "MODEL_FIXTURE", model: "fixture-selected-model" }, () => {});
  const conversation = paperChatSnapshot(store)[0];
  process.env.KB_OLLAMA_MODEL = "changed-default";
  const retry = { paperId: paper.id, attachmentId, message: "MODEL_FIXTURE", replay: {
    sourceConversationId: conversation.id, sourceMessageId: conversation.messages[0].id, kind: "retry" as const,
  } };
  await runPaperChat(retry, () => {});
  await assert.rejects(runPaperChat({ ...retry, model: "changed-selection" }, () => {}), /重试会沿用/);
  process.env.KB_AI_PROVIDER = "openai-compatible";
  await assert.rejects(runPaperChat(retry, () => {}), /重试会沿用/);
  assert.deepEqual(models, ["fixture-selected-model", "fixture-selected-model"]);
  assert.deepEqual(store.snapshot().settings, before);
}));
