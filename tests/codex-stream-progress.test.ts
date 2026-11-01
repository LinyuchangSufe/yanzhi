import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chatTimeoutMilliseconds, scheduleChatDeadline, streamCodexChat } from "../src/lib/ai/codex-stream";
import { requestStreamingAI } from "../src/lib/ai/request";
import type { ChatProgress } from "../src/lib/ai/chat-progress";

const sensitive = "DO_NOT_EXPOSE_PRIVATE_REASONING_OR_DIAGNOSTIC";
const originalEnvironment = () => ({ bin: process.env.KB_CODEX_BIN, legacy: process.env.KB_CODEX_TIMEOUT_MS, chat: process.env.KB_CHAT_TIMEOUT_MS });
function restoreEnvironment(previous: ReturnType<typeof originalEnvironment>) {
  for (const [key, value] of [["KB_CODEX_BIN", previous.bin], ["KB_CODEX_TIMEOUT_MS", previous.legacy], ["KB_CHAT_TIMEOUT_MS", previous.chat]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
}
function childFixture(options: { reasoning?: boolean; partial?: boolean; retry?: boolean; exit?: boolean; descendant?: boolean; wrapperIgnoresTerm?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-codex-progress-"));
  const previous = originalEnvironment();
  const executable = path.join(root, "fake-app-server.mjs");
  const processFile = path.join(root, "process.json"), finishFile = path.join(root, "finish"), log = path.join(root, "rpc.jsonl");
  writeFileSync(executable, `#!${process.execPath}
import readline from 'node:readline'; import fs from 'node:fs'; import {spawn} from 'node:child_process';
const options=${JSON.stringify(options)}, secret=${JSON.stringify(sensitive)};
const metadata={pid:process.pid,cwd:process.cwd(),args:process.argv.slice(2)};
if(options.descendant){
  if(options.wrapperIgnoresTerm!==false)process.on('SIGTERM',()=>{});
  const descendant=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore']});
  await new Promise(resolve=>descendant.stdout.once('data',resolve));
  metadata.descendant=descendant.pid;
}
fs.writeFileSync(${JSON.stringify(processFile)},JSON.stringify(metadata));
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const notify=(method,params)=>send({method,params});
for await(const line of readline.createInterface({input:process.stdin})){
 const request=JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(request)+'\\n');
 if(request.method==='initialize')send({id:request.id,result:{}});
 if(request.method==='thread/start')send({id:request.id,result:{thread:{id:'fixture-thread'},model:'fixture-model'}});
 if(request.method==='turn/start'){
  const params={threadId:'fixture-thread',turnId:'fixture-turn',itemId:'fixture-item'};
  send({id:request.id,result:{turn:{id:'fixture-turn'}}});
  notify('turn/started',{threadId:'fixture-thread',turn:{id:'fixture-turn'}});
  if(options.retry)notify('error',{...params,willRetry:true,error:{message:secret}});
  if(options.reasoning!==false){
   notify('item/reasoning/summaryPartAdded',{...params,summaryIndex:0});
   notify('item/reasoning/summaryTextDelta',{...params,delta:secret});
   notify('item/reasoning/textDelta',{...params,delta:secret});
  }
  if(options.partial)notify('item/agentMessage/delta',{...params,delta:'Partial synthetic answer'});
  if(options.exit){process.stderr.write(secret);process.exit(7);}
  const poll=setInterval(()=>{
   if(!fs.existsSync(${JSON.stringify(finishFile)}))return;
   clearInterval(poll);
   const text=options.partial?'Partial synthetic answer complete':'Synthetic answer complete';
   notify('item/agentMessage/delta',{...params,delta:options.partial?' complete':text});
   notify('item/completed',{...params,item:{id:'fixture-item',type:'agentMessage',text}});
   notify('turn/completed',{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed'}});
  },5);
 }
}
`);
  chmodSync(executable, 0o700);
  process.env.KB_CODEX_BIN = executable;
  process.env.KB_CODEX_TIMEOUT_MS = "100";
  delete process.env.KB_CHAT_TIMEOUT_MS;
  return {
    finish: () => writeFileSync(finishFile, "complete"),
    metadata: () => JSON.parse(readFileSync(processFile, "utf8")) as { pid: number; cwd: string; args: string[]; descendant?: number },
    requests: () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> }),
    cleanup() {
      if (existsSync(processFile)) {
        const { pid, descendant } = this.metadata();
        try { if (process.platform === "win32") process.kill(pid, "SIGKILL"); else process.kill(-pid, "SIGKILL"); } catch { /* Already closed. */ }
        if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch { /* Already closed. */ } }
      }
      restoreEnvironment(previous); rmSync(root, { recursive: true, force: true });
    },
  };
}
const nextImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));
function assertPublicProgress(progress: ChatProgress[]) {
  const keys = ["startedAt", "phase", "lastActivityAt", "heartbeatAt", "processRunning"].sort();
  assert.ok(progress.length > 0);
  for (const value of progress) assert.deepEqual(Object.keys(value).sort(), keys);
  assert.ok(!JSON.stringify(progress).includes(sensitive));
}

