import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStore, type KBStore } from "../src/lib/db";
import type { Annotation, Note, Paper, Topic } from "../src/lib/types";
import { GET, POST } from "../src/app/api/kb/idea-lab/route";
import { ideaHistory, resolveIdeaSources } from "../src/lib/idea-lab/context";
import { runIdeaChat, summarizeIdea, type IdeaChatStreamEvent } from "../src/lib/idea-lab/engine";
import { ideaConversationSnapshot, ideaSummarySnapshot } from "../src/lib/idea-lab/store";
import type { IdeaMessage, IdeaSourceInput } from "../src/lib/idea-lab/types";

interface Fixture { store: KBStore; idea: Note; other: Note; paper: Paper; topic: Topic; annotation: Annotation; dir: string }
async function fixture(run: (value: Fixture) => Promise<void>) {
  const previous = { ...process.env }, originalFetch = globalThis.fetch;
  const dir = mkdtempSync(path.join(os.tmpdir(), "kb-idea-lab-engine-"));
  process.env.KB_DATA_DIR = dir; process.env.KB_AI_PROVIDER = "ollama";
  process.env.KB_OLLAMA_URL = "http://127.0.0.1:11434"; process.env.KB_OLLAMA_MODEL = "explicit-software-fixture";
  const store = getStore();
  const idea = store.dispatch("note.create", { purpose: "idea", title: "TEST · Current idea", body: "CURRENT_PRIVATE_WORKING_NOTE" }) as Note;
  const other = store.dispatch("note.create", { purpose: "idea", title: "TEST · Other idea", body: "ALPHA 😀 OMEGA\nUNSELECTED_PRIVATE_SECTION" }) as Note;
  const paper = store.dispatch("paper.create", { title: "TEST · Explicit abstract only", abstract: "EXPLICIT_SELECTED_ABSTRACT" }) as Paper;
  const topic = store.dispatch("topic.create", { title: "TEST · Research question", description: "QUESTION_DESCRIPTION" }) as Topic;
  const file = store.addAttachment(paper.id, "reading-fixture.pdf", readFileSync("tests/fixtures/reading-fixture.pdf"));
  const annotation = store.dispatch("annotation.create", { paperId: paper.id, attachmentId: file.id, kind: "highlight",
    pageIndex: 0, pageLabel: "i", rects: [{ x: .1, y: .1, width: .3, height: .1 }],
    selectedText: "EXPLICIT_PDF_QUOTE", comment: "PERSONAL_COMMENT_NOT_PDF_FACT" }) as Annotation;
  try { await run({ store, idea, other, paper, topic, annotation, dir }); }
  finally {
    globalThis.fetch = originalFetch; store.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous); rmSync(dir, { recursive: true, force: true });
  }
}
function stream(text: string, signal?: AbortSignal, finish = true) {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    const encoder = new TextEncoder();
    controller.enqueue(encoder.encode(JSON.stringify({ message: { content: text }, ...(finish ? { done: true } : {}) }) + "\n"));
    if (finish) controller.close();
    else signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
  } }));
}
function source(paper: Paper): IdeaSourceInput { return { type: "paper", id: paper.id, revision: paper.revision, field: "abstract" }; }
function question(idea: Note, fields: Record<string, unknown> = {}) {
  return { noteId: idea.id, revision: idea.revision, requestId: randomUUID(), message: "EXPLICIT_TEST_QUESTION", ...fields };
}
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3117/api/kb/idea-lab", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("idea GET is passive, returns no private endpoint, and rejects cross-site or non-idea owners", async () => fixture(async ({ idea, paper }) => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not call"); };
  const response = await GET(new Request(`http://127.0.0.1:3117/api/kb/idea-lab?noteId=${idea.id}`));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json(); assert.deepEqual(data.conversations, []); assert.deepEqual(data.summaries, []);
  assert.equal("endpoint" in data.configuration, false); assert.equal(calls, 0);
  assert.equal((await GET(new Request(`http://127.0.0.1:3117/api/kb/idea-lab?noteId=${paper.id}`))).status, 404);
  assert.equal((await POST(request({ action: "send", ...question(idea) }, { origin: "https://untrusted.example" }))).status, 403);
  assert.equal((await POST(request({ action: "send", ...question(idea), injectedText: "not trusted" }))).status, 400);
  assert.equal(calls, 0);
}));

