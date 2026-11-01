import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { KBStore, getStore } from "../src/lib/db";
import { createBackup, restoreBackup, exportMarkdown } from "../src/lib/archive";
import { requestStreamingAI } from "../src/lib/ai/request";
import { runCodex } from "../src/lib/ai/codex";
import { streamCodexChat } from "../src/lib/ai/codex-stream";
import { runPaperChat } from "../src/lib/paper-chat/engine";
import { chatHistory, selectChatText } from "../src/lib/paper-chat/context";
import { beginChatTurn, expirePaperChatLeases, paperChatSnapshot, updateChatMessage } from "../src/lib/paper-chat/store";
import { POST, GET } from "../src/app/api/kb/chat/route";
import type { ChatStreamEvent, PaperChatMessage } from "../src/lib/paper-chat/types";
import type { Paper } from "../src/lib/types";

const config = {provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "explicit-fixture", configured: true, message: "fixture"};
function fixtureStream(events: object[], signal?: AbortSignal) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      if (events.some((event) => (event as {done?: boolean}).done)) controller.close();
      else signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), {once: true});
    },
  }));
}
async function withLibrary(run: (store: KBStore, paper: Paper, attachmentId: string, root: string) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-paper-chat-fixture-"));
  const previous = {...process.env}; const originalFetch = globalThis.fetch;
  process.env.KB_DATA_DIR = path.join(root, "data");
  process.env.KB_AI_PROVIDER = config.provider; process.env.KB_OLLAMA_MODEL = config.model; process.env.KB_OLLAMA_URL = config.endpoint;
  const store = getStore();
  try {
    const pdf = await PDFDocument.create(); const page = pdf.addPage();
    page.drawText("EXPLICIT TEST SOURCE. Section 1. Test source contains no research result.", {font: await pdf.embedFont(StandardFonts.Helvetica), size: 10});
    const paper = store.dispatch("paper.create", {title: "EXPLICIT TEST PAPER"}) as Paper;
    const attachment = store.addAttachment(paper.id, "fixture.pdf", Buffer.from(await pdf.save()));
    await run(store, paper, attachment.id, root);
  } finally {
    globalThis.fetch = originalFetch; store.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous); rmSync(root, {recursive: true, force: true});
  }
}

test("paper chat: real provider increments precede completion; multi-turn history, ownership, and backups", async () => {
  await withLibrary(async (store, paper, attachmentId, root) => {
    const calls: {stream: boolean; messages: {role: string; content: string}[]}[] = [];
    let release: (() => void) | undefined;
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    globalThis.fetch = async (_url, options) => {
      calls.push(JSON.parse(String(options?.body)) as typeof calls[number]);
      if (calls.length > 1) return fixtureStream([{message: {content: "Follow-up fixture answer"}}, {done: true}]);
      return new Response(new ReadableStream<Uint8Array>({start(controller) { source = controller; }}));
    };
    const firstEvents: ChatStreamEvent[] = [];
    const firstDelta = new Promise<void>((resolve) => { release = resolve; });
    const running = runPaperChat({paperId: paper.id, attachmentId, message: "First fixture question"}, (event) => {
      firstEvents.push(event); if (event.type === "delta") release!();
    });
    while (!source) await new Promise((resolve) => setTimeout(resolve, 10));
    source.enqueue(new TextEncoder().encode('{"message":{"content":"First fixture"}}\n'));
    await firstDelta;
    assert.equal(firstEvents.some((event) => event.type === "done"), false, "delta must arrive before provider finishes");
    const start = firstEvents.find((event) => event.type === "start")!;
    assert.equal(start.type, "start");
    assert.equal(paperChatSnapshot(store)[0].messages.at(-1)?.status, "pending");
    await assert.rejects(runPaperChat({paperId: paper.id, attachmentId, conversationId: start.conversationId, message: "Concurrent question"}, () => {}), /正在生成/);
    source.enqueue(new TextEncoder().encode('{"message":{"content":" answer"},"done":true}\n')); source.close();
    await running;
    assert.equal(paperChatSnapshot(store)[0].messages.at(-1)?.body, "First fixture answer");
    assert.equal(paperChatSnapshot(store)[0].messages.at(-1)?.status, "completed");
    assert.equal(calls[0].stream, true); assert.match(calls[0].messages[0].content, /EXPLICIT TEST SOURCE/);
    await runPaperChat({paperId: paper.id, attachmentId, conversationId: start.conversationId, message: "Follow-up fixture question"}, () => {});
    assert.deepEqual(calls[1].messages.slice(1).map((message) => [message.role, message.content]), [
      ["user", "First fixture question"], ["assistant", "First fixture answer"], ["user", "Follow-up fixture question"],
    ]);
    const other = store.dispatch("paper.create", {title: "OTHER FIXTURE"}) as Paper;
    const wrong = await POST(new Request("http://127.0.0.1:3000/api/kb/chat", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({paperId: other.id, attachmentId, conversationId: start.conversationId, message: "Wrong paper"})}));
    assert.equal(wrong.status, 400); assert.equal(calls.length, 2);
    const denied = await GET(new Request(`http://127.0.0.1:3000/api/kb/chat?paperId=${paper.id}`, {headers: {origin: "https://untrusted.example"}}));
    assert.equal(denied.status, 403);
    const backup = createBackup(store); const restored = restoreBackup(backup, root);
    const restoredStore = new KBStore(restored.restoredDirectory);
    try { assert.deepEqual(restoredStore.snapshot().chatConversations, store.snapshot().chatConversations); }
    finally { restoredStore.close(); }
    assert.match(exportMarkdown(store.snapshot()), /First fixture answer/);
  });
});