test("reasoning-only Codex remains active beyond the old three-minute cutoff and never exposes reasoning", { timeout: 10000 }, async (context) => {
  const fixture = childFixture({ retry: true });
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-10-30T00:00:00Z").getTime() });
  const progress: ChatProgress[] = [], deltas: string[] = [];
  let thinking!: () => void;
  const ready = new Promise<void>((resolve) => { thinking = resolve; });
  let settled = false;
  const running = streamCodexChat({ system: "Synthetic test", prompt: "No real model is called.", model: "selected-test-model",
    onDelta: (text) => deltas.push(text), onProgress: (value) => { progress.push(value); if (value.phase === "thinking") thinking(); } });
  running.then(() => { settled = true; }, () => { settled = true; });
  try {
    await ready;
    assert.equal(chatTimeoutMilliseconds(), 0);
    context.mock.timers.tick(180001);
    await nextImmediate();
    assert.equal(settled, false, "real reasoning activity must not be mistaken for a timed-out empty response");
    assert.deepEqual(deltas, []);
    assert.equal(progress.at(-1)?.processRunning, true);
    assert.ok(progress.some((value) => value.phase === "retrying"));
    fixture.finish();
    const result = await running;
    assert.equal(result.text, "Synthetic answer complete");
    assert.deepEqual(deltas, ["Synthetic answer complete"]);
    assert.ok(progress.some((value) => value.phase === "responding"));
    assert.equal(progress.at(-1)?.processRunning, false);
    assertPublicProgress(progress);
    const requests = fixture.requests();
    assert.equal(requests.find((request) => request.method === "turn/start")?.params?.model, "selected-test-model");
    assert.equal(requests.find((request) => request.method === "turn/start")?.params?.effort, undefined);
    const metadata = fixture.metadata();
    assert.ok(metadata.args.includes("features.shell_tool=false"));
    assert.equal(existsSync(metadata.cwd), false, "ephemeral working directory is removed only after the process closes");
  } finally { context.mock.timers.reset(); fixture.cleanup(); }
});

test("a live but silent Codex process stays waiting without fabricating a thinking stage", { timeout: 10000 }, async (context) => {
  const fixture = childFixture({ reasoning: false });
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const controller = new AbortController(), progress: ChatProgress[] = [];
  let waiting!: () => void;
  const ready = new Promise<void>((resolve) => { waiting = resolve; });
  const running = streamCodexChat({ system: "Synthetic", prompt: "Silent fixture", signal: controller.signal, onDelta() {},
    onProgress: (value) => { progress.push(value); if (value.phase === "waiting") waiting(); } });
  const outcome = running.catch((error: unknown) => error);
  try {
    await ready; context.mock.timers.tick(400000); await nextImmediate();
    assert.equal(progress.at(-1)?.phase, "waiting");
    assert.equal(progress.some((value) => value.phase === "thinking"), false);
    assert.equal(progress.at(-1)?.processRunning, true);
    controller.abort();
    const error = await outcome;
    assert.ok(error instanceof Error); assert.match(error.message, /停止/); assert.doesNotMatch(error.message, /已保存/);
    assert.equal(progress.at(-1)?.processRunning, false);
  } finally { controller.abort(); context.mock.timers.reset(); fixture.cleanup(); }
});

