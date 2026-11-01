// Reproducible software QA only: local fake Codex RPC, no real model or research data.
// Run after npm run build: node scripts/chat-runtime-smoke.mjs [--serve]
// While serving: node scripts/chat-runtime-smoke.mjs --complete | --wait | --verify
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
process.chdir(cwd);
const reportPath = "test-results/chat-runtime-smoke.json";
const secret = "PRIVATE_REASONING_MUST_NEVER_REACH_UI";
if (process.argv.some(arg => ["--complete", "--wait", "--verify"].includes(arg))) {
  const fixture = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (process.argv.includes("--complete") || process.argv.includes("--wait")) {
    fs.writeFileSync(fixture.control, process.argv.includes("--complete") ? "complete" : "wait");
    console.log("Synthetic model control updated.");
  } else {
    const state = await (await fetch(fixture.base + "/api/kb")).json();
    const chats = state.ideaConversations.filter(item => item.noteId === fixture.noteId);
    assert.ok(chats.length > 0);
    const messages = chats.flatMap(item => item.messages);
    const completed = messages.filter(item => item.role === "assistant" && item.status === "completed");
    assert.ok(completed.some(item => item.model === "fixture-deep"));
    assert.ok(completed.some(item => item.model === "fixture-fast"));
    assert.ok(messages.some(item => item.role === "assistant" && item.status === "cancelled" && !item.body));
    assert.ok(!JSON.stringify(chats).includes(secret));
    assert.equal(state.notes.find(item => item.id === fixture.noteId).body, fixture.originalBody);
    assert.deepEqual(state.settings, fixture.settings);
    const runs = fs.readFileSync(fixture.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const requestedModels = runs.filter(item => item.method === "turn/start").map(item => item.model);
    assert.deepEqual(requestedModels.slice(0, 3), ["fixture-deep", "fixture-deep", "fixture-fast"], "retry keeps the original model; a new question uses the changed selection");
    for (const run of runs.filter(item => item.method === "turn/start")) {
      let alive = false; try { process.kill(run.pid, 0); alive = true; } catch {}
      assert.equal(alive, false, "each completed/cancelled fake Codex process must be closed");
    }
    const proof = { timestamp: new Date().toISOString(), result: "passed", ai: fixture.ai,
      checks: ["genuine RPC activity and server heartbeat displayed independently", "elapsed duration increases before any answer text", "stop before text preserves question and closes process", "per-question model reaches Codex", "notes and global settings unchanged", "private reasoning absent from messages"],
      messages: messages.length, requestedModels, completedModels: completed.map(item => item.model) };
    fs.writeFileSync("test-results/chat-runtime-browser.json", JSON.stringify(proof, null, 2) + "\n");
    console.log(JSON.stringify(proof, null, 2));
  }
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-chat-runtime-"));
const control = path.join(root, "control"), log = path.join(root, "rpc.jsonl");
const executable = path.join(root, "fake-codex.mjs");
const base = `http://127.0.0.1:${Number(process.env.KB_CHAT_SMOKE_PORT || 3135)}`;
fs.writeFileSync(control, "wait");
fs.writeFileSync(executable, `#!${process.execPath}
import fs from 'node:fs'; import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const notify = (method,params) => send({method,params});
let selected = 'fixture-deep';
for await (const line of readline.createInterface({input:process.stdin})) {
 const request = JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,method:request.method,model:request.params?.model})+'\\n');
 if(request.method==='initialize')send({id:request.id,result:{}});
 if(request.method==='model/list')send({id:request.id,result:{data:[{model:'fixture-deep',displayName:'软件验收 · 深度模型'},{model:'fixture-fast',displayName:'软件验收 · 快速模型'}]}});
 if(request.method==='thread/start'){ selected=request.params.model||selected;send({id:request.id,result:{thread:{id:'synthetic-thread'},model:selected}}); }
 if(request.method==='turn/start'){
  selected=request.params.model||selected;
  const common={threadId:'synthetic-thread',turnId:'synthetic-turn',itemId:'synthetic-item'};
  send({id:request.id,result:{turn:{id:'synthetic-turn'}}});
  notify('turn/started',{threadId:common.threadId,turn:{id:common.turnId}});
  notify('item/started',{...common,item:{id:common.itemId,type:'reasoning'}});
  const activity=setInterval(()=>notify('item/reasoning/summaryTextDelta',{...common,delta:${JSON.stringify(secret)}}),2000);
  const poll=setInterval(()=>{
   if(fs.readFileSync(${JSON.stringify(control)},'utf8')!=='complete')return;
   clearInterval(activity);clearInterval(poll);
   const text='【软件验收合成回复，非真实科研结论】本轮模型：'+selected+'。运行状态、停止和模型选择已收到合成输入。';
   notify('item/agentMessage/delta',{...common,delta:text});
   notify('item/completed',{...common,item:{id:common.itemId,type:'agentMessage',text}});
   notify('turn/completed',{threadId:common.threadId,turn:{id:common.turnId,status:'completed'}});
  },200);
 }
}
`);
fs.chmodSync(executable, 0o700);
let child, logs = "";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exit = new Promise(resolve => child.once("exit", resolve));
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await Promise.race([exit, pause(4000)]);
  if (child.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} await exit; }
}
try {
  child = spawn(process.execPath, ["scripts/serve.mjs", "start"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: new URL(base).port, KB_DATA_DIR: path.join(root, "library"), KB_AI_PROVIDER: "codex", KB_CODEX_BIN: executable,
      KB_CODEX_MODEL: "fixture-deep", KB_CHAT_TIMEOUT_MS: "0", NEXT_TELEMETRY_DISABLED: "1" } });
  for (const output of [child.stdout, child.stderr]) output.on("data", data => { logs = (logs + data).slice(-8000); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base + "/api/kb", { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await pause(200);
  }
  assert.equal(ready, true, logs);
  const originalBody = "# 软件验收原稿\n\n我的独立笔记，在等待 AI 时应继续保留。";
  const response = await fetch(base + "/api/kb", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "note.create", payload: { title: "TEST · 运行状态与模型选择", purpose: "idea", body: originalBody } }) });
  const created = await response.json(); assert.equal(response.status, 200, JSON.stringify(created));
  const catalog = await (await fetch(base + "/api/kb/chat/models")).json();
  assert.deepEqual(catalog.models.map(item => item.id), ["fixture-deep", "fixture-fast"]);
  const fixture = { timestamp: new Date().toISOString(), baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ai: "local fake Codex RPC only; no external inference or research data", base, root, control, log,
    noteId: created.result.id, originalBody, settings: created.state.settings, catalog: "passed" };
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(fixture, null, 2) + "\n");
  console.log(JSON.stringify(fixture, null, 2));
  if (process.argv.includes("--serve")) await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
} finally {
  await stop();
  if (fs.existsSync(log)) for (const line of fs.readFileSync(log, "utf8").trim().split("\n")) {
    const run = JSON.parse(line); try { process.kill(-run.pid, "SIGKILL"); } catch {}
  }
  fs.rmSync(root, { recursive: true, force: true });
}