test("paper chat: cancellation persists partial reply; incomplete provider body never becomes completed", async () => {
  await withLibrary(async (store, paper, attachmentId) => {
    const abort = new AbortController();
    globalThis.fetch = async (_url, options) => fixtureStream([{message: {content: "Partial fixture answer"}}], options?.signal ?? undefined);
    const events: ChatStreamEvent[] = [];
    await runPaperChat({paperId: paper.id, attachmentId, message: "Stop fixture question"}, (event) => {
      events.push(event); if (event.type === "delta") abort.abort();
    }, abort.signal);
    const partial = paperChatSnapshot(store)[0].messages.at(-1)!;
    assert.equal(partial.status, "cancelled"); assert.equal(partial.body, "Partial fixture answer");
    assert.equal(events.some((event) => event.type === "done"), false);
    globalThis.fetch = async () => new Response('{"message":{"content":"Incomplete fixture"}}\n');
    await runPaperChat({paperId: paper.id, attachmentId, message: "Broken provider question"}, () => {});
    const failed = paperChatSnapshot(store).find((conversation) => conversation.title === "Broken provider question")!.messages.at(-1)!;
    assert.equal(failed.status, "failed"); assert.equal(failed.body, "Incomplete fixture");
    assert.equal(chatHistory([partial, failed]).messages.length, 0);
  });
});

test("OpenAI SSE handles split UTF-8, sanitizes errors, and rejects truncated completions", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const body = 'data: {"choices":[{"delta":{"content":"中文"},"finish_reason":null}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    globalThis.fetch = async () => new Response(new ReadableStream({start(controller) {
      const bytes = new TextEncoder().encode(body); for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close();
    }}));
    const deltas: string[] = [];
    const result = await requestStreamingAI({...config, provider: "openai-compatible", endpoint: "https://fixture.example/v1"}, [{role: "user", content: "synthetic fixture"}], (text) => deltas.push(text));
    assert.equal(result.text, "中文"); assert.deepEqual(deltas, ["中文"]);
    globalThis.fetch = async () => new Response(new ReadableStream({start(controller) {
      for (const piece of ['data: {"choices":[{"delta":{"content":"answer"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DO', 'NE]\n\n'])
        controller.enqueue(new TextEncoder().encode(piece));
      controller.close();
    }}));
    const boundary = await requestStreamingAI({...config, provider: "openai-compatible", endpoint: "https://fixture.example/v1"}, [], () => {});
    assert.equal(boundary.text, "answer", "a partial [DONE] after a valid stop must not corrupt completion");
    globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n');
    await assert.rejects(requestStreamingAI({...config, provider: "openai-compatible", endpoint: "https://fixture.example/v1"}, [], () => {}), /截断/);
    globalThis.fetch = async () => new Response('data: {"error":{"message":"DO-NOT-EXPOSE-SECRET"}}\n\n');
    await assert.rejects(requestStreamingAI({...config, provider: "openai-compatible", endpoint: "https://fixture.example/v1"}, [], () => {}), (error: unknown) => error instanceof Error && !error.message.includes("DO-NOT-EXPOSE-SECRET"));
  } finally { globalThis.fetch = originalFetch; }
});

