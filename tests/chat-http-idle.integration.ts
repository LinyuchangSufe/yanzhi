// Deliberately separate from *.test.ts: this test opens only a loopback server.
// Run: node --import tsx --test tests/chat-http-idle.integration.ts
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import test from "node:test";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { requestStreamingAI } from "../src/lib/ai/request";

function causeCode(value: unknown): string {
  for (let depth = 0; depth < 8 && value && typeof value === "object"; depth++) {
    if ("code" in value && typeof value.code === "string") return value.code;
    value = "cause" in value ? value.cause : undefined;
  }
  return "";
}

async function localFixture(run: (base: string) => Promise<void>) {
  const previousTimeout = process.env.KB_CHAT_TIMEOUT_MS;
  delete process.env.KB_CHAT_TIMEOUT_MS;
  const originalDispatcher = getGlobalDispatcher();
  // Shorten only the test's global control transport. The product must bypass
  // this headers/body idle policy with its request-owned unlimited dispatcher.
  const controlDispatcher = new Agent({ headersTimeout: 100, bodyTimeout: 100 });
  setGlobalDispatcher(controlDispatcher);
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    request.resume();
    const bodyDelay = request.url?.startsWith("/body");
    if (bodyDelay) {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.flushHeaders();
      response.write('{"message":{"content":"Synthetic partial"}}\n');
    }
    const timer = setTimeout(() => {
      if (!bodyDelay) response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(JSON.stringify({ message: { content: bodyDelay ? " reply" : "Synthetic reply" }, done: true }) + "\n");
    }, 1200);
    response.once("close", () => clearTimeout(timer));
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    if (previousTimeout === undefined) delete process.env.KB_CHAT_TIMEOUT_MS; else process.env.KB_CHAT_TIMEOUT_MS = previousTimeout;
    setGlobalDispatcher(originalDispatcher);
    await controlDispatcher.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const config = (endpoint: string) => ({ provider: "ollama", endpoint, model: "synthetic-local-fixture", configured: true, message: "fixture" });

test("real Node fetch times out on slow headers while streaming chat's private dispatcher keeps waiting", { timeout: 10000 }, async () => {
  await localFixture(async (base) => {
    await assert.rejects(fetch(`${base}/headers/api/chat`).then((response) => response.text()), (error: unknown) => causeCode(error) === "UND_ERR_HEADERS_TIMEOUT");
    const deltas: string[] = [];
    const result = await requestStreamingAI(config(`${base}/headers`), [{ role: "user", content: "Synthetic local test" }], (delta) => deltas.push(delta));
    assert.equal(result.text, "Synthetic reply"); assert.deepEqual(deltas, ["Synthetic reply"]);
    // The override is scoped to chat: ordinary fetch still uses the control timeout.
    await assert.rejects(fetch(`${base}/headers/api/chat`).then((response) => response.text()), (error: unknown) => causeCode(error) === "UND_ERR_HEADERS_TIMEOUT");
  });
});

test("real Node fetch times out between body chunks while streaming chat receives the delayed remainder", { timeout: 10000 }, async () => {
  await localFixture(async (base) => {
    await assert.rejects(fetch(`${base}/body/api/chat`).then((response) => response.text()), (error: unknown) => causeCode(error) === "UND_ERR_BODY_TIMEOUT");
    const deltas: string[] = [];
    const result = await requestStreamingAI(config(`${base}/body`), [], (delta) => deltas.push(delta));
    assert.equal(result.text, "Synthetic partial reply"); assert.deepEqual(deltas, ["Synthetic partial", " reply"]);
  });
});

test("the explicit chat deadline still aborts actual HTTP with zero or partial output", { timeout: 10000 }, async () => {
  await localFixture(async (base) => {
    process.env.KB_CHAT_TIMEOUT_MS = "80";
    for (const mode of ["headers", "body"]) {
      const deltas: string[] = [];
      await assert.rejects(requestStreamingAI(config(`${base}/${mode}`), [], (delta) => deltas.push(delta)), /部署配置的时限/);
      assert.deepEqual(deltas, mode === "headers" ? [] : ["Synthetic partial"]);
    }
  });
});
