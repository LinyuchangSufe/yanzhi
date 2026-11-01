import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { streamCodexChat } from "../src/lib/ai/codex-stream";
import type { ControlledChatTool } from "../src/lib/ai/controlled-tools";

const tool = (call: ControlledChatTool["call"]): ControlledChatTool => ({ name: "lookup_literature", description: "Synthetic readonly lookup",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }, call });
function server(mode: string, context: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-controlled-tools-")), executable = path.join(root, "server.mjs"), log = path.join(root, "rpc.jsonl");
  const before = process.env.KB_CODEX_BIN;
  writeFileSync(executable, `#!${process.execPath}
import readline from 'node:readline'; import fs from 'node:fs';
const mode=${JSON.stringify(mode)},send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const scope={threadId:'fixture-thread',turnId:'fixture-turn'};
const args=mode==='extra-args'?{query:'synthetic title',import:true}:mode==='oversize-args'?{query:'synthetic title',padding:'x'.repeat(9000)}:mode==='long-query'?{query:'x'.repeat(1001)}:{query:'synthetic title'};
const item={id:'lookup-1',type:'dynamicToolCall',tool:mode==='unknown-tool'?'shell':'lookup_literature',namespace:null,arguments:args,status:'inProgress'};
const batch=new Map(),batchResponses=new Map();
const notify=(method,params)=>send({method,params});
const finish=()=>{notify('item/agentMessage/delta',{...scope,itemId:'answer',delta:'Synthetic metadata answer; nothing downloaded.'});notify('turn/completed',{threadId:scope.threadId,turn:{id:scope.turnId,status:'completed'}});};
for await(const line of readline.createInterface({input:process.stdin})){
 const message=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(message)+'\\n');
 if(message.method==='initialize')send({id:message.id,result:{}});
 if(message.method==='thread/start')send({id:message.id,result:{thread:{id:scope.threadId},model:'synthetic-model'}});
 if(message.method==='turn/start'){
  send({id:message.id,result:{turn:{id:scope.turnId}}});notify('turn/started',{threadId:scope.threadId,turn:{id:scope.turnId}});
  if(mode==='builtin'){notify('item/started',{...scope,item:{type:'commandExecution',id:'shell-1',command:'must never execute'}});continue;}
  if(mode==='mcp'){send({id:'mcp-request',method:'mcpServer/elicitation/request',params:{...scope}});continue;}
  if(mode==='oversize-frame'){send({method:'item/reasoning/textDelta',params:{...scope,delta:'x'.repeat(2100000)}});continue;}
  if(mode==='failed-turn'){
   notify('item/started',{...scope,item});
   notify('turn/completed',{threadId:scope.threadId,turn:{id:scope.turnId,status:'failed',error:{message:'usage_limit_reached PRIVATE_PROVIDER_DIAGNOSTIC'}}});continue;
  }
  if(mode==='multi'||mode==='many'){
   for(let index=0;index<(mode==='many'?13:3);index++){
    const current={...item,id:'batch-'+index,arguments:{query:'synthetic public title '+index}},requestId='batch-request-'+index;
    batch.set(requestId,current);notify('item/started',{...scope,item:current});
    send({id:requestId,method:'item/tool/call',params:{...scope,callId:current.id,namespace:null,tool:current.tool,arguments:current.arguments}});
   }
   continue;
  }
  if(mode!=='missing-start')notify('item/started',{...scope,item});
  send({id:'lookup-request',method:'item/tool/call',params:{...scope,...(mode==='wrong-thread'?{threadId:'another-thread'}:{}),...(mode==='wrong-turn'?{turnId:'another-turn'}:{}),callId:item.id,namespace:mode==='namespace'?'functions':null,tool:item.tool,arguments:args}});
 }
 if(batch.has(message.id)&&message.result){
  batchResponses.set(message.id,message.result);
  if(batchResponses.size===batch.size){
   for(const [requestId,current]of [...batch].reverse())notify('item/completed',{...scope,item:{...current,status:batchResponses.get(requestId).success?'completed':'failed'}});
   finish();
  }
 }
 if(message.id==='lookup-request'&&message.result){
  notify('item/completed',{...scope,item:{...item,status:message.result.success?'completed':'failed'}});
  if(mode==='replay'){send({id:'replayed-request',method:'item/tool/call',params:{...scope,callId:item.id,namespace:null,tool:item.tool,arguments:args}});continue;}
  finish();
 }
}
`);
  chmodSync(executable, 0o700); process.env.KB_CODEX_BIN = executable;
  const abort = new AbortController(), runs: Promise<unknown>[] = [];
  let cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= (async () => {
    abort.abort(); await Promise.allSettled(runs);
    if (before === undefined) delete process.env.KB_CODEX_BIN; else process.env.KB_CODEX_BIN = before;
    rmSync(root, { recursive: true, force: true });
  })();
  context.after(cleanup);
  return { requests: () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>),
    stream: (input: Parameters<typeof streamCodexChat>[0]) => {
      const running = streamCodexChat({ ...input, signal: AbortSignal.any([context.signal, abort.signal, ...(input.signal ? [input.signal] : [])]) });
      runs.push(running); return running;
    }, cleanup };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("only an explicitly injected lookup executes, with the generated dynamic-tool spec and bounded text response", { timeout: 15000 }, async context => {
  const fixture = server("allowed", context); let called = 0;
  try {
    const result = await fixture.stream({ system: "Synthetic", prompt: "No AI call", onDelta() {}, tools: [tool(async (args, signal) => {
      called++; assert.deepEqual(args, { query: "synthetic title" }); assert.equal(signal.aborted, false);
      return JSON.stringify({ sourceHref: "https://doi.org/10.1234/synthetic", readingScope: "Metadata only; not downloaded" });
    })] });
    assert.equal(called, 1); assert.match(result.text, /nothing downloaded/);
    const messages = fixture.requests(), start = messages.find(message => message.method === "thread/start")!;
    const params = start.params as { dynamicTools: Array<{ type: string; name: string }>; sandbox: string; approvalPolicy: string };
    assert.equal(params.dynamicTools[0].type, "function"); assert.equal(params.dynamicTools[0].name, "lookup_literature");
    assert.equal(params.sandbox, "read-only"); assert.equal(params.approvalPolicy, "never");
    const response = messages.find(message => message.id === "lookup-request")!.result as { success: boolean; contentItems: Array<{type: string; text: string}> };
    assert.equal(response.success, true); assert.equal(response.contentItems[0].type, "inputText");
  } finally { await fixture.cleanup(); }
});