test("explicit source resolution preserves exact ranges, labels personal comments, and verifies immutable attachments", async () => fixture(async ({ store, other, paper, topic, annotation, dir }) => {
  const sources = resolveIdeaSources(store, [source(paper), { type: "note", id: other.id, revision: other.revision, field: "body", start: 0, end: 5 },
    { type: "topic", id: topic.id, revision: topic.revision, field: "description" },
    { type: "annotation", id: annotation.id, revision: annotation.revision, field: "quote" },
    { type: "annotation", id: annotation.id, revision: annotation.revision, field: "comment" }]);
  assert.equal(sources[1].text, "ALPHA"); assert.equal(sources[4].text, "PERSONAL_COMMENT_NOT_PDF_FACT");
  assert.equal(sources[3].attachmentId, annotation.attachmentId); assert.equal(sources[3].pageIndex, 0);
  assert.equal(sources[3].attachmentSha256?.length, 64); assert.match(sources[0].id, /:r1$/);
  assert.throws(() => resolveIdeaSources(store, [{ type: "note", id: other.id, revision: other.revision, field: "body", start: 0, end: 7 }]), /范围/);
  assert.throws(() => resolveIdeaSources(store, [source(paper), source(paper)]), /重复/);
  assert.throws(() => resolveIdeaSources(store, [{ ...source(paper), revision: 500 }]), /已更新/);
  const attachment = store.snapshot().attachments.find((item) => item.id === annotation.attachmentId)!;
  writeFileSync(path.join(dir, attachment.relativePath), "%PDF-1.7 altered fixture");
  assert.throws(() => resolveIdeaSources(store, [{ type: "annotation", id: annotation.id, revision: annotation.revision, field: "quote" }]), /校验|指纹|完整|不匹配|变化/);
}));

test("source limits reject oversized selections without silent truncation and recycled paper notes cannot be read", async () => fixture(async ({ store, idea, paper }) => {
  const long = store.dispatch("note.create", { purpose: "idea", title: "TEST · Long note", body: "x".repeat(16001) }) as Note;
  assert.throws(() => resolveIdeaSources(store, [{ type: "note", id: long.id, revision: long.revision, field: "body" }]), /16000/);
  assert.throws(() => resolveIdeaSources(store, Array.from({ length: 9 }, () => source(paper))), /8 项/);
  const paperNote = store.snapshot().notes.find((note) => note.purpose === "paper")!;
  const updated = store.dispatch("note.update", { id: paperNote.id, revision: paperNote.revision, body: "PAPER_NOTE" }) as Note;
  store.dispatch("paper.trash", { id: paper.id, revision: paper.revision });
  assert.throws(() => resolveIdeaSources(store, [{ type: "note", id: updated.id, revision: updated.revision, field: "body" }]), /回收站/);
  let calls = 0; globalThis.fetch = async () => { calls++; return stream("UNUSED"); };
  await assert.rejects(runIdeaChat({ ...question(idea), sources: [source(paper)] }, () => {}), /回收站/);
  assert.equal(calls, 0); assert.equal(ideaConversationSnapshot(store).length, 0);
}));

test("streamed idea discussion preserves selected snapshots and full multi-turn history without sending unselected notes", async () => fixture(async ({ store, idea, other, paper }) => {
  const calls: string[] = []; globalThis.fetch = async (_url, options) => { calls.push(String(options?.body)); return stream(`FIXTURE_REPLY_${calls.length}`); };
  const first = question(idea, { sources: [source(paper), { type: "note", id: other.id, revision: other.revision, field: "body", start: 0, end: 5 }] });
  const events: IdeaChatStreamEvent[] = [];
  await runIdeaChat(first, (event) => events.push(event));
  assert.deepEqual(events.filter((event) => event.type !== "progress").map((event) => event.type), ["start", "delta", "done"]);
  assert.match(calls[0], /EXPLICIT_SELECTED_ABSTRACT/); assert.match(calls[0], /ALPHA/);
  assert.doesNotMatch(calls[0], /CURRENT_PRIVATE_WORKING_NOTE|UNSELECTED_PRIVATE_SECTION/);
  const conversation = ideaConversationSnapshot(store)[0];
  assert.equal(conversation.messages.length, 2); assert.equal(conversation.messages[1].status, "completed");
  assert.deepEqual(conversation.messages[0].sources, conversation.messages[1].sources);
  store.dispatch("note.update", { id: other.id, revision: other.revision, body: "CHANGED_AFTER_SNAPSHOT" });
  await runIdeaChat({ ...question(idea), conversationId: conversation.id, message: "FOLLOW_UP" }, () => {});
  assert.match(calls[1], /FIXTURE_REPLY_1/); assert.match(calls[1], /EXPLICIT_SELECTED_ABSTRACT/);
  assert.match(calls[1], /ALPHA/); assert.doesNotMatch(calls[1], /CHANGED_AFTER_SNAPSHOT|CURRENT_PRIVATE_WORKING_NOTE/);
  // A lost successful response can be replayed even after a selected source was edited.
  const replay: IdeaChatStreamEvent[] = []; await runIdeaChat(first, (event) => replay.push(event));
  assert.equal(calls.length, 2); assert.equal(replay.at(-1)?.type, "done");
  assert.equal(ideaConversationSnapshot(store)[0].messages.length, 4);
  await assert.rejects(runIdeaChat({ ...first, message: "ALTERED_WITH_SAME_REQUEST_ID" }, () => {}), /请求 ID/);
}));

