import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getStore, type KBStore } from "../src/lib/db";
import type { Note, Paper } from "../src/lib/types";
import { createLiteratureTools, type LiteratureLookup } from "../src/lib/ai/literature-tools";
import type { LiteratureSearchResult } from "../src/lib/literature/types";
import { runIdeaChat, summarizeIdea } from "../src/lib/idea-lab/engine";
import { ideaConversationSnapshot, ideaSummarySnapshot } from "../src/lib/idea-lab/store";
import { runPaperChat } from "../src/lib/paper-chat/engine";
import { paperChatSnapshot } from "../src/lib/paper-chat/store";
import { paperChatMessageSchema } from "../src/lib/paper-chat/schemas";

const href = "https://doi.org/10.1234/synthetic";
function metadata(): LiteratureSearchResult {
  return { candidates: [{ id: "source-id-not-necessary-for-model", candidateToken: "PRIVATE_IMPORT_CAPABILITY_MUST_NOT_LEAK",
    metadata: { title: "SYNTHETIC public title", sourceUrl: href, doi: "10.1234/synthetic", abstract: "Public abstract, not full PDF text.", authors: ["Synthetic Author"], year: 2026 },
    match: "exact", provenance: [{ label: "Synthetic registry", url: "https://api.crossref.org/works/10.1234/synthetic", fields: ["title", "doi"] }], warnings: [],
    existingPaperId: randomUUID(), hasPdf: true, existingTrashed: false }], warnings: [], inheritedTags: ["PRIVATE_TAG_NOT_SENT"], contextPaperIds: [randomUUID()], queriedAt: "2026-11-01T00:00:00.000Z" };
}
async function fixture(run: (value: { store: KBStore; idea: Note; paper: Paper; attachmentId: string; mode: (value: string) => void }) => Promise<void>) {
  const before = { ...process.env }, originalFetch = globalThis.fetch, root = mkdtempSync(path.join(os.tmpdir(), "kb-lit-tool-engine-"));
  const modeFile = path.join(root, "mode"), executable = path.join(root, "server.mjs"); writeFileSync(modeFile, "lookup");
  writeFileSync(executable, `#!${process.execPath}
import fs from 'node:fs'; import readline from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n'),scope={threadId:'lit-thread',turnId:'lit-turn'};
const item={id:'lookup',type:'dynamicToolCall',namespace:null,tool:'lookup_literature',arguments:{query:'SYNTHETIC public title'},status:'inProgress'};
let mode='lookup'; const finish=()=>{const text=mode==='forged'?'[invented](https://doi.org/10.9999/not-returned)':'Metadata only, not downloaded: [verified](${href})';send({method:'item/agentMessage/delta',params:{...scope,itemId:'answer',delta:text}});if(mode!=='partial')send({method:'turn/completed',params:{threadId:scope.threadId,turn:{id:scope.turnId,status:'completed'}}});};
for await(const line of readline.createInterface({input:process.stdin})){
 const message=JSON.parse(line);
 if(message.method==='initialize')send({id:message.id,result:{}});
 if(message.method==='thread/start')send({id:message.id,result:{thread:{id:scope.threadId},model:'synthetic-model'}});
 if(message.method==='turn/start'){
  mode=fs.readFileSync(${JSON.stringify(modeFile)},'utf8');send({id:message.id,result:{turn:{id:scope.turnId}}});send({method:'turn/started',params:{threadId:scope.threadId,turn:{id:scope.turnId}}});
  if(mode==='history'||mode==='forged'){finish();continue;}
  send({method:'item/started',params:{...scope,item}});send({id:'tool-request',method:'item/tool/call',params:{...scope,callId:item.id,namespace:null,tool:item.tool,arguments:item.arguments}});
 }
 if(message.id==='tool-request'&&message.result){send({method:'item/completed',params:{...scope,item:{...item,status:message.result.success?'completed':'failed'}}});finish();}
}
`);
  chmodSync(executable, 0o700); process.env.KB_DATA_DIR = path.join(root, "data"); process.env.KB_AI_PROVIDER = "codex"; process.env.KB_CODEX_BIN = executable;
  const store = getStore();
  try {
    const idea = store.dispatch("note.create", { title: "SYNTHETIC private idea", purpose: "idea", body: "PRIVATE_WORKING_NOTE_NOT_SEARCHED" }) as Note;
    const paper = store.dispatch("paper.create", { title: "SYNTHETIC source PDF", abstract: "Explicit synthetic abstract" }) as Paper;
    const file = store.addAttachment(paper.id, "reading-fixture.pdf", readFileSync("tests/fixtures/reading-fixture.pdf"));
    await run({ store, idea, paper, attachmentId: file.id, mode: value => writeFileSync(modeFile, value) });
  } finally {
    globalThis.fetch = originalFetch; store.close(); rmSync(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]; Object.assign(process.env, before);
  }
}

