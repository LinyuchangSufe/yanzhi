import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexModelCatalog, listModelOptions, modelOptions } from "../src/lib/ai/model-options";
import type { ModelConfiguration } from "../src/lib/ai/request";
import { GET } from "../src/app/api/kb/chat/models/route";
import { getStore } from "../src/lib/db";

const apiConfig: ModelConfiguration = {provider: "openai-compatible", endpoint: "https://fixture.example/v1", model: "fixture-default", configured: true, message: "fixture"};
function hasStatus(status: number) {
  return (error: unknown) => error instanceof Error && (error as Error & {status?: number}).status === status;
}
async function withEnvironment(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-model-catalog-fixture-"));
  const previous = {...process.env};
  const originalFetch = globalThis.fetch;
  process.env.KB_DATA_DIR = path.join(root, "data");
  process.env.KB_AI_PROVIDER = "openai-compatible";
  process.env.KB_OPENAI_MODEL = "fixture-current";
  process.env.KB_OPENAI_URL = apiConfig.endpoint;
  process.env.KB_OPENAI_API_KEY = "private-model-list-fixture-secret";
  try { await run(root); }
  finally {
    globalThis.fetch = originalFetch;
    if (existsSync(path.join(root, "data"))) getStore().close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(root, {recursive: true, force: true});
  }
}

test("model catalogs filter malformed, hidden, duplicate and unsafe entries without inventing models", () => {
  assert.deepEqual(modelOptions({data: [
    {id: "fixture-alpha", displayName: "Fixture Alpha"},
    {id: " fixture-alpha ", displayName: "duplicate"},
    {id: "hidden-fixture", hidden: true}, {id: ""}, {id: "  "}, {id: 42}, null, "invalid",
    {id: "x".repeat(301)}, {id: "control\nmodel"}, {id: "null\u0000model"},
    {id: "fixture-beta", displayName: "control\nlabel"},
    {id: " fixture-gamma ", displayName: "  Fixture Gamma  "},
  ]}, "openai-compatible"), [
    {id: "fixture-alpha", label: "Fixture Alpha"}, {id: "fixture-beta", label: "fixture-beta"},
    {id: "fixture-gamma", label: "Fixture Gamma"},
  ]);
  assert.deepEqual(modelOptions({data: [{model: "codex-fixture", id: "unrelated-alias", displayName: "Codex fixture"}, {id: "id-fallback"}]}, "codex"), [
    {id: "codex-fixture", label: "Codex fixture"}, {id: "id-fallback", label: "id-fallback"},
  ]);
  assert.deepEqual(modelOptions({models: [{name: "ollama-fixture:tag"}, {model: "ollama-fallback"}]}, "ollama"), [
    {id: "ollama-fixture:tag", label: "ollama-fixture:tag"}, {id: "ollama-fallback", label: "ollama-fallback"},
  ]);
  assert.deepEqual(modelOptions({data: []}, "codex"), []);
  assert.throws(() => modelOptions({models: []}, "openai-compatible"), hasStatus(502));
  assert.throws(() => modelOptions(null, "ollama"), hasStatus(502));
  assert.equal(modelOptions({data: Array.from({length: 350}, (_, index) => ({id: `fixture-${index}`}))}, "openai-compatible").length, 300);
});

test("HTTP model catalogs use read-only provider paths, existing credentials, and no redirects", async () => {
  await withEnvironment(async () => {
    const calls: {url: string; options?: RequestInit}[] = [];
    globalThis.fetch = async (url, options) => {
      calls.push({url: String(url), options});
      return Response.json(calls.length === 1 ? {data: [{id: "api-fixture-model"}]} : {models: [{name: "ollama-fixture-model"}]});
    };
    assert.deepEqual(await listModelOptions({...apiConfig, endpoint: `${apiConfig.endpoint}/`}), [{id: "api-fixture-model", label: "api-fixture-model"}]);
    assert.deepEqual(await listModelOptions({...apiConfig, provider: "ollama", endpoint: "http://127.0.0.1:11434/"}), [{id: "ollama-fixture-model", label: "ollama-fixture-model"}]);
    assert.equal(calls[0].url, "https://fixture.example/v1/models");
    assert.equal(calls[0].options?.method, "GET");
    assert.equal(calls[0].options?.body, undefined);
    assert.equal(calls[0].options?.redirect, "error");
    assert.equal(new Headers(calls[0].options?.headers).get("authorization"), "Bearer private-model-list-fixture-secret");
    assert.equal(calls[1].url, "http://127.0.0.1:11434/api/tags");
    assert.equal(new Headers(calls[1].options?.headers).has("authorization"), false);
    assert.ok(calls[0].options?.signal instanceof AbortSignal);
    for (const endpoint of ["bad-url", "https://name:password@fixture.example/v1", "https://fixture.example/v1?private=secret", "https://fixture.example/v1#fragment", "http://remote.fixture/v1", "file:///tmp/private"]) {
      await assert.rejects(listModelOptions({...apiConfig, endpoint}), hasStatus(400));
    }
    await assert.rejects(listModelOptions({...apiConfig, provider: "ollama", endpoint: "https://remote.fixture"}), hasStatus(400));
    await assert.rejects(listModelOptions({...apiConfig, provider: "unsupported-fixture"}), hasStatus(422));
    assert.equal(calls.length, 2, "invalid endpoints or providers must never make a network request");
  });
});