test("chat source/history limits and expired leases preserve original content", async () => {
  const pages = Array.from({length: 12}, (_, index) => (`PAGE ${index} ${index === 10 ? "targetword" : "otherword"} `).repeat(400));
  const selected = selectChatText(pages, "targetword");
  assert.ok(selected.characterCount <= 50000); assert.ok(selected.truncated); assert.ok(selected.pageIndices.includes(10));
  await withLibrary(async (store, paper, attachmentId) => {
    const attachment = store.snapshot().attachments[0];
    const scope = {attachmentId, attachmentSha256: attachment.sha256, pageIndices: [0], totalPages: 1, characterCount: 10, truncated: false, historyMessages: 0, historyTruncated: false};
    const turn = beginChatTurn(store, {paperId: paper.id, attachmentId, message: "Fixture interrupted turn", provider: "test-fixture", model: "test-fixture", scope});
    updateChatMessage(store, {...turn.assistantMessage, body: "Recovered partial"});
    store.db.prepare("UPDATE paper_chat_messages SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(turn.assistantMessage.id);
    expirePaperChatLeases(store);
    const saved = paperChatSnapshot(store)[0].messages.at(-1)!;
    assert.equal(saved.body, "Recovered partial"); assert.equal(saved.status, "failed");
    assert.throws(() => beginChatTurn(store, {paperId: paper.id, attachmentId, conversationId: turn.conversation.id,
      expectedLastMessageId: turn.userMessage.id, message: "Stale history fixture", provider: "test-fixture", model: "test-fixture", scope}), /其他窗口/);
    const invalid = structuredClone(store.snapshot()); invalid.chatConversations![0].messages[0].conversationId = paper.id;
    const target = new KBStore(path.join(store.dataDir, "bad-restore"));
    try { assert.throws(() => target.importSnapshot(invalid), /来源不一致/); assert.equal(target.snapshot().papers.length, 0); }
    finally { target.close(); }
  });
});

test("Codex genuine JSONL deltas propagate before completed turn and cancellation terminates CLI", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-chat-codex-fixture-"));
  const original = process.env.KB_CODEX_BIN;
  const executable = path.join(root, "codex-fixture.mjs");
  writeFileSync(executable, `#!${process.execPath}\nlet prompt=''; for await (const chunk of process.stdin) prompt += chunk;\nconst emit = event => process.stdout.write(JSON.stringify(event)+'\\n');\nemit({type:'item.updated',item:{id:'a',type:'agent_message',text:'Partial fixture'}});\nsetTimeout(()=>{emit({type:'item.completed',item:{id:'a',type:'agent_message',text:'Partial fixture answer'}});emit({type:'turn.completed'});},500);\n`);
  chmodSync(executable, 0o700); process.env.KB_CODEX_BIN = executable;
  try {
    const deltas: string[] = [];
    const result = await runCodex({prompt: "EXPLICIT TEST", summary: false, onDelta(text) { deltas.push(text); }});
    assert.equal(result.text, "Partial fixture answer"); assert.deepEqual(deltas, ["Partial fixture", " answer"]);
    const abort = new AbortController();
    await assert.rejects(runCodex({prompt: "EXPLICIT CANCEL", summary: false, signal: abort.signal, onDelta() { abort.abort(); }}), /取消/);
  } finally {
    if (original === undefined) delete process.env.KB_CODEX_BIN; else process.env.KB_CODEX_BIN = original;
    rmSync(root, {recursive: true, force: true});
  }
});