test("send route emits reviewable NDJSON records and rejects another active turn without another model call", async () => fixture(async ({ store, idea }) => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return stream("ROUTE_FIXTURE_REPLY"); };
  const response = await POST(request({ action: "send", ...question(idea) }));
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /application\/x-ndjson/);
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as IdeaChatStreamEvent);
  assert.deepEqual(events.filter((event) => event.type !== "progress").map((event) => event.type), ["start", "delta", "done"]);
  assert.equal(ideaConversationSnapshot(store)[0].messages[1].body, "ROUTE_FIXTURE_REPLY");
  const abort = new AbortController();
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  globalThis.fetch = async (_url, options) => { calls++; return stream("PENDING_FIXTURE", options?.signal ?? undefined, false); };
  const input = question(idea);
  const pending = runIdeaChat(input, (event) => { if (event.type === "delta") began(); }, abort.signal);
  await started;
  await assert.rejects(runIdeaChat(input, () => {}), /仍在生成/);
  await assert.rejects(runIdeaChat(question(idea), () => {}), /正在运行/);
  assert.equal(calls, 2);
  abort.abort(); await pending;
  assert.equal(ideaConversationSnapshot(store).filter((conversation) => conversation.messages.some((message) => message.status === "pending")).length, 0);
}));

test("current working note is only sent on explicit inclusion and history source recycling blocks another transmission", async () => fixture(async ({ store, idea, paper }) => {
  const calls: string[] = []; globalThis.fetch = async (_url, options) => { calls.push(String(options?.body)); return stream("FIXTURE_REPLY"); };
  await runIdeaChat({ ...question(idea), sources: [source(paper)], includeCurrentNote: true }, () => {});
  assert.match(calls[0], /CURRENT_PRIVATE_WORKING_NOTE/);
  const conversation = ideaConversationSnapshot(store)[0];
  store.dispatch("paper.trash", { id: paper.id, revision: paper.revision });
  await assert.rejects(runIdeaChat({ ...question(idea), conversationId: conversation.id }, () => {}), /回收站/);
  await assert.rejects(summarizeIdea({ noteId: idea.id, conversationId: conversation.id, messageIds: [conversation.messages[1].id], revision: idea.revision, requestId: randomUUID() }), /回收站/);
  assert.equal(calls.length, 1);
}));

test("recycling a selected paper during generation preserves the reply as failed rather than completed", async () => fixture(async ({ store, idea, paper }) => {
  globalThis.fetch = async () => {
    store.dispatch("paper.trash", { id: paper.id, revision: paper.revision });
    return stream("PARTIAL_REPLY_AFTER_RECYCLE");
  };
  const events: IdeaChatStreamEvent[] = [];
  await runIdeaChat({ ...question(idea), sources: [source(paper)] }, (event) => events.push(event));
  const reply = ideaConversationSnapshot(store)[0].messages[1];
  assert.equal(reply.status, "failed"); assert.equal(reply.body, "PARTIAL_REPLY_AFTER_RECYCLE");
  assert.match(reply.error, /回收站/); assert.equal(events.some((event) => event.type === "done"), false);
}));

test("cancelled and invalid streamed answers preserve partial text and never become completed", async () => fixture(async ({ store, idea }) => {
  const abort = new AbortController();
  globalThis.fetch = async (_url, options) => stream("PARTIAL_FIXTURE", options?.signal ?? undefined, false);
  const events: IdeaChatStreamEvent[] = [];
  await runIdeaChat(question(idea), (event) => { events.push(event); if (event.type === "delta") abort.abort(); }, abort.signal);
  const partial = ideaConversationSnapshot(store)[0].messages[1];
  assert.equal(partial.status, "cancelled"); assert.equal(partial.body, "PARTIAL_FIXTURE");
  assert.equal(events.some((event) => event.type === "done"), false);
  globalThis.fetch = async () => stream("[FAKE_SOURCE](kb://paper/00000000-0000-4000-8000-000000000000)");
  await runIdeaChat(question(idea), () => {});
  const failed = ideaConversationSnapshot(store).find((conversation) => conversation.messages[1].status === "failed")!;
  assert.match(failed.messages[1].error, /未提供/); assert.equal(failed.messages[1].status, "failed");
  assert.equal(ideaHistory(failed.messages).messages.length, 0);
}));