test("HTTP model catalogs bound response size, release streams, and sanitize service and transport failures", async () => {
  await withEnvironment(async () => {
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1_000_001)); },
      cancel() { cancelled = true; },
    }));
    await assert.rejects(listModelOptions(apiConfig), hasStatus(502));
    assert.equal(cancelled, true, "oversized body must be cancelled without waiting for more bytes");
    for (const response of [new Response("not json"), Response.json({wrong: []}), new Response(null)]) {
      globalThis.fetch = async () => response;
      await assert.rejects(listModelOptions(apiConfig), hasStatus(502));
    }
    let errorCancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({cancel() { errorCancelled = true; }}), {status: 401});
    await assert.rejects(listModelOptions(apiConfig), hasStatus(502));
    assert.equal(errorCancelled, true);
    globalThis.fetch = async (_url, options) => {
      assert.equal(options?.redirect, "error");
      throw new Error("private fixture credential and redirect URL must not escape");
    };
    await assert.rejects(listModelOptions(apiConfig), (error: unknown) => hasStatus(502)(error) && !(error as Error).message.includes("private fixture"));
  });
});

test("HTTP model catalog cancellation rejects before fetching and while reading", async () => {
  await withEnvironment(async () => {
    let fetchCalls = 0;
    const before = new AbortController(); before.abort();
    globalThis.fetch = async () => { fetchCalls++; return Response.json({data: []}); };
    await assert.rejects(listModelOptions(apiConfig, before.signal), hasStatus(499));
    assert.equal(fetchCalls, 0);
    const during = new AbortController();
    let released = false;
    globalThis.fetch = async (_url, options) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        options?.signal?.addEventListener("abort", () => { released = true; controller.error(new DOMException("Aborted", "AbortError")); }, {once: true});
        queueMicrotask(() => during.abort());
      },
    }));
    await assert.rejects(listModelOptions(apiConfig, during.signal), hasStatus(499));
    assert.equal(released, true);
  });
});

interface FixtureRecord {args?: string[]; pid?: number; childPid?: number; cwd?: string; leakedCredential?: string; method?: string; id?: number; params?: Record<string, unknown>}
function fixtureRecords(file: string): FixtureRecord[] {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as FixtureRecord) : [];
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function withCodexFixture(run: (root: string, log: string, mode: string) => Promise<void>) {
  await withEnvironment(async (root) => {
    const log = path.join(root, "fixture.jsonl");
    const mode = path.join(root, "mode");
    const executable = path.join(root, "codex-fixture.mjs");
    const orphanChildScript = "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(" + JSON.stringify(`${mode}.child-ready`) + ",'ready');setInterval(()=>{},1000)";
    writeFileSync(mode, "success");
    writeFileSync(executable, `#!${process.execPath}
import readline from 'node:readline'; import fs from 'node:fs'; import {spawn} from 'node:child_process';
const mode=fs.readFileSync(${JSON.stringify(mode)},'utf8');
const log=value=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(value)+'\\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
log({args:process.argv.slice(2),pid:process.pid,cwd:process.cwd(),leakedCredential:process.env.KB_OPENAI_API_KEY});
if(mode==='hang') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
for await(const line of readline.createInterface({input:process.stdin})) {
 const request=JSON.parse(line); log(request);
 if(request.method==='initialize') send({id:request.id,result:{}});
 if(request.method==='model/list') {
  if(mode==='success') send({id:request.id,result:{data:[{model:'fixture-codex-model',displayName:'Fixture Codex'},{model:'hidden-fixture',hidden:true}]}});
  if(mode==='error') send({id:request.id,error:{message:'private-fixture-server-error'}});
  if(mode==='unexpected') send({id:88,method:'tool/execute',params:{command:'DO NOT RUN'}});
  if(mode==='malformed') process.stdout.write('{invalid-json}\\n');
  if(mode==='oversized') process.stdout.write('x'.repeat(1000001));
  if(mode==='exit') process.exit(0);
  if(mode==='hang'||mode==='orphan') { const child=spawn(process.execPath,['-e',mode==='orphan'?${JSON.stringify(orphanChildScript)}:'setInterval(()=>{},1000)'],{stdio:'ignore'}); log({childPid:child.pid}); }
 }
}
`);
    chmodSync(executable, 0o700);
    process.env.KB_CODEX_BIN = executable;
    try { await run(root, log, mode); }
    finally {
      for (const record of fixtureRecords(log)) {
        for (const pid of [record.pid, record.childPid]) if (pid && alive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch { /* Fixture already terminated. */ }
        }
      }
    }
  });
}

