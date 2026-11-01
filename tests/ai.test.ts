import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {aiConfiguration,generationSchema,generateAI} from "../src/lib/ai";
import {getStore, StoreError} from "../src/lib/db";
import type {Paper} from "../src/lib/types";

test("AI boundary adapter: explicit mock transport, no configured model, real error preservation and human-note isolation",async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),"kb-ai-boundary-"));
 const previous={...process.env};const originalFetch=globalThis.fetch;
 process.env.KB_DATA_DIR=root;process.env.KB_AI_PROVIDER="none";
 const store=getStore();
 try {
  const paper=store.dispatch("paper.create",{title:"Explicit AI adapter test fixture",abstract:"TEST-ONLY SOURCE: This fixture defines no theorem and contains no experimental result."}) as Paper;
  const note=store.snapshot().notes.find(n=>store.snapshot().relations.some(r=>r.fromId===n.id&&r.toId===paper.id))!;
  store.dispatch("note.update",{id:note.id,revision:note.revision,body:"我的中文解释不允许AI覆盖"});
  await assert.rejects(generateAI({paperId:paper.id,kind:"summary"}),/设置|模型/);
  process.env.KB_AI_PROVIDER="ollama";process.env.KB_OLLAMA_MODEL="explicit-test-model";process.env.KB_OLLAMA_URL="http://127.0.0.1:11434";
  let requestBody="";let redirectPolicy:RequestRedirect|undefined;
  globalThis.fetch=async(_url,options)=>{requestBody=String(options?.body);redirectPolicy=options?.redirect;return Response.json({message:{content:JSON.stringify({researchProblem:"测试传输契约",coreMethod:"显式mock，不是真实模型输出",mainContributions:"仅验证格式、来源和存储隔离"})}});};
  const result=await generateAI({paperId:paper.id,kind:"summary"});
  assert.equal(result.sourceScope,"abstract");assert.equal(result.sourceAttachmentId,null);assert.deepEqual(result.sourcePageIndices,[]);
  assert.match(requestBody,/TEST-ONLY SOURCE/);assert.doesNotMatch(requestBody,/我的中文解释/);
  assert.equal(redirectPolicy,"error","never replay a selected paper to a redirected model endpoint");
  assert.equal(store.snapshot().notes.find(n=>n.id===note.id)?.body,"我的中文解释不允许AI覆盖");
  const count=store.snapshot().aiContents.length;
  globalThis.fetch=async()=>new Response("upstream error",{status:503});
  await assert.rejects(generateAI({paperId:paper.id,kind:"summary"}),/HTTP 503/);
  assert.equal(store.snapshot().aiContents.length,count);
  globalThis.fetch=async()=>Response.json({message:{content:"invalid summary schema"}});
  await assert.rejects(generateAI({paperId:paper.id,kind:"summary"}),/格式校验/);
  assert.equal(store.snapshot().aiContents.length,count);
  assert.equal(store.snapshot().notes.find(n=>n.id===note.id)?.body,"我的中文解释不允许AI覆盖");
  assert.equal(generationSchema.safeParse({paperId:paper.id,kind:"explanation",selection:"x",pageIndex:2}).success,false);
  process.env.KB_OPENAI_URL="https://user:server-secret@example.com/v1?api_key=server-secret";process.env.KB_AI_PROVIDER="openai-compatible";process.env.KB_OPENAI_MODEL="test";
  assert.equal(aiConfiguration().configured,false);assert.doesNotMatch(JSON.stringify(aiConfiguration()),/server-secret/);
 }finally{globalThis.fetch=originalFetch;store.close();for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);rmSync(root,{recursive:true,force:true});}
});

test("recycled papers reject summary and selection explanation before any model transport", async () => {
 const root = mkdtempSync(path.join(os.tmpdir(), "kb-ai-trash-"));
 const previous = { ...process.env }, originalFetch = globalThis.fetch;
 process.env.KB_DATA_DIR = root;
 process.env.KB_AI_PROVIDER = "ollama";
 process.env.KB_OLLAMA_MODEL = "explicit-fixture-no-model";
 process.env.KB_OLLAMA_URL = "http://127.0.0.1:11434";
 const store = getStore();
 let calls = 0;
 globalThis.fetch = async () => { calls++; throw new Error("Recycled paper must never reach transport"); };
 try {
  const paper = store.dispatch("paper.create", { title: "TEST recycled paper", abstract: "EXPLICIT TEST SOURCE" }) as Paper;
  store.dispatch("paper.trash", { id: paper.id, revision: paper.revision });
  const before = store.snapshot();
  const recycled = (error: unknown) => error instanceof StoreError && error.status === 409 && /回收站/.test(error.message);
  await assert.rejects(generateAI({ paperId: paper.id, kind: "summary" }), recycled);
  await assert.rejects(generateAI({ paperId: paper.id, kind: "explanation", selection: "TEST selected text" }), recycled);
  assert.equal(calls, 0);
  assert.deepEqual(store.snapshot(), before);
 } finally {
  globalThis.fetch = originalFetch;
  store.close();
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
  rmSync(root, { recursive: true, force: true });
 }
});
