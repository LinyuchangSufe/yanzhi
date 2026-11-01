// A loopback-only, predefined fake Ollama service for isolated UI acceptance.
// No external requests, model processes, credentials, or real inference.
// Usage: node scripts/selection-ai-mock.mjs --log /private/tmp/kb-selection-ai-XXXXXX/mock-events.jsonl
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

assert.equal(process.argv.length, 4, "Only --log <prepared fixture log> is accepted");
assert.equal(process.argv[2], "--log");
const logPath = process.argv[3];
assert.match(logPath, /^\/private\/tmp\/kb-selection-ai-[A-Za-z0-9_-]+\/mock-events\.jsonl$/);
const dataDir = path.dirname(logPath);
assert.equal(fs.realpathSync(dataDir), dataDir, "Refusing symlinks to another location");
assert.ok(fs.lstatSync(dataDir).isDirectory() && !fs.lstatSync(dataDir).isSymbolicLink());
const markerPath = path.join(dataDir, ".selection-ai-fixture.json");
assert.ok(fs.lstatSync(markerPath).isFile() && !fs.lstatSync(markerPath).isSymbolicLink());
const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
const model = "synthetic-selection-fixture";
assert.equal(marker.type, "TEST MOCK selection AI fixture");
assert.equal(marker.base, "http://127.0.0.1:3126");
assert.equal(marker.modelBase, "http://127.0.0.1:3128");
assert.equal(marker.model, model);
if (fs.existsSync(logPath)) {
  assert.equal(fs.realpathSync(logPath), logPath);
  assert.ok(fs.lstatSync(logPath).isFile() && !fs.lstatSync(logPath).isSymbolicLink());
}
const log = (event) => fs.appendFileSync(logPath, JSON.stringify({
  timestampUTC: new Date().toISOString(), runId: marker.runId, testMock: true, ...event,
}) + "\n");
let nextId = 0;
const timers = new Set();
const reply = (response, status, data) => {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
};
const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    return reply(response, 200, { testMock: true, model, message: "[TEST MOCK] No real inference" });
  }
  if (request.method !== "POST" || request.url !== "/api/chat") {
    return reply(response, 404, { error: "[TEST MOCK] Only POST /api/chat is implemented" });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      assert.ok(size <= 18 * 1024 * 1024, "Mock request too large");
      chunks.push(chunk);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, model, "This fixture accepts only the synthetic model name");
    assert.equal(body.stream, false);
    assert.ok(Array.isArray(body.messages) && body.messages.length > 0);
  } catch (error) {
    if (!response.destroyed) reply(response, 400, { error: `[TEST MOCK] ${error.message}` });
    return;
  }
  const prompt = body.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
  const kind = prompt.includes("<note_assist_sources>") ? "note-assist"
    : prompt.includes("你是 PDF 图像转录助手") ? "markdown"
      : prompt.includes("请只返回JSON对象") ? "summary"
        : prompt.includes("请将待处理选段翻译成中文") ? "translation" : "explanation";
  let noteSources = [];
  let imageDetails = {};
  try {
    if (kind === "markdown") {
      // Image source prompts need not contain a textual TEST MOCK marker. Bind
      // them to the exact PDF uploaded into this already guarded fake library.
      const baseline = JSON.parse(fs.readFileSync(path.join(dataDir, ".selection-ai-baseline.json"), "utf8"));
      assert.equal(baseline.runId, marker.runId);
      assert.ok(prompt.includes(`附件：${baseline.attachmentId}；SHA-256：${baseline.pdfSha256}`));
      const images = body.messages.flatMap((message) => message.images || []);
      assert.equal(images.length, 1, "Markdown recognition must send exactly one rendered PNG");
      const sizes = images.map((value) => {
        assert.equal(typeof value, "string");
        assert.match(value, /^[A-Za-z0-9+/]+={0,2}$/);
        const bytes = Buffer.from(value, "base64");
        assert.ok(bytes.length >= 33 && bytes.length <= 12 * 1024 * 1024);
        assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
        const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
        assert.ok(width > 0 && height > 0 && width <= 2600 && height <= 2600);
        return bytes.length;
      });
      const scope = prompt.match(/来源范围：(page_image|selection_image)/)?.[1];
      const physicalPage = Number(prompt.match(/\[PDF 图像识别 · 物理页 (\d+)/)?.[1]);
      assert.ok(scope && physicalPage >= 1 && physicalPage <= 3);
      imageDetails = { sourceScope: scope, physicalPage, imageCount: images.length, imageByteLengths: sizes };
    } else {
      assert.ok(prompt.includes("[TEST MOCK]"), "Refusing input without the synthetic fixture marker");
      if (kind === "note-assist") {
        noteSources = JSON.parse(prompt.match(/<note_assist_sources>([\s\S]*?)<\/note_assist_sources>/)?.[1] || "null");
        assert.ok(Array.isArray(noteSources) && noteSources.some((source) => source.kind === "note"));
      }
    }
  } catch (error) {
    return reply(response, 400, { error: `[TEST MOCK] ${error.message}` });
  }
  const delayMs = kind === "explanation" ? 15000 : 1000;
  const id = ++nextId;
  const selected = prompt.match(/\[待处理选段[^\]]*\]\s*\n([\s\S]*?)(?=\n\[PDF 上下文|\n<\/source>|$)/)?.[1]?.trim() || "";
  const details = { id, kind, model, delayMs, selectedText: selected, ...imageDetails };
  log({ event: "started", ...details });
  let finished = false;
  let timer;
  const abort = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    timers.delete(timer);
    log({ event: "aborted", ...details });
  };
  response.once("close", () => { if (!response.writableEnded) abort(); });
  request.once("aborted", abort);
  if (response.destroyed || request.aborted) { abort(); return; }
  timer = setTimeout(() => {
    timers.delete(timer);
    if (finished || response.destroyed) { abort(); return; }
    finished = true;
    const noteSource = noteSources.find((source) => source.kind === "note");
    const safePolish = kind === "note-assist" && !prompt.includes("任务：研究建议：") &&
      noteSource.text.includes("原稿保护验收：");
    const content = kind === "note-assist"
      ? JSON.stringify({
          overview: "[TEST MOCK] 预设的阅读笔记润色建议，仅验证生成与原稿保护；非真实模型建议。",
          edits: safePolish ? [{ before: "原稿保护验收：", after: "原稿保护核对：", reason: "[TEST MOCK] 测试安全的纯文字调整，公式保持原样。" }] : [],
          suggestions: [{ title: "[TEST MOCK] 核对阅读笔记范围", body: "[TEST MOCK] 这是软件验收建议，不构成论文分析或研究结论。",
            basis: "note", evidenceIds: [noteSource.id] }],
        })
      : kind === "markdown"
        ? "[TEST MOCK] Synthetic Markdown acceptance response.\n\nGradient descent updates the model parameters $x_t$.\n\n$$\nx_{t+1} = x_t - \\eta g_t\n$$\n\n[TEST MOCK] Formula copy/rendering fixture only; transcription quality is not evaluated."
        : kind === "summary"
      ? JSON.stringify({
          researchProblem: "[TEST MOCK] 原创软件验收文档的模拟研究问题；非真实研究结论。",
          coreMethod: "[TEST MOCK] 预设模拟方法，仅测试界面。",
          mainContributions: "[TEST MOCK] 无真实研究贡献或实验结果。",
        })
      : kind === "translation"
        ? `[TEST MOCK] ${selected.includes("Unbiased")
            ? "无偏噪声的条件期望为零。"
            : "梯度下降更新模型参数。"}\n\n这是预设的翻译验收回复，非真实模型翻译。`
        : "[TEST MOCK]\n\n选段描述了此原创验收文档中的参数更新或条件无偏噪声。相邻页在这个虚构例子中把噪声的条件均值设为零。\n\n这段内容只用于验证上下文分析的结果呈现、取消与跨页面通知；不是实际论文分析，也不表示读取过全文。";
    log({ event: "completed", ...details });
    reply(response, 200, {
      model, created_at: new Date().toISOString(),
      message: { role: "assistant", content }, done: true, done_reason: "stop",
    });
  }, delayMs);
  timers.add(timer);
});
server.on("error", (error) => {
  console.error(`[TEST MOCK] ${error.message}`);
  process.exitCode = 1;
});
server.listen(3128, "127.0.0.1", () => {
  log({ event: "server-started", port: 3128, model });
  console.log(JSON.stringify({ result: "TEST MOCK ready", base: "http://127.0.0.1:3128", model, logPath }));
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  server.closeAllConnections();
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  server.close(() => { log({ event: "server-stopped", signal }); });
});