test("Codex model discovery sends only initialize and model/list, filters hidden models, and cleans process plus temp cwd", async () => {
  await withCodexFixture(async (_root, log) => {
    const listeners = process.listenerCount("exit");
    assert.deepEqual(await codexModelCatalog(), [{id: "fixture-codex-model", label: "Fixture Codex"}]);
    const records = fixtureRecords(log);
    assert.equal(records[0].args?.[0], "app-server");
    assert.equal(records[0].leakedCredential, undefined);
    assert.deepEqual(records.filter((record) => record.method).map((record) => record.method), ["initialize", "initialized", "model/list"]);
    assert.deepEqual(records.find((record) => record.method === "model/list")?.params, {limit: 100, includeHidden: false});
    assert.equal(alive(records[0].pid!), false);
    assert.equal(existsSync(records[0].cwd!), false);
    assert.equal(process.listenerCount("exit"), listeners);
  });
});

test("Codex model discovery stops on malformed, oversized, unexpected tool, provider failure, or early exit", async () => {
  await withCodexFixture(async (_root, log, mode) => {
    for (const failure of ["error", "unexpected", "malformed", "oversized", "exit"]) {
      writeFileSync(mode, failure);
      await assert.rejects(codexModelCatalog(), (error: unknown) => hasStatus(502)(error) && !(error as Error).message.includes("private-fixture-server-error"));
      const records = fixtureRecords(log);
      const spawned = records.filter((record) => record.pid).at(-1)!;
      assert.equal(alive(spawned.pid!), false);
      assert.equal(existsSync(spawned.cwd!), false);
      assert.equal(records.some((record) => record.method === "thread/start" || record.method === "turn/start"), false);
    }
  });
});

test("Codex model cancellation handles pre-cancel without spawning and kills an active process group", async () => {
  await withCodexFixture(async (_root, log, mode) => {
    const before = new AbortController(); before.abort();
    await assert.rejects(codexModelCatalog(before.signal), hasStatus(499));
    assert.deepEqual(fixtureRecords(log), []);
    writeFileSync(mode, "hang");
    const during = new AbortController();
    const pending = codexModelCatalog(during.signal);
    let childPid: number | undefined;
    for (let attempt = 0; attempt < 300; attempt++) {
      childPid = fixtureRecords(log).find((record) => record.childPid)?.childPid;
      if (childPid) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    during.abort();
    await assert.rejects(pending, hasStatus(499));
    assert.ok(childPid, "synthetic process must reach model/list before cancellation");
    const spawned = fixtureRecords(log).find((record) => record.pid)!;
    assert.equal(alive(spawned.pid!), false);
    for (let attempt = 0; attempt < 50 && alive(childPid); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(alive(childPid), false, "an app-server child process must not survive cancellation");
    assert.equal(existsSync(spawned.cwd!), false);
  });
});

test("Codex model cancellation kills descendants even when their wrapper exits before them", async () => {
  await withCodexFixture(async (_root, log, mode) => {
    writeFileSync(mode, "orphan");
    const abort = new AbortController();
    const pending = codexModelCatalog(abort.signal);
    let ready = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      ready = existsSync(`${mode}.child-ready`);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    abort.abort();
    await assert.rejects(pending, hasStatus(499));
    assert.equal(ready, true, "descendant must install its SIGTERM handler before cancellation");
    const records = fixtureRecords(log);
    const spawned = records.find((record) => record.pid)!;
    const childPid = records.find((record) => record.childPid)!.childPid!;
    assert.equal(alive(spawned.pid!), false);
    for (let attempt = 0; attempt < 100 && alive(childPid); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(alive(childPid), false, "a descendant ignoring SIGTERM must still be killed when its wrapper closes");
    assert.equal(existsSync(spawned.cwd!), false);
  });
});

test("models route blocks cross-site requests and returns safe fallback warnings without exposing secrets", async () => {
  await withEnvironment(async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({data: [{id: "fixture-visible-model"}]}); };
    const blocked = await GET(new Request("http://127.0.0.1:3000/api/kb/chat/models", {headers: {origin: "https://untrusted.fixture"}}));
    assert.equal(blocked.status, 403);
    assert.equal(calls, 0);
    const response = await GET(new Request("http://127.0.0.1:3000/api/kb/chat/models"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {provider: "openai-compatible", currentModel: "fixture-current", models: [{id: "fixture-visible-model", label: "fixture-visible-model"}]});
    globalThis.fetch = async () => { throw new Error("private-model-list-fixture-secret"); };
    const fallback = await GET(new Request("http://127.0.0.1:3000/api/kb/chat/models"));
    assert.equal(fallback.status, 200);
    const body = await fallback.text();
    assert.ok(!body.includes("private-model-list-fixture-secret"));
    assert.ok(!body.includes("fixture.example"));
    assert.match(body, /warning/);
    const abort = new AbortController(); abort.abort();
    const cancelled = await GET(new Request("http://127.0.0.1:3000/api/kb/chat/models", {signal: abort.signal}));
    assert.equal(cancelled.status, 499);
  });
});