test("default requests and forbidden server requests/items cannot execute any injected callback", { timeout: 60000 }, async context => {
  for (const mode of ["default", "builtin", "mcp", "unknown-tool", "wrong-thread", "wrong-turn", "namespace", "extra-args", "long-query", "oversize-args", "missing-start", "oversize-frame"]) {
    await context.test(mode, { timeout: 15000 }, async childContext => {
      const fixture = server(mode, childContext); let called = 0;
      try {
        await assert.rejects(fixture.stream({ system: "Synthetic", prompt: "No AI", onDelta() {},
          ...(mode === "default" ? {} : { tools: [tool(async () => { called++; return "must not execute"; })] }) }), /工具|传输|格式|停止/);
        assert.equal(called, 0);
      } finally { await fixture.cleanup(); }
    });
  }
});

test("lookup failures and oversized outputs return a safe tool error and allow the model to finish", { timeout: 60000 }, async context => {
  for (const oversized of [false, true]) await context.test(String(oversized), { timeout: 15000 }, async childContext => {
    const fixture = server("allowed", childContext);
    try {
      const result = await fixture.stream({ system: "Synthetic", prompt: "No AI", onDelta() {}, tools: [tool(async () => {
        if (oversized) return "界".repeat(30000); throw new Error("PRIVATE_PROVIDER_DIAGNOSTIC");
      })] });
      assert.match(result.text, /Synthetic/);
      const response = fixture.requests().find(message => message.id === "lookup-request")!.result as { success: boolean; contentItems: Array<{text: string}> };
      assert.equal(response.success, false); assert.match(response.contentItems[0].text, /尚未下载或入库/); assert.doesNotMatch(JSON.stringify(response), /PRIVATE_PROVIDER/);
    } finally { await fixture.cleanup(); }
  });
});

