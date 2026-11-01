import assert from "node:assert/strict";
import test from "node:test";
import { createControlledToolSession, type ControlledChatTool } from "../src/lib/ai/controlled-tools";

const scope = { threadId: "synthetic-thread", turnId: "synthetic-turn" };
const argumentsFor = (query = "synthetic public title") => ({ query });
const item = (id: string, status = "inProgress", query?: string) => ({ ...scope,
  item: { type: "dynamicToolCall", id, namespace: null, tool: "lookup_literature", arguments: argumentsFor(query), status } });
const request = (callId: string, query?: string) => ({ ...scope, callId, namespace: null, tool: "lookup_literature", arguments: argumentsFor(query) });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type ToolResponse = { id: string | number; result: { success: boolean; contentItems: Array<{ type: string; text: string }> } };
function fixture(call: ControlledChatTool["call"] = async () => "Synthetic metadata") {
  const controller = new AbortController(), responses: ToolResponse[] = [], errors: Error[] = [];
  const tool: ControlledChatTool = { name: "lookup_literature", description: "Synthetic readonly lookup",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }, call };
  const session = createControlledToolSession([tool], () => scope, controller.signal,
    value => responses.push(value as ToolResponse), error => errors.push(error));
  return { session, controller, responses, errors };
}
async function waitForResponses(responses: ToolResponse[], count: number) {
  for (let index = 0; index < 20 && responses.length < count; index++) await tick();
  assert.equal(responses.length, count, "each accepted RPC receives exactly one bounded tool result");
}

test("independent tool lifecycles queue interleaved requests and tolerate reverse completion order", async () => {
  const gate = deferred<string>(), executed: string[] = [];
  let active = 0, maxActive = 0;
  const f = fixture(async args => {
    const query = (args as { query: string }).query;
    executed.push(query); active++; maxActive = Math.max(maxActive, active);
    const result = executed.length === 1 ? await gate.promise : "Synthetic metadata";
    active--; return result;
  });
  try {
    for (const id of ["a", "b", "c", "d"]) f.session.started(item(id, "inProgress", `public title ${id}`));
    assert.throws(() => f.session.assertIdle(), /工具|停止/);
    for (const id of ["c", "a", "d", "b"]) f.session.handleRequest(`rpc-${id}`, request(id, `public title ${id}`));
    await tick(); assert.deepEqual(executed, ["public title c"]); assert.equal(f.responses.length, 0);
    gate.resolve("Synthetic metadata"); await waitForResponses(f.responses, 4);
    assert.deepEqual(executed, ["public title c", "public title a", "public title d", "public title b"]);
    assert.deepEqual(f.responses.map(response => response.id), ["rpc-c", "rpc-a", "rpc-d", "rpc-b"]);
    assert.equal(maxActive, 1); assert.ok(f.responses.every(response => response.result.success));
    assert.throws(() => f.session.assertIdle(), /工具|停止/, "responded calls remain tracked until their completion notifications");
    for (const id of ["b", "d", "a", "c"]) f.session.completed(item(id, "completed", `public title ${id}`));
    f.session.assertIdle(); assert.deepEqual(f.errors, []);
  } finally { gate.resolve("Synthetic metadata"); f.session.dispose(); }
});

test("the same query may retry under a new call ID before the previous completion notification", async () => {
  let executed = 0;
  const f = fixture(async () => { executed++; return "Synthetic metadata"; });
  try {
    f.session.started(item("first")); f.session.handleRequest("rpc-first", request("first"));
    await waitForResponses(f.responses, 1);
    f.session.started(item("retry")); f.session.handleRequest("rpc-retry", request("retry"));
    await waitForResponses(f.responses, 2);
    f.session.completed(item("retry", "completed")); f.session.completed(item("first", "completed"));
    f.session.assertIdle(); assert.equal(executed, 2); assert.deepEqual(f.errors, []);
  } finally { f.session.dispose(); }
});

test("the thirteenth lookup receives a soft budget result without executing or failing the session", async () => {
  let executed = 0;
  const f = fixture(async () => { executed++; return "Synthetic metadata"; });
  try {
    for (let index = 0; index < 13; index++) {
      f.session.started(item(String(index)));
      f.session.handleRequest(`rpc-${index}`, request(String(index)));
    }
    await waitForResponses(f.responses, 13);
    assert.equal(executed, 12); assert.equal(f.responses.filter(response => response.result.success).length, 12);
    const exhausted = f.responses.find(response => !response.result.success)!;
    assert.equal(exhausted.id, "rpc-12"); assert.equal(exhausted.result.contentItems[0].type, "inputText");
    assert.ok(exhausted.result.contentItems[0].text.trim()); assert.ok(Buffer.byteLength(exhausted.result.contentItems[0].text) <= 65536);
    for (const response of f.responses) f.session.completed(item(String(response.id).slice(4), response.result.success ? "completed" : "failed"));
    f.session.assertIdle(); assert.deepEqual(f.errors, []);
  } finally { f.session.dispose(); }
});