test("summary only uses selected immutable messages, is idempotent, and leaves the user's changing note untouched", async () => fixture(async ({ store, idea, paper }) => {
  let calls = 0, summaryPrompt = "";
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body)) as { stream: boolean; messages: { content: string }[] };
    calls++;
    if (body.stream) return stream(calls === 1 ? "SELECTED_REPLY" : "UNSELECTED_REPLY");
    summaryPrompt = body.messages[1].content;
    const conversation = ideaConversationSnapshot(store)[0];
    const id = conversation.messages[0].sources[0].id;
    // Generation may overlap new writing; the summary stays a separate preview.
    const current = store.snapshot().notes.find((note) => note.id === idea.id)!;
    store.dispatch("note.update", { id: current.id, revision: current.revision, body: "NEW_WRITING_DURING_SUMMARY" });
    return Response.json({ message: { content: JSON.stringify({ title: "TEST · Summary preview", sections: [
      { id: "question", title: "待验证的问题", body: "个人判断仍需验证。", sourceIds: [id] },
    ] }) } });
  };
  await runIdeaChat({ ...question(idea), sources: [source(paper)] }, () => {});
  const conversation = ideaConversationSnapshot(store)[0];
  await runIdeaChat({ ...question(idea), conversationId: conversation.id, message: "UNSELECTED_QUESTION" }, () => {});
  const requestId = randomUUID();
  const input = { noteId: idea.id, conversationId: conversation.id,
    messageIds: [conversation.messages[1].id, conversation.messages[0].id], revision: idea.revision, requestId };
  const summary = await summarizeIdea(input);
  assert.deepEqual(summary.messageIds, conversation.messages.map((message) => message.id));
  assert.match(summaryPrompt, /SELECTED_REPLY|EXPLICIT_SELECTED_ABSTRACT/);
  assert.doesNotMatch(summaryPrompt, /UNSELECTED_REPLY|UNSELECTED_QUESTION|CURRENT_PRIVATE_WORKING_NOTE/);
  assert.equal(summary.baseRevision, idea.revision); assert.equal(summary.applications.length, 0);
  assert.equal(store.snapshot().notes.find((note) => note.id === idea.id)?.body, "NEW_WRITING_DURING_SUMMARY");
  assert.deepEqual(await summarizeIdea(input), summary); assert.equal(calls, 3);
  assert.equal(ideaSummarySnapshot(store).length, 1);
}));

test("summary rejects invented evidence and links rather than creating an adoptable draft", async () => fixture(async ({ store, idea }) => {
  globalThis.fetch = async () => stream("SELECTED_REPLY");
  await runIdeaChat(question(idea), () => {});
  const conversation = ideaConversationSnapshot(store)[0];
  const input = { noteId: idea.id, conversationId: conversation.id, messageIds: [conversation.messages[1].id], revision: idea.revision, requestId: randomUUID() };
  globalThis.fetch = async () => Response.json({ message: { content: JSON.stringify({ title: "TEST", sections: [
    { id: "fake", title: "FAKE", body: "UNSUPPORTED", sourceIds: ["invented-source"] },
  ] }) } });
  await assert.rejects(summarizeIdea(input), /未提供/);
  globalThis.fetch = async () => Response.json({ message: { content: JSON.stringify({ title: "TEST", sections: [
    { id: "fake", title: "FAKE", body: "[Invented](https://unprovided.example/fake)", sourceIds: [] },
  ] }) } });
  await assert.rejects(summarizeIdea({ ...input, requestId: randomUUID() }), /未提供/);
  globalThis.fetch = async () => Response.json({ message: { content: JSON.stringify({ title: "TEST", sections: [
    { id: "fake", title: "FAKE", body: '<a href="https://unprovided.example">HTML citation</a>', sourceIds: [] },
  ] }) } });
  await assert.rejects(summarizeIdea({ ...input, requestId: randomUUID() }), /HTML/);
  assert.equal(ideaSummarySnapshot(store).length, 0);
  assert.equal(store.snapshot().notes.find((note) => note.id === idea.id)?.body, idea.body);
}));

test("oversized complete history rejects explicitly and failed turns do not contaminate history", () => {
  const conversationId = randomUUID(), requestId = randomUUID(), stamp = new Date().toISOString();
  const base = { conversationId, requestId, sources: [], provider: "fixture", model: "fixture", error: "", createdAt: stamp, updatedAt: stamp };
  const messages: IdeaMessage[] = [
    { ...base, id: randomUUID(), role: "user", body: "QUESTION", status: "completed" },
    { ...base, id: randomUUID(), role: "assistant", body: "x".repeat(81000), status: "completed" },
  ];
  assert.throws(() => ideaHistory(messages), /没有静默截断/);
  assert.equal(ideaHistory([{ ...messages[0] }, { ...messages[1], status: "failed" }]).messages.length, 0);
});