test("literature capability binds context, exposes only public metadata and never returns import tokens or private context", async () => fixture(async ({ store, idea }) => {
  const context = { noteId: idea.id }, calls: unknown[] = [], result = metadata();
  const lookup: LiteratureLookup = async (input, actualStore, signal) => { calls.push(input); assert.equal(actualStore, store); assert.equal(signal?.aborted, false); return result; };
  const tool = createLiteratureTools(store, context, lookup); context.noteId = randomUUID();
  const text = await tool.tools[0].call({ query: "SYNTHETIC title" }, new AbortController().signal);
  assert.deepEqual(calls, [{ query: "SYNTHETIC title", context: { noteId: idea.id } }]);
  assert.doesNotMatch(text, /PRIVATE_|candidateToken|existingPaperId|contextPaperIds|inheritedTags/);
  assert.equal(JSON.parse(text).candidates[0].alreadyInLibrary, true); assert.deepEqual(tool.sources(), [href]);
  await assert.rejects(tool.tools[0].call({ query: "Public title", context: { noteId: randomUUID() } }, new AbortController().signal));
  assert.equal(calls.length, 1, "model cannot override the engine-owned library scope");
  const dual = metadata(); dual.candidates[0].metadata.arxivId = "2601.00001v2";
  const alternate = createLiteratureTools(store, { noteId: idea.id }, async () => dual);
  const output = JSON.parse(await alternate.tools[0].call({ query: "Public title" }, new AbortController().signal));
  assert.deepEqual(output.candidates[0].citationLinks, [href, "https://arxiv.org/abs/2601.00001v2"]);
  assert.deepEqual(alternate.sources(), output.candidates[0].citationLinks);
}));

test("metadata output has explicit byte/count/excerpt limits and cancellation never exposes a late result", async () => fixture(async ({ store, idea }) => {
  const result = metadata(), candidate = result.candidates[0]; candidate.metadata.abstract = "界".repeat(10000);
  result.candidates = Array.from({ length: 20 }, (_, index) => ({ ...candidate, metadata: { ...candidate.metadata, doi: `10.1234/synthetic-${index}`, sourceUrl: `https://doi.org/10.1234/synthetic-${index}` } }));
  const tool = createLiteratureTools(store, { noteId: idea.id }, async () => result);
  const text = await tool.tools[0].call({ query: "Public title" }, new AbortController().signal), decoded = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) <= 65536); assert.ok(decoded.candidates.length <= 6); assert.ok(decoded.omitted >= 14);
  assert.equal(decoded.candidates[0].abstractTruncated, true); assert.ok(tool.sources().length <= 40);
  const abort = new AbortController(), stopped = createLiteratureTools(store, { noteId: idea.id }, async () => { abort.abort(); return result; });
  await assert.rejects(stopped.tools[0].call({ query: "Public title" }, abort.signal), /cancelled/); assert.deepEqual(stopped.sources(), []);
}));

