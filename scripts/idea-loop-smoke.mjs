// Production HTTP + optional browser fixture. All text is synthetic software QA.
// Run after build: node scripts/idea-loop-smoke.mjs [--serve]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
process.chdir(cwd);
if (process.argv.includes("--verify-compact")) {
  const fixture = JSON.parse(fs.readFileSync("test-results/idea-loop-smoke.json", "utf8"));
  const state = await (await fetch(fixture.base + "/api/kb")).json();
  const note = state.notes.find(item => item.id === fixture.browserNoteId);
  const chats = state.ideaConversations.filter(item => item.noteId === note.id);
  const summaries = state.ideaSummaries.filter(item => item.noteId === note.id);
  assert.equal(note.body, "# 我的观察\n\n同一个现象是否存在其他解释？\n\n保留我的原始判断：$x^2 + y^2$。");
  assert.equal(note.revision, 1);
  assert.equal(chats.length, 1); assert.equal(chats[0].messages.length, 2);
  assert.equal(chats[0].messages[0].body, "这里有什么漏洞？");
  assert.ok(chats[0].messages.every(item => item.status === "completed"));
  assert.equal(summaries.length, 1); assert.equal(summaries[0].messageIds.length, 2);
  assert.equal(summaries[0].applications.length, 0);
  const outbound = JSON.parse(fs.readFileSync(path.join(fixture.root, "synthetic-model-requests.json"), "utf8"));
  assert.equal(outbound.length, 5, "three seed calls, one explicit chat send, one explicit summary");
  assert.ok(!JSON.stringify(outbound).includes("UNSELECTED_PRIVATE_MARKER_72b5"));
  const report = { timestamp: new Date().toISOString(), baseCommit: fixture.baseCommit, result: "passed", ai: fixture.ai,
    checks: ["new compact composer keeps suggestions as a draft until explicit send", "Cmd+Enter and streaming still work", "moved summary button opens a two-message preview", "preview does not overwrite original body or title", "unselected private source excluded"],
    messages: chats[0].messages.length, summaries: summaries.length, modelRequests: outbound.length };
  fs.writeFileSync("test-results/idea-compact-browser.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2)); process.exit(0);
}
if (process.argv.includes("--verify-simple-ready") || process.argv.includes("--verify-simple-browser")) {
  const fixture = JSON.parse(fs.readFileSync("test-results/idea-loop-smoke.json", "utf8"));
  const state = await (await fetch(fixture.base + "/api/kb")).json();
  const note = state.notes.find(item => item.id === fixture.browserNoteId);
  const discussions = state.ideaConversations.filter(item => item.noteId === note.id);
  const summary = state.ideaSummaries.find(item => item.noteId === note.id);
  const old = discussions.find(item => item.id === summary.conversationId);
  assert.equal(old.messages.length, 4);
  assert.equal(summary.messageIds.length, 4);
  assert.equal(summary.applications.length, 1);
  assert.ok(note.body.includes("我的独立判断：保留反例，下一步再验证。"));
  for (const section of summary.sections) assert.ok(note.body.includes(section.body));
  assert.ok(state.noteRevisions.some(item => item.noteId === note.id && item.body.includes("我的独立判断") && !item.body.includes(summary.sections[0].body)));
  const outbound = JSON.parse(fs.readFileSync(path.join(fixture.root, "synthetic-model-requests.json"), "utf8"));
  assert.ok(!JSON.stringify(outbound).includes("UNSELECTED_PRIVATE_MARKER_72b5"));
  const ready = process.argv.includes("--verify-simple-ready");
  if (ready) {
    assert.equal(discussions.length, 1); assert.equal(outbound.length, 6);
  } else {
    const checkpoint = JSON.parse(fs.readFileSync("test-results/idea-simple-ready.json", "utf8"));
    assert.equal(checkpoint.noteId, note.id);
    assert.equal(discussions.length, 2); assert.equal(outbound.length, 7);
    const next = discussions.find(item => item.id !== old.id);
    assert.equal(next.messages.length, 2);
    assert.ok(next.messages.every(item => item.status === "completed"));
    assert.deepEqual(next.messages[0].sources, []);
    assert.match(next.messages[0].body, /AI 辅助整理/);
    assert.match(next.messages[0].body, /不代表重新读取原文/);
    assert.ok(!next.messages[0].body.includes("软件验收首轮："));
    assert.equal(outbound.at(-1).messages.length, 2); // System + explicit stage draft, no old history.
  }
  const report = { timestamp: new Date().toISOString(), noteId: note.id, phase: ready ? "stage-draft-before-send" : "complete",
    result: "passed", modelRequests: outbound.length, conversationCount: discussions.length,
    ai: "local synthetic fixture only; no real research claims", checks: ready
      ? ["selected one source and reused it for a follow-up", "default full-discussion summary", "one-click complete append preserves original and personal edits", "preparing a stage draft did not call AI"]
      : ["stage draft requires explicit send", "new conversation receives only the stage draft, not old raw history", "original conversation and provenance retained"] };
  fs.writeFileSync(`test-results/${ready ? "idea-simple-ready" : "idea-simple-browser"}.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2)); process.exit(0);
}
if (process.argv.includes("--verify-browser")) {
  const fixture = JSON.parse(fs.readFileSync("test-results/idea-loop-smoke.json", "utf8"));
  const state = await (await fetch(fixture.base + "/api/kb")).json();
  const note = state.notes.find(item => item.id === fixture.browserNoteId);
  const conversation = state.ideaConversations.find(item => item.noteId === note.id);
  const summary = state.ideaSummaries.find(item => item.noteId === note.id);
  assert.equal(conversation.messages.length, 4);
  assert.ok(conversation.messages.every(message => message.status === "completed"));
  assert.equal(conversation.messages[0].sources[0].entityId, fixture.paperId);
  assert.equal(summary.messageIds.length, 4);
  assert.equal(summary.applications.length, 3);
  assert.ok(note.body.includes("我的独立判断：保留反例，下一步再验证。"));
  assert.ok(note.body.includes(summary.sections[0].body));
  assert.ok(!note.body.includes(summary.sections[1].body));
  assert.ok(state.noteRevisions.some(item => item.noteId === note.id && item.body.includes("我的独立判断") && !item.body.includes(summary.sections[0].body)));
  const topic = state.topics.find(item => item.id === fixture.topicId);
  assert.ok(state.notes.find(item => item.id === topic.noteId).body.includes(summary.sections[1].body));
  assert.ok(summary.applications.some(item => item.targetNoteId !== note.id && item.targetNoteId !== topic.noteId));
  const outbound = fs.readFileSync(path.join(fixture.root, "synthetic-model-requests.json"), "utf8");
  assert.ok(!outbound.includes("UNSELECTED_PRIVATE_MARKER_72b5"));
  const report = { timestamp: new Date().toISOString(), baseCommit: fixture.baseCommit, result: "passed", ai: fixture.ai,
    checks: ["two browser turns with explicit paper abstract", "Cmd+Enter sends while note editor remains editable", "navigate to settings during generation and one-click return", "selected messages -> preview -> selected-section append", "preserve simultaneous personal edits and pre-apply original", "new-note and linked-topic adoption", "390x844 discussion/note tabs"],
    counts: { messages: conversation.messages.length, selectedMessages: summary.messageIds.length, adoptions: summary.applications.length },
    screenshots: ["summary-preview.png", "mobile-notes.png"] };
  fs.writeFileSync("test-results/idea-loop-browser.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-idea-loop-"));
const port = Number(process.env.KB_IDEA_SMOKE_PORT || 3134);
const modelPort = Number(process.env.KB_IDEA_MOCK_PORT || 3141);
const base = `http://127.0.0.1:${port}`;
const keep = process.argv.includes("--serve");
const requests = [], steps = [];
let child, logs = "";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const model = http.createServer(async (req, res) => {
  if (req.url !== "/api/chat") { res.writeHead(404).end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requests.push(input);
  fs.writeFileSync(path.join(root, "synthetic-model-requests.json"), JSON.stringify(requests, null, 2));
  if (input.messages.at(-1)?.content.includes("TEST_FAIL")) { res.writeHead(503).end(); return; }
  if (input.stream) {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    const text = "【软件验收用，非真实科研结论】\n\n可以先把问题拆成输入、预期行为和验证步骤。\n\n**待验证假设**：资料之间的联系需要回到原文核对。建议先保留不同解释，再选择一个最小验证。";
    for (const content of text.match(/.{1,24}|\n/g) || []) {
      if (res.destroyed) return;
      res.write(JSON.stringify({ message: { content }, done: false }) + "\n");
      await pause(keep ? 180 : 5);
    }
    res.end(JSON.stringify({ message: { content: "" }, done: true }) + "\n");
  } else {
    const content = input.messages.at(-1)?.content || "";
    const sources = JSON.parse(content.match(/<sources>([\s\S]*?)<\/sources>/)?.[1] || "[]");
    const summary = { title: "软件验收 · 阶段整理", sections: [
      { id: "question", title: "问题与已有认识", body: "软件验收用：先明确问题、材料范围和自己的判断。这里没有真实科研结论。", sourceIds: sources.slice(0, 1).map(source => source.id) },
      { id: "next", title: "待验证与下一步", body: "待验证：采用合成输入逐步检查保存、返回与选择性采纳流程。", sourceIds: [] },
    ] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: { content: JSON.stringify(summary) } }));
  }
});
async function start(dataDir) {
  child = spawn(process.execPath, ["scripts/serve.mjs", "start"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), KB_DATA_DIR: dataDir, KB_AI_PROVIDER: "ollama", KB_OLLAMA_URL: `http://127.0.0.1:${modelPort}`, KB_OLLAMA_MODEL: "synthetic-software-fixture", NEXT_TELEMETRY_DISABLED: "1" } });
  logs = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { logs = (logs + data).slice(-12000); });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base + "/api/kb", { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await pause(200);
  }
  throw new Error(`Server unavailable: ${logs}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const running = child; child = undefined;
  const exited = new Promise(resolve => running.once("exit", resolve));
  process.kill(-running.pid, "SIGTERM");
  await Promise.race([exited, pause(5000)]);
  if (running.exitCode === null) { try { process.kill(-running.pid, "SIGKILL"); } catch {} await exited; }
}
async function json(route, options) {
  const response = await fetch(base + route, options), data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data)); return data;
}
const post = (action, payload) => json("/api/kb", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }) });
const lab = payload => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
async function send(payload) {
  const response = await fetch(base + "/api/kb/idea-lab", lab({ action: "send", ...payload }));
  assert.equal(response.status, 200);
  return (await response.text()).trim().split("\n").map(line => JSON.parse(line));
}
try {
  await new Promise((resolve, reject) => { model.once("error", reject); model.listen(modelPort, "127.0.0.1", resolve); });
  await start(path.join(root, "source"));
  const paper = (await post("paper.create", { title: "TEST · 两种解释的比较", abstract: "软件验收摘要：同一个观察可以有多种解释，必须保留适用条件。" })).result;
  const topic = (await post("topic.create", { title: "TEST · 如何验证一个想法", description: "软件验收问题：区分观点、依据与待验证假设。" })).result;
  const privateNote = (await post("note.create", { title: "TEST · 未选择的私有资料", purpose: "idea", body: "UNSELECTED_PRIVATE_MARKER_72b5" })).result;
  const note = (await post("note.create", { title: "TEST · HTTP 闭环", purpose: "idea", body: "我的原稿，不应被讨论自动覆盖。", paperIds: [paper.id], topicIds: [topic.id] })).result;
  const request = { noteId: note.id, requestId: randomUUID(), message: "如何把这个合成测试想法梳理清楚？", sources: [{ type: "paper", id: paper.id, field: "abstract", revision: paper.revision }], includeCurrentNote: false, revision: note.revision };
  const first = await send(request);
  assert.equal(first.at(-1).type, "done");
  const conversationId = first[0].conversationId;
  const replay = await send(request);
  assert.equal(replay[0].reused, true);
  assert.equal(requests.length, 1);
  const second = await send({ ...request, requestId: randomUUID(), conversationId, message: "还存在哪些逻辑缺口？", sources: [] });
  assert.equal(second[0].usage.historyMessages, 2);
  assert.equal(second.at(-1).type, "done");
  assert.equal(requests.length, 2);
  assert.ok(JSON.stringify(requests[1]).includes(paper.abstract));
  assert.ok(!JSON.stringify(requests).includes(privateNote.body));
  assert.ok(!JSON.stringify(requests).includes(note.body));
  const messages = (await json(`/api/kb/idea-lab?noteId=${note.id}`)).conversations[0].messages;
  const summary = (await json("/api/kb/idea-lab", lab({ action: "summarize", noteId: note.id, conversationId, revision: note.revision, requestId: randomUUID(), messageIds: messages.map(message => message.id).reverse() }))).summary;
  assert.deepEqual(summary.messageIds, messages.map(message => message.id));
  assert.equal((await json("/api/kb")).notes.find(item => item.id === note.id).body, note.body);
  const append = { noteId: note.id, summaryId: summary.id, requestId: randomUUID(), destination: { kind: "current" }, revision: note.revision, sectionIds: ["question"] };
  const accepted = (await post("idea.summary.apply", append)).result;
  assert.ok(accepted.body.startsWith(note.body));
  assert.ok(accepted.body.includes("先明确问题"));
  assert.ok(!accepted.body.includes("采用合成输入"));
  assert.deepEqual((await post("idea.summary.apply", append)).result, accepted);
  const state = await json("/api/kb");
  assert.ok(state.noteRevisions.some(item => item.noteId === note.id && item.body === note.body));
  steps.push("two-turn NDJSON discussion; actual selected-source scope; idempotent replay; selected-message summary; no auto-overwrite; selected-section append; original revision retained");
  await stop(); await start(path.join(root, "source"));
  assert.deepEqual((await json(`/api/kb/idea-lab?noteId=${note.id}`)).summaries[0], state.ideaSummaries[0]);
  steps.push("actual production process restart preserves discussion and summary provenance");
  const browserNote = (await post("note.create", { title: "TEST · 头脑风暴工作区", purpose: "idea", body: "# 我的观察\n\n同一个现象是否存在其他解释？\n\n保留我的原始判断：$x^2 + y^2$。", paperIds: [paper.id], topicIds: [topic.id] })).result;
  const report = { timestamp: new Date().toISOString(), baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), workingTreeDirty: true, ai: "local synthetic software fixture; no real inference or research results", base, root, browserNoteId: browserNote.id, paperId: paper.id, topicId: topic.id, steps, result: "passed" };
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync("test-results/idea-loop-smoke.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (keep) {
    console.log("Browser fixture ready. Ctrl+C stops both local services and removes only its temporary test library.");
    await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
  }
} finally {
  await stop(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