test("cancelling or disposing a pending lookup discards queued work and late results", async context => {
  for (const action of ["abort", "dispose"] as const) await context.test(action, async () => {
    const gate = deferred<string>(), executed: string[] = [];
    let lookupSignal!: AbortSignal;
    const f = fixture(async (args, signal) => { executed.push((args as { query: string }).query); lookupSignal = signal; return gate.promise; });
    try {
      for (const id of ["pending", "queued-a", "queued-b"]) {
        f.session.started(item(id, "inProgress", `public title ${id}`));
        f.session.handleRequest(`rpc-${id}`, request(id, `public title ${id}`));
      }
      await tick(); assert.deepEqual(executed, ["public title pending"]);
      if (action === "abort") f.controller.abort(); else f.session.dispose();
      assert.equal(lookupSignal.aborted, true);
      gate.resolve("LATE_RESULT_MUST_NOT_BE_SENT"); await tick(); await tick();
      assert.deepEqual(executed, ["public title pending"]); assert.deepEqual(f.responses, []); assert.deepEqual(f.errors, []);
    } finally { gate.resolve("LATE_RESULT_MUST_NOT_BE_SENT"); f.session.dispose(); }
  });
});

test("a scope violation aborts pending and queued lookups before any late response", async () => {
  const gate = deferred<string>(); let executed = 0, lookupSignal!: AbortSignal;
  const f = fixture(async (_args, signal) => { executed++; lookupSignal = signal; return gate.promise; });
  try {
    f.session.started(item("pending")); f.session.handleRequest("rpc-pending", request("pending"));
    f.session.started(item("queued")); f.session.handleRequest("rpc-queued", request("queued"));
    await tick(); assert.equal(executed, 1);
    f.session.handleRequest("rpc-invalid", { ...request("queued"), threadId: "another-thread" });
    assert.equal(f.errors.length, 1); assert.equal(lookupSignal.aborted, true);
    assert.deepEqual((f.errors[0] as { details?: unknown }).details, { code: "LITERATURE_TOOL_PROTOCOL", reason: "scope" });
    assert.doesNotMatch(JSON.stringify(f.errors[0]), /synthetic public title/);
    gate.resolve("LATE_RESULT_MUST_NOT_BE_SENT"); await tick(); await tick();
    assert.equal(executed, 1); assert.deepEqual(f.responses, []); assert.equal(f.errors.length, 1);
  } finally { gate.resolve("LATE_RESULT_MUST_NOT_BE_SENT"); f.session.dispose(); }
});

test("parallel support retains per-call, request ID and parameter replay protection", async context => {
  for (const mode of ["duplicate-start", "duplicate-request", "request-id", "arguments", "completion-arguments", "premature-completion"] as const) {
    await context.test(mode, async () => {
      let executed = 0;
      const f = fixture(async () => { executed++; return "Synthetic metadata"; });
      try {
        f.session.started(item("first"));
        if (mode === "duplicate-start") {
          assert.throws(() => f.session.started(item("first")), /工具|停止/); assert.equal(executed, 0); return;
        }
        if (mode === "premature-completion") {
          assert.throws(() => f.session.completed(item("first", "completed")), /工具|停止/); assert.equal(executed, 0); return;
        }
        if (mode === "arguments") {
          f.session.handleRequest("rpc-first", request("first", "different public title"));
          assert.equal(f.errors.length, 1); assert.equal(executed, 0); return;
        }
        f.session.handleRequest("rpc-first", request("first")); await waitForResponses(f.responses, 1);
        if (mode === "duplicate-request") f.session.handleRequest("rpc-again", request("first"));
        if (mode === "request-id") { f.session.started(item("second")); f.session.handleRequest("rpc-first", request("second")); }
        if (mode === "completion-arguments") assert.throws(() => f.session.completed(item("first", "completed", "different public title")), /工具|停止/);
        else assert.equal(f.errors.length, 1);
        assert.equal(executed, 1);
      } finally { f.session.dispose(); }
    });
  }
});

test("unfinished turns and excessive registered call IDs remain bounded", () => {
  const f = fixture();
  try {
    for (let index = 0; index < 64; index++) f.session.started(item(String(index)));
    assert.throws(() => f.session.started(item("overflow")), /工具|停止/);
    assert.throws(() => f.session.assertIdle(), /工具|停止/); assert.deepEqual(f.responses, []);
  } finally { f.session.dispose(); }
});