test("explicit chat deadlines apply to zero and partial output without a five-minute clamp", { timeout: 10000 }, async (context) => {
  for (const partial of [false, true]) await context.test(partial ? "partial output" : "zero output past five minutes", async (childContext) => {
    const fixture = childFixture({ partial });
    const timeout = partial ? 1250 : 600000;
    process.env.KB_CHAT_TIMEOUT_MS = String(timeout);
    childContext.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const deltas: string[] = [], progress: ChatProgress[] = [];
    let notify!: () => void;
    const ready = new Promise<void>((resolve) => { notify = resolve; });
    let settled = false;
    const running = streamCodexChat({ system: "Synthetic", prompt: "Deadline fixture", onDelta: (text) => deltas.push(text),
      onProgress: (value) => { progress.push(value); if (value.phase === (partial ? "responding" : "thinking")) notify(); } });
    const outcome = running.catch((error: unknown) => { settled = true; return error; });
    try {
      await ready;
      if (!partial) { childContext.mock.timers.tick(300001); await nextImmediate(); assert.equal(settled, false); }
      childContext.mock.timers.tick(partial ? timeout + 1 : timeout - 300000);
      const error = await outcome;
      assert.ok(error instanceof Error); assert.match(error.message, /部署配置的时限/); assert.doesNotMatch(error.message, /已保存/);
      assert.deepEqual(deltas, partial ? ["Partial synthetic answer"] : []);
      assert.equal(progress.at(-1)?.processRunning, false);
      assert.equal(existsSync(fixture.metadata().cwd), false);
    } finally { childContext.mock.timers.reset(); fixture.cleanup(); }
  });
});

test("cancel and unexpected exit close Codex and clean its process lifecycle without leaking diagnostics", { timeout: 10000 }, async (context) => {
  for (const exit of [false, true]) await context.test(exit ? "unexpected process exit" : "active cancellation", async () => {
    const fixture = childFixture({ exit });
    const controller = new AbortController(), progress: ChatProgress[] = [];
    let notify!: () => void;
    const ready = new Promise<void>((resolve) => { notify = resolve; });
    const before = process.listenerCount("exit");
    const running = streamCodexChat({ system: "Synthetic", prompt: "Cleanup fixture", signal: controller.signal, onDelta() {},
      onProgress: (value) => { progress.push(value); if (value.phase === "thinking") notify(); } });
    const outcome = running.catch((error: unknown) => error);
    try {
      await ready; if (!exit) controller.abort();
      const error = await outcome;
      assert.ok(error instanceof Error); assert.ok(!error.message.includes(sensitive));
      assert.equal(progress.at(-1)?.processRunning, false);
      assert.equal(process.listenerCount("exit"), before);
      assert.equal(existsSync(fixture.metadata().cwd), false);
      assertPublicProgress(progress);
      assert.throws(() => process.kill(fixture.metadata().pid, 0), /ESRCH/);
    } finally { controller.abort(); fixture.cleanup(); }
  });
});

test("cancellation escalates to the Codex process group when a wrapper and descendant ignore TERM", { skip: process.platform === "win32", timeout: 10000 }, async (context) => {
  const fixture = childFixture({ descendant: true });
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const controller = new AbortController();
  let notify!: () => void;
  const ready = new Promise<void>((resolve) => { notify = resolve; });
  const running = streamCodexChat({ system: "Synthetic", prompt: "Process-group cleanup fixture", signal: controller.signal, onDelta() {},
    onProgress: (value) => { if (value.phase === "thinking") notify(); } });
  const outcome = running.catch((error: unknown) => error);
  try {
    await ready; controller.abort(); context.mock.timers.tick(1001);
    const error = await outcome;
    assert.ok(error instanceof Error); assert.match(error.message, /停止/);
    const metadata = fixture.metadata();
    assert.throws(() => process.kill(metadata.pid, 0), /ESRCH/);
    for (let i = 0; i < 200; i++) {
      try { process.kill(metadata.descendant!, 0); } catch { break; }
      await nextImmediate();
    }
    assert.throws(() => process.kill(metadata.descendant!, 0), /ESRCH/);
    assert.equal(existsSync(metadata.cwd), false);
  } finally { controller.abort(); context.mock.timers.reset(); fixture.cleanup(); }
});

test("closing a TERM-responsive wrapper still kills a TERM-ignoring descendant with separate pipes", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const fixture = childFixture({ descendant: true, wrapperIgnoresTerm: false });
  const controller = new AbortController();
  let notify!: () => void;
  const ready = new Promise<void>((resolve) => { notify = resolve; });
  const running = streamCodexChat({ system: "Synthetic", prompt: "Wrapper-close cleanup fixture", signal: controller.signal, onDelta() {},
    onProgress: (value) => { if (value.phase === "thinking") notify(); } });
  const outcome = running.catch((error: unknown) => error);
  try {
    await ready; controller.abort();
    const error = await outcome;
    assert.ok(error instanceof Error); assert.match(error.message, /停止/);
    const metadata = fixture.metadata();
    assert.throws(() => process.kill(metadata.pid, 0), /ESRCH/);
    // The request has settled, so a descendant here can no longer rely on the
    // wrapper's eventual close event or its now-cancelled escalation timer.
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(metadata.descendant!, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.throws(() => process.kill(metadata.descendant!, 0), /ESRCH/);
    assert.equal(existsSync(metadata.cwd), false);
  } finally { controller.abort(); fixture.cleanup(); }
});