test("idea chat stores verified tool citations, allows later reuse without a lookup and summarizes that later turn alone", { timeout: 10000 }, async () => fixture(async ({ store, idea, mode }) => {
  let calls = 0; const lookup: LiteratureLookup = async input => { calls++; assert.deepEqual(input.context, { noteId: idea.id }); assert.doesNotMatch(input.query, /PRIVATE_/); return metadata(); };
  const send = (conversationId?: string) => runIdeaChat({ noteId: idea.id, revision: idea.revision, requestId: randomUUID(), message: "Find the public synthetic paper", ...(conversationId ? { conversationId } : {}) }, () => {}, undefined, store, { literatureLookup: lookup });
  const beforeNotes = structuredClone(store.snapshot().notes); await send();
  const first = ideaConversationSnapshot(store)[0]; assert.equal(first.messages[1].status, "completed"); assert.deepEqual(first.messages[1].literatureSources, [href]);
  mode("history"); await send(first.id); assert.equal(calls, 1);
  const second = ideaConversationSnapshot(store)[0].messages[3]; assert.equal(second.status, "completed"); assert.deepEqual(second.literatureSources, [href]);
  process.env.KB_AI_PROVIDER = "ollama"; process.env.KB_OLLAMA_URL = "http://127.0.0.1:11434"; process.env.KB_OLLAMA_MODEL = "fake-summary";
  globalThis.fetch = async () => Response.json({ message: { content: JSON.stringify({ title: "Synthetic citation note", sections: [{ id: "sources", title: "Sources", body: `[Verified metadata](${href}); PDF was not read.`, sourceIds: [] }] }) } });
  await summarizeIdea({ noteId: idea.id, revision: idea.revision, conversationId: first.id, messageIds: [second.id], requestId: randomUUID() }, undefined, store);
  assert.equal(ideaSummarySnapshot(store).length, 1); assert.deepEqual(store.snapshot().notes, beforeNotes);
}));

test("unverified model citations still fail, and a cancelled partial reply retains only actual tool URLs", { timeout: 10000 }, async () => fixture(async ({ store, idea, mode }) => {
  mode("forged"); let calls = 0; const lookup: LiteratureLookup = async () => { calls++; return metadata(); };
  const input = () => ({ noteId: idea.id, revision: idea.revision, requestId: randomUUID(), message: "Synthetic lookup" });
  await runIdeaChat(input(), () => {}, undefined, store, { literatureLookup: lookup });
  assert.equal(ideaConversationSnapshot(store)[0].messages[1].status, "failed"); assert.equal(calls, 0);
  mode("partial"); const abort = new AbortController();
  await runIdeaChat(input(), event => { if (event.type === "delta") abort.abort(); }, abort.signal, store, { literatureLookup: lookup });
  const partial = ideaConversationSnapshot(store).flatMap(conversation => conversation.messages).find(message => message.status === "cancelled")!;
  assert.ok(partial); assert.deepEqual(partial.literatureSources, [href]); assert.equal(calls, 1);
}));

test("paper chat binds lookup to its paper and retains public citation URLs across later turns without changing library content", { timeout: 10000 }, async () => fixture(async ({ store, paper, attachmentId, mode }) => {
  let calls = 0; const before = store.snapshot(); const lookup: LiteratureLookup = async input => { calls++; assert.deepEqual(input.context, { paperIds: [paper.id] }); return metadata(); };
  await runPaperChat({ paperId: paper.id, attachmentId, message: "Find the cited synthetic work" }, () => {}, undefined, store, { literatureLookup: lookup });
  const reply = paperChatSnapshot(store)[0].messages[1]; assert.equal(reply.status, "completed"); assert.deepEqual(reply.literatureSources, [href]);
  assert.equal(paperChatMessageSchema.safeParse({ ...reply, literatureSources: undefined }).success, true, "old saved messages remain compatible");
  assert.equal(paperChatMessageSchema.safeParse({ ...reply, literatureSources: ["not-a-url"] }).success, false);
  assert.equal(paperChatMessageSchema.safeParse({ ...reply, literatureSources: ["https://user:secret@example.org/paper"] }).success, false);
  assert.equal(paperChatMessageSchema.safeParse({ ...reply, role: "user", scope: null }).success, false, "user messages cannot claim verified tool provenance");
  mode("history");
  await runPaperChat({ paperId: paper.id, attachmentId, conversationId: reply.conversationId, message: "Explain the known source" }, () => {}, undefined, store, { literatureLookup: lookup });
  const next = paperChatSnapshot(store)[0].messages[3]; assert.equal(next.status, "completed"); assert.deepEqual(next.literatureSources, [href]); assert.equal(calls, 1);
  const after = store.snapshot(); assert.deepEqual(after.papers, before.papers); assert.deepEqual(after.attachments, before.attachments); assert.deepEqual(after.notes, before.notes);
}));