test("replayed calls stop after a single execution", { timeout: 15000 }, async context => {
  const fixture = server("replay", context); let called = 0;
  try {
    await assert.rejects(fixture.stream({ system: "Synthetic", prompt: "No AI", onDelta() {}, tools: [tool(async () => { called++; return "Synthetic metadata"; })] }), /工具|停止/);
    assert.equal(called, 1);
  } finally { await fixture.cleanup(); }
});

test("stopping during lookup cancels its signal and never sends a late result", { timeout: 15000 }, async context => {
  const fixture = server("allowed", context), controller = new AbortController(); let release!: () => void, toolSignal!: AbortSignal;
  const ready = new Promise<void>(resolve => { release = resolve; });
  try {
    const running = fixture.stream({ system: "Synthetic", prompt: "No AI", signal: controller.signal, onDelta() {}, tools: [tool(async (_args, signal) => {
      toolSignal = signal; release(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return "LATE_RESULT_MUST_NOT_BE_SENT";
    })] });
    await ready; controller.abort(); await assert.rejects(running, /停止/); await tick();
    assert.equal(toolSignal.aborted, true); assert.ok(!JSON.stringify(fixture.requests()).includes("LATE_RESULT"));
  } finally { controller.abort(); await fixture.cleanup(); }
});

test("interleaved native tool requests finish even when completion notifications arrive in reverse order", { timeout: 15000 }, async context => {
  const fixture = server("multi", context); let called = 0, active = 0, maxActive = 0;
  try {
    const result = await fixture.stream({ system: "Synthetic", prompt: "No AI", onDelta() {}, tools: [tool(async () => {
      called++; active++; maxActive = Math.max(maxActive, active); await tick(); active--; return "Synthetic metadata";
    })] });
    assert.match(result.text, /Synthetic metadata answer/); assert.equal(called, 3); assert.equal(maxActive, 1);
    const replies = fixture.requests().filter(message => String(message.id).startsWith("batch-request-") && message.result);
    assert.equal(replies.length, 3); assert.ok(replies.every(message => (message.result as { success: boolean }).success));
  } finally { await fixture.cleanup(); }
});

test("lookup execution budget exhaustion returns a tool error and preserves the final answer", { timeout: 15000 }, async context => {
  const fixture = server("many", context); let called = 0;
  try {
    const result = await fixture.stream({ system: "Synthetic", prompt: "No AI", onDelta() {}, tools: [tool(async () => { called++; return "Synthetic metadata"; })] });
    const replies = fixture.requests().filter(message => String(message.id).startsWith("batch-request-") && message.result);
    assert.equal(called, 12); assert.equal(replies.length, 13);
    assert.equal(replies.filter(message => (message.result as { success: boolean }).success).length, 12);
    const exhausted = replies.find(message => !(message.result as { success: boolean }).success)!.result as { contentItems: Array<{ text: string }> };
    assert.ok(exhausted.contentItems[0].text.trim()); assert.match(result.text, /Synthetic metadata answer/);
  } finally { await fixture.cleanup(); }
});

test("a failed turn reports its upstream reason even with an unfinished tool item", { timeout: 15000 }, async context => {
  const fixture = server("failed-turn", context); let called = 0;
  try {
    await assert.rejects(fixture.stream({ system: "Synthetic", prompt: "No AI", onDelta() {}, tools: [tool(async () => { called++; return "must not execute"; })] }), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /额度|频繁/);
      assert.doesNotMatch(error.message, /文献工具|PRIVATE_PROVIDER/); assert.equal((error as { status?: number }).status, 429); return true;
    });
    assert.equal(called, 0);
  } finally { await fixture.cleanup(); }
});