test("HTTP chat has no default total deadline and reports only confirmed transport activity", async (context) => {
  const previous = originalEnvironment(), originalFetch = globalThis.fetch;
  delete process.env.KB_CHAT_TIMEOUT_MS; process.env.KB_CODEX_TIMEOUT_MS = "100";
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  let source!: ReadableStreamDefaultController<Uint8Array>, signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url, options) => {
    signal = options?.signal;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; } }));
  };
  let notify!: () => void;
  const ready = new Promise<void>((resolve) => { notify = resolve; });
  const progress: ChatProgress[] = [], deltas: string[] = [];
  const running = requestStreamingAI({ provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "synthetic", configured: true, message: "fixture" },
    [{ role: "user", content: "Synthetic fixture" }], (text) => deltas.push(text), undefined,
    (value) => { progress.push(value); if (value.phase === "waiting") notify(); });
  try {
    await ready; context.mock.timers.tick(400000); await nextImmediate();
    assert.equal(signal?.aborted, false);
    assert.equal(progress.at(-1)?.phase, "waiting");
    source.enqueue(new TextEncoder().encode('{"message":{"content":"Synthetic HTTP reply"},"done":true}\n')); source.close();
    assert.equal((await running).text, "Synthetic HTTP reply");
    assert.deepEqual(deltas, ["Synthetic HTTP reply"]);
    assert.ok(progress.every((value) => value.processRunning === null));
    assert.equal(progress.at(-1)?.phase, "responding"); assertPublicProgress(progress);
  } finally { context.mock.timers.reset(); globalThis.fetch = originalFetch; restoreEnvironment(previous); }
});

test("explicit HTTP deadline cancels zero or partial streams and cleans the configured timer", async (context) => {
  for (const partial of [false, true]) await context.test(partial ? "partial output" : "zero output", async (childContext) => {
    const previous = originalEnvironment(), originalFetch = globalThis.fetch;
    process.env.KB_CHAT_TIMEOUT_MS = "1500";
    childContext.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    let notify!: () => void;
    const ready = new Promise<void>((resolve) => { notify = resolve; });
    let capturedSignal: AbortSignal | null | undefined;
    globalThis.fetch = async (_url, options) => {
      capturedSignal = options?.signal;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        if (partial) controller.enqueue(new TextEncoder().encode('{"message":{"content":"Partial HTTP reply"}}\n'));
        capturedSignal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      } }));
    };
    const deltas: string[] = [];
    const running = requestStreamingAI({ provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "synthetic", configured: true, message: "fixture" }, [],
      (text) => { deltas.push(text); if (partial) notify(); }, undefined, (value) => { if (!partial && value.phase === "waiting") notify(); });
    const outcome = running.catch((error: unknown) => error);
    try {
      await ready; childContext.mock.timers.tick(1501);
      const error = await outcome;
      assert.ok(error instanceof Error); assert.match(error.message, /部署配置的时限/); assert.doesNotMatch(error.message, /已保存/);
      assert.equal(capturedSignal?.aborted, true); assert.deepEqual(deltas, partial ? ["Partial HTTP reply"] : []);
    } finally { childContext.mock.timers.reset(); globalThis.fetch = originalFetch; restoreEnvironment(previous); }
  });
});

test("very long explicit deadlines do not overflow Node timers and can be cancelled", (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  let expired = false;
  const cancel = scheduleChatDeadline(2_147_483_647 + 5000, () => { expired = true; });
  context.mock.timers.tick(2_147_483_647); assert.equal(expired, false);
  context.mock.timers.tick(4999); assert.equal(expired, false);
  context.mock.timers.tick(1); assert.equal(expired, true);
  cancel(); expired = false;
  const cancelled = scheduleChatDeadline(600000, () => { expired = true; });
  cancelled(); context.mock.timers.tick(600001); assert.equal(expired, false);
});
