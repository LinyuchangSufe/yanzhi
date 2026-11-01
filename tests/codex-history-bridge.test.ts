import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexHistoryBridge } from "../src/lib/codex-import/bridge";
import { createReadOnlyTransport, historyEnvironment, historyMethods, HistoryRpcError, type HistoryMethod, type HistoryTransport } from "../src/lib/codex-import/protocol";
import type { CodexSource } from "../src/lib/codex-import/types";
import { StoreError } from "../src/lib/store-error";

const secret = "PRIVATE_REASONING_TOOL_OUTPUT_OR_DIAGNOSTIC_MUST_NOT_ESCAPE";
const threadId = "019a4000-0000-7000-8000-000000000001";
const source: CodexSource = { id: "fixture-profile", label: "Synthetic local profile", host: "fixture-host", home: "/tmp/synthetic-codex-profile", sqliteHome: null, binary: "fake-codex" };
const metadata = { id: threadId, name: "Public discussion title", cwd: "/synthetic/project", createdAt: 1760000000, updatedAt: 1760000100, historyMode: "paginated", preview: secret, path: secret };
const user = (itemId: string, value: string) => ({ type: "userMessage", id: itemId, content: [{ type: "text", text: value }, { type: "localImage", path: secret }] });
const assistant = (itemId: string, value: string) => ({ type: "agentMessage", id: itemId, text: value, memoryCitation: secret });
const turn = (turnId: string, items: unknown[] = [], itemsView = "full") => ({ id: turnId, status: "completed", startedAt: 1760000001, itemsView, items });
type Request = { method: HistoryMethod; params: Record<string, unknown> };
function mocked(run: (request: Request) => unknown, options: Parameters<typeof createCodexHistoryBridge>[0] = {}) {
  const calls: Request[] = [];
  let closed = 0;
  const transport: HistoryTransport = {
    async request(method, params) {
      const request = { method, params }; calls.push(request);
      if (method === "initialize") return { codexHome: source.home };
      if (method === "thread/read" && params.includeTurns === false) return { thread: metadata };
      return run(request);
    },
    async close() { closed++; },
  };
  return { bridge: createCodexHistoryBridge({ source, open: () => transport, ...options }), calls, closed: () => closed };
}

test("thread list uses only the state index and explicit interactive sources; returned metadata excludes previews and paths", async () => {
  const fixture = mocked(({ method }) => { assert.equal(method, "thread/list"); return { data: [metadata], nextCursor: "next-page" }; });
  const result = await fixture.bridge.listCodexThreads({ search: "Public", cwd: "/synthetic/project", cursor: "previous" });
  assert.equal(result.data[0]?.title, metadata.name);
  assert.equal(result.nextCursor, "next-page");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(fixture.calls[1]?.params, { limit: 40, sortKey: "updated_at", sortDirection: "desc", sourceKinds: ["cli", "vscode", "appServer"], useStateDbOnly: true, archived: false, cursor: "previous", searchTerm: "Public", cwd: "/synthetic/project" });
  assert.equal(fixture.closed(), 1);
});

test("all turn and item pages are read; only public user and assistant text keeps stable item and turn IDs", async () => {
  const fixture = mocked(({ method, params }) => {
    if (method === "thread/turns/list") return params.cursor ? { data: [turn("turn-2", [], "summary")], nextCursor: null } : {
      data: [turn("turn-1", [user("u-1", "Public question"), { type: "reasoning", id: "r", content: secret }, { type: "hookPrompt", id: "h", fragments: secret }, { type: "functionCallOutput", id: "f", output: secret }, assistant("a-1", "Public answer")])], nextCursor: "second-turn-page" };
    assert.equal(method, "thread/items/list"); assert.equal(params.turnId, "turn-2");
    return params.cursor ? { data: [{ turnId: "turn-2", item: assistant("a-2", "Second answer") }], nextCursor: null }
      : { data: [{ turnId: "turn-2", item: user("u-2", "Second question") }], nextCursor: "second-item-page" };
  });
  const result = await fixture.bridge.readCodexHistory(threadId);
  assert.equal(result.complete, true); assert.equal(result.protocol, "paginated");
  assert.deepEqual(result.turns.map((item) => item.messages), [
    [{ id: "u-1", turnId: "turn-1", role: "user", text: "Public question" }, { id: "a-1", turnId: "turn-1", role: "assistant", text: "Public answer" }],
    [{ id: "u-2", turnId: "turn-2", role: "user", text: "Second question" }, { id: "a-2", turnId: "turn-2", role: "assistant", text: "Second answer" }],
  ]);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.ok(fixture.calls.every((call) => historyMethods.includes(call.method)));
  assert.equal(fixture.calls.filter((call) => call.method === "thread/read" && call.params.includeTurns === false).length, 2, "metadata is rechecked after pagination for concurrent changes");
  assert.equal(fixture.closed(), 1);
});