test("Codex app-server streams native deltas, isolates tools and auth, shares lock, and cancels process", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-chat-app-server-fixture-"));
  const original = {...process.env};
  const executable = path.join(root, "codex-app-server-fixture.mjs");
  const log = path.join(root, "rpc.jsonl");
  const modeFile = path.join(root, "mode");
  writeFileSync(modeFile, "success");
  writeFileSync(executable, `#!${process.execPath}
import readline from 'node:readline'; import fs from 'node:fs';
const mode=fs.readFileSync(${JSON.stringify(modeFile)},'utf8');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),secret:process.env.KB_OPENAI_API_KEY})+'\\n');
const send = value=>process.stdout.write(JSON.stringify(value)+'\\n');
const notify=(method,params)=>send({method,params});
for await (const line of readline.createInterface({input:process.stdin})) {
 const request=JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(request)+'\\n');
 if(request.method==='initialize') send({id:request.id,result:{}});
 if(request.method==='thread/start') send({id:request.id,result:{thread:{id:'fixture-thread'},model:'fixture-model'}});
 if(request.method==='turn/start') {
  send({id:request.id,result:{turn:{id:'fixture-turn'}}});
  const params={threadId:'fixture-thread',turnId:'fixture-turn',itemId:'fixture-item'};
  notify('item/agentMessage/delta',{...params,delta:'Native fixture'});
  if(mode==='success') setTimeout(()=>{
   notify('item/agentMessage/delta',{...params,delta:' answer'});
   notify('item/completed',{...params,item:{id:'fixture-item',type:'agentMessage',text:'Native fixture answer'}});
   notify('turn/completed',{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed',error:null}});
  },150);
  if(mode==='failed') setTimeout(()=>notify('turn/completed',{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'failed',error:{message:'private-secret-detail'}}}),100);
  if(mode==='tool') setTimeout(()=>notify('item/started',{...params,item:{id:'tool',type:'commandExecution',command:'DO NOT RUN'}}),100);
 }
}
`);
  chmodSync(executable, 0o700);
  process.env.KB_CODEX_BIN = executable; process.env.KB_CODEX_TIMEOUT_MS = "2000"; process.env.KB_OPENAI_API_KEY = "must-not-inherit";
  try {
    const deltas: string[] = [];
    const response = await streamCodexChat({system: "Fixture instructions", prompt: "Fixture paper question", onDelta: (text) => deltas.push(text)});
    assert.deepEqual(deltas, ["Native fixture", " answer"]); assert.equal(response.text, "Native fixture answer"); assert.equal(response.model, "fixture-model");
    const records = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {args?: string[]; secret?: string; method?: string; params?: Record<string, unknown>});
    assert.equal(records[0].secret, undefined); assert.equal(records[0].args?.[0], "app-server");
    const thread = records.find((record) => record.method === "thread/start")!.params!;
    assert.equal(thread.ephemeral, true); assert.deepEqual(thread.environments, []); assert.deepEqual(thread.dynamicTools, []); assert.equal(thread.sandbox, "read-only"); assert.equal(thread.approvalPolicy, "never");
    const abort = new AbortController();
    writeFileSync(modeFile, "cancel");
    let notify!: () => void;
    const ready = new Promise<void>((resolve) => { notify = resolve; });
    const pending = streamCodexChat({system: "Fixture", prompt: "Fixture cancel", signal: abort.signal, onDelta() { notify(); }});
    await ready;
    await assert.rejects(runCodex({prompt: "Must share active request lock", summary: false}), /正在运行/);
    abort.abort(); await assert.rejects(pending, /停止/);
    for (const mode of ["failed", "tool"]) {
      writeFileSync(modeFile, mode);
      await assert.rejects(streamCodexChat({system: "Fixture", prompt: "Fixture failure", onDelta() {}}), (error: unknown) => error instanceof Error && !error.message.includes("private-secret-detail"));
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original); rmSync(root, {recursive: true, force: true});
  }
});