test("only an unavailable initial turns method allows bounded legacy hydration; paginated threads refuse fallback", async () => {
  let closed = 0;
  const calls: Request[] = [];
  const legacy = { ...metadata, historyMode: "legacy" };
  const transport: HistoryTransport = { async request(method, params) {
    calls.push({ method, params });
    if (method === "initialize") return {};
    if (method === "thread/turns/list") throw new HistoryRpcError(-32601);
    if (method === "thread/read") return { thread: { ...legacy, turns: params.includeTurns ? [turn("old-turn", [user("old-user", "Legacy question"), assistant("old-agent", "Legacy answer")])] : [] } };
    throw new Error("Unexpected method");
  }, async close() { closed++; } };
  const result = await createCodexHistoryBridge({ source, open: () => transport }).readCodexHistory(threadId);
  assert.equal(result.protocol, "legacy"); assert.equal(result.turns.length, 1); assert.equal(closed, 1);
  assert.equal(calls.filter((call) => call.params.includeTurns === true).length, 1);
  const paginated = mocked(() => { throw new HistoryRpcError(-32601); });
  await assert.rejects(paginated.bridge.readCodexHistory(threadId), HistoryRpcError);
  assert.equal(paginated.calls.some((call) => call.params.includeTurns === true), false);
});

test("item paging failures never downgrade to legacy, other RPC failures never trigger hydration", async () => {
  const fixture = mocked(({ method }) => {
    if (method === "thread/turns/list") return { data: [turn("turn-1", [], "summary")], nextCursor: null };
    throw new HistoryRpcError(-32601);
  });
  await assert.rejects(fixture.bridge.readCodexHistory(threadId), HistoryRpcError);
  assert.equal(fixture.calls.some((call) => call.params.includeTurns === true), false);
  const failure = mocked(() => { throw new HistoryRpcError(-32000); });
  await assert.rejects(failure.bridge.readCodexHistory(threadId), HistoryRpcError);
  assert.equal(failure.calls.some((call) => call.params.includeTurns === true), false);
});

test("limits, repeated cursors and duplicate identities produce explicit errors instead of partial histories", async () => {
  const limited = mocked(() => ({ data: [turn("one"), turn("two")], nextCursor: null }), { maxTurns: 1 });
  await assert.rejects(limited.bridge.readCodexHistory(threadId), (error: unknown) => error instanceof StoreError && error.status === 413);
  const looping = mocked(() => ({ data: [], nextCursor: "same-cursor" }));
  await assert.rejects(looping.bridge.readCodexHistory(threadId), /分页游标重复/);
  const duplicate = mocked(() => ({ data: [turn("one", [user("same", "Question"), assistant("same", "Answer")])], nextCursor: null }));
  await assert.rejects(duplicate.bridge.readCodexHistory(threadId), /重复条目/);
  const oversized = mocked(() => ({ data: [turn("one", [assistant("answer", "Text longer than two bytes")])], nextCursor: null }), { maxTextBytes: 2 });
  await assert.rejects(oversized.bridge.readCodexHistory(threadId), StoreError);
  assert.equal(limited.closed(), 1); assert.equal(looping.closed(), 1); assert.equal(duplicate.closed(), 1); assert.equal(oversized.closed(), 1);
});

test("source metadata changed during paging is rejected, not labeled as a coherent snapshot", async () => {
  let reads = 0;
  const bridge = createCodexHistoryBridge({ source, open: () => ({ async request(method) {
    if (method === "initialize") return {};
    if (method === "thread/read") return { thread: { ...metadata, updatedAt: metadata.updatedAt + (reads++ ? 1 : 0) } };
    return { data: [], nextCursor: null };
  }, async close() {} }) });
  await assert.rejects(bridge.readCodexHistory(threadId), /读取期间有更新/);
});

function childFixture(options: { hanging?: boolean; descendant?: boolean; broken?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-history-bridge-"));
  const binary = path.join(root, "fake-codex.mjs"), log = path.join(root, "requests.jsonl"), pids = path.join(root, "processes.json");
  writeFileSync(binary, `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';import {spawn} from 'node:child_process';
const options=${JSON.stringify(options)},info={pid:process.pid,args:process.argv.slice(2),home:process.env.HOME,codexHome:process.env.CODEX_HOME,sqliteHome:process.env.CODEX_SQLITE_HOME};
if(options.descendant){const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore']});await new Promise(resolve=>child.stdout.once('data',resolve));info.descendant=child.pid;child.stdout.destroy();}
fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify(info));
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
for await(const line of readline.createInterface({input:process.stdin})){
 const request=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(request)+'\\n');
 if(request.method==='initialize')send({id:request.id,result:{codexHome:'/tmp/synthetic-codex-profile'}});
 if(request.method==='thread/list'&&!options.hanging){if(options.broken){process.stderr.write(${JSON.stringify(secret)});process.exit(9);}send({id:request.id,result:{data:[],nextCursor:null}});}
}
`);
  chmodSync(binary, 0o700);
  return { binary, root, requests: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> }) : [],
    processes: () => JSON.parse(readFileSync(pids, "utf8")) as { pid: number; descendant?: number; args: string[]; home?: string; codexHome?: string; sqliteHome?: string },
    cleanup() { if (existsSync(pids)) { for (const pid of [this.processes().pid, this.processes().descendant]) { if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } } } } rmSync(root, { recursive: true, force: true }); } };
}
async function waitFor(check: () => boolean) {
  const until = Date.now() + 3000;
  while (!check()) { if (Date.now() > until) throw new Error("Synthetic child did not reach expected state"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
function dead(pid: number) { try { process.kill(pid, 0); return false; } catch { return true; } }

test("real stdio transport handshakes, preserves profile environment and sends no config or mutation request", { timeout: 10000 }, async () => {
  const fixture = childFixture();
  const previous = { home: process.env.CODEX_HOME, sqlite: process.env.CODEX_SQLITE_HOME };
  process.env.CODEX_HOME = "/tmp/synthetic-codex-profile"; process.env.CODEX_SQLITE_HOME = "/tmp/synthetic-codex-state";
  try {
    const bridge = createCodexHistoryBridge({ source: { ...source, binary: fixture.binary } });
    await bridge.listCodexThreads();
    assert.deepEqual(fixture.requests().map((request) => request.method), ["initialize", "initialized", "thread/list"]);
    assert.deepEqual(fixture.processes().args, ["app-server", "--listen", "stdio://"]);
    assert.equal(fixture.processes().home, process.env.HOME);
    assert.equal(fixture.processes().codexHome, process.env.CODEX_HOME);
    assert.equal(fixture.processes().sqliteHome, process.env.CODEX_SQLITE_HOME);
    assert.equal(historyEnvironment().CODEX_SQLITE_HOME, process.env.CODEX_SQLITE_HOME);
    await waitFor(() => dead(fixture.processes().pid));
  } finally {
    if (previous.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.home;
    if (previous.sqlite === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = previous.sqlite;
    fixture.cleanup();
  }
});

test("runtime method allowlist rejects inference even with a cast; close sweeps a TERM-ignoring descendant", { timeout: 10000 }, async () => {
  const fixture = childFixture({ descendant: process.platform !== "win32" });
  const transport = createReadOnlyTransport(undefined, { binary: fixture.binary });
  try {
    await transport.request("initialize", {});
    await assert.rejects(transport.request("turn/start" as HistoryMethod, {}), (error: unknown) => error instanceof StoreError && error.status === 403);
    await transport.close();
    assert.equal(fixture.requests().some((request) => request.method === "turn/start"), false);
    const descendant = fixture.processes().descendant;
    if (descendant) await waitFor(() => dead(descendant));
  } finally { await transport.close(); fixture.cleanup(); }
});

test("cancel and deadline terminate the read connection; raw exit diagnostics are never reported", { timeout: 10000 }, async () => {
  const hanging = childFixture({ hanging: true }), broken = childFixture({ broken: true });
  try {
    const controller = new AbortController();
    const reading = createCodexHistoryBridge({ source, open: (signal) => createReadOnlyTransport(signal, { binary: hanging.binary }) }).listCodexThreads({}, controller.signal);
    await waitFor(() => hanging.requests().some((request) => request.method === "thread/list"));
    controller.abort();
    await assert.rejects(reading, (error: unknown) => error instanceof StoreError && error.status === 499);
    await waitFor(() => dead(hanging.processes().pid));
    const transport = createReadOnlyTransport(undefined, { binary: hanging.binary, timeoutMs: 30 });
    try { await assert.rejects(transport.request("initialize", {}), (error: unknown) => error instanceof StoreError && error.status === 504); }
    finally { await transport.close(); }
    await assert.rejects(createCodexHistoryBridge({ source: { ...source, binary: broken.binary } }).listCodexThreads(), (error: unknown) => error instanceof StoreError && !error.message.includes(secret));
  } finally { hanging.cleanup(); broken.cleanup(); }
});
