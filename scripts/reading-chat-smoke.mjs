// Reproducible acceptance fixture: synthetic PDF + local model-transport simulator.
// No real papers, user notes, credentials, or external AI requests.
// node --import tsx scripts/reading-chat-smoke.mjs seed | mock | verify
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PDFDocument, StandardFonts, PDFName, PDFString, rgb } from "pdf-lib";
import { KBStore } from "../src/lib/db.ts";
import { restoreBackup } from "../src/lib/archive.ts";

const manifestPath = "/private/tmp/kb-reading-chat-smoke.json";
const base = "http://127.0.0.1:3133";
const mockBase = "http://127.0.0.1:3134";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mode = process.argv[2];
assert.ok(["seed", "mock", "verify"].includes(mode), "Choose seed, mock or verify");

if (mode === "seed") {
  const directory = fs.mkdtempSync("/private/tmp/kb-reading-chat-");
  const pdf = await PDFDocument.create();
  pdf.setTitle("SYNTHETIC READING AND CHAT FIXTURE");
  pdf.setCreationDate(new Date("2026-10-30T00:00:00Z"));
  pdf.setModificationDate(new Date("2026-10-30T00:00:00Z"));
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const pages = [0, 1, 2].map(() => pdf.addPage([612, 792]));
  const line = (page, text, y, size = 15, heading = false) =>
    pages[page].drawText(text, { x: 55, y, size, font: heading ? bold : font });
  line(0, "SYNTHETIC READING FIXTURE", 735, 22, true);
  line(0, "Original test material. No real research claim or AI result.", 704, 12);
  line(0, "1 Introduction", 657, 19, true);
  line(0, "Our test assumption is that x and y are finite real numbers.", 620);
  line(0, "The synthetic method is in Section 2 and Figure 1.", 587);
  line(0, "A related synthetic source is cited as [1].", 554);
  line(0, "The test equation is Eq. (1).", 521);
  line(0, "Keep this page in place when previewing a reference.", 470, 13);
  line(1, "2 Method", 735, 20, true);
  line(1, "The synthetic method adds the finite quantities x and y.", 693);
  line(1, "Figure 1: A synthetic blue rectangle.", 645, 16, true);
  pages[1].drawRectangle({ x: 70, y: 550, width: 250, height: 70, color: rgb(0.4, 0.65, 0.8) });
  line(1, "x + y = 1                                      (1)", 493, 18);
  line(1, "This is a layout and transport test, not a scientific finding.", 440, 13);
  line(2, "References", 735, 21, true);
  line(2, "[1] Ada Example. A synthetic reading fixture. 2026.", 686);
  line(2, "This reference is fictional and used only for software tests.", 650, 12);
  line(2, "[2] Beta Example. Second synthetic reading fixture. 2025.", 610);
  for (let i = 0; i < 3; i++) line(i, String(i + 1), 35, 11);
  pdf.catalog.set(PDFName.of("Names"), pdf.context.obj({ Dests: { Names: [
    PDFString.of("section.2"), [pages[1].ref, PDFName.of("XYZ"), 55, 752, null],
    PDFString.of("figure.1"), [pages[1].ref, PDFName.of("XYZ"), 55, 665, null],
    PDFString.of("equation.1"), [pages[1].ref, PDFName.of("XYZ"), 55, 515, null],
  ] } }));
  const bytes = Buffer.from(await pdf.save());
  const store = new KBStore(directory);
  let fixture;
  try {
    const paper = store.dispatch("paper.create", { title: "验收 · 连续对话与引用预览", authors: ["Synthetic Test"], year: 2026,
      abstract: "Original synthetic fixture. No real paper or AI inference." });
    const attachment = store.addAttachment(paper.id, "synthetic-reading.pdf", bytes);
    const second = store.dispatch("paper.create", { title: "验收 · 另一篇文献（隔离来源）" });
    const other = await PDFDocument.create();
    other.addPage([612, 792]).drawText("Different synthetic attachment. No research content.", { x: 55, y: 735 });
    const secondAttachment = store.addAttachment(second.id, "other-synthetic.pdf", Buffer.from(await other.save()));
    store.dispatch("settings.update", { aiProvider: "ollama", ollamaUrl: mockBase, ollamaModel: "synthetic-transport-only" });
    const note = store.snapshot().notes.find((item) => item.purpose === "paper" && store.snapshot().relations.some((r) => r.fromId === item.id && r.toId === paper.id));
    assert.ok(note);
    store.dispatch("note.update", { id: note.id, revision: note.revision, body: "验收原稿：公式 $x+y=1$ 与已有正文应始终保留。" });
    fixture = { directory, base, paperId: paper.id, attachmentId: attachment.id, noteId: note.id,
      secondPaperId: second.id, secondAttachmentId: secondAttachment.id, pdfSha256: sha(bytes),
      timestamp: new Date().toISOString(), baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      model: "synthetic local transport simulator; no real AI inference" };
  } finally { store.close(); }
  fs.writeFileSync(manifestPath, JSON.stringify(fixture, null, 2));
  console.log(JSON.stringify(fixture, null, 2));
} else {
  const fixture = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.match(fixture.directory, /^\/private\/tmp\/kb-reading-chat-[A-Za-z0-9_-]+$/);
  const requestLog = fixture.directory + "/mock-requests.json";
  if (mode === "mock") {
    const requests = [];
    const server = http.createServer(async (req, res) => {
      if (req.url === "/api/tags" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ models: [
          { name: "synthetic-transport-only" }, { name: "synthetic-alternate-model" },
        ] }));
        return;
      }
      if (req.url !== "/api/chat" || req.method !== "POST") { res.writeHead(404).end(); return; }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body); fs.writeFileSync(requestLog, JSON.stringify(requests));
      const question = body.messages.at(-1)?.content || "";
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const chunks = ["合成测试回复：", "依据 Section 2，", "可查看 Figure 1 和 Eq. (1)。", "参考条目 [1] 仅为软件验收夹具。",
        "\n\n### 复制格式验收\n\n这里是 **加粗内容示例**，行内公式 $\\frac{x+y}{2}$ 可以复制到笔记。\n\n",
        "$$\n\\sum_{i=1}^{n} x_i = 1\n$$\n\n- 第一项包含 `code()`\n- 第二项用于列表复制\n\n这段文本用于验证真实分块传输与历史传递，未运行模型。"];
      for (const content of chunks) {
        if (res.destroyed) break;
        res.write(JSON.stringify({ model: body.model, message: { role: "assistant", content }, done: false }) + "\n");
        await pause(question.includes("后台") ? 8000 : question.includes("停止") ? 1800 : 250);
      }
      if (!res.destroyed) res.end(JSON.stringify({ done: true }) + "\n");
    });
    server.listen(3134, "127.0.0.1", () => console.log("Synthetic local transport listening on " + mockBase));
  } else {
    const json = async (route, options) => {
      const response = await fetch(base + route, options);
      const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
    };
    const chat = async (message, conversationId, cancel = false, model) => {
      const controller = new AbortController();
      const startTime = Date.now(), events = [];
      let firstDeltaMs = null;
      const response = await fetch(base + "/api/kb/chat", { method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ paperId: fixture.paperId, attachmentId: fixture.attachmentId, conversationId, message, model }) });
      assert.ok(response.ok, await (response.ok ? Promise.resolve("") : response.text()));
      let buffered = "";
      const reader = response.body.getReader(), decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buffered += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffered.indexOf("\n")) >= 0) {
            const raw = buffered.slice(0, end); buffered = buffered.slice(end + 1); if (!raw.trim()) continue;
            const event = JSON.parse(raw); events.push(event);
            if (event.type === "delta" && firstDeltaMs === null) firstDeltaMs = Date.now() - startTime;
            if (cancel && event.type === "delta") { controller.abort(); break; }
          }
          if (controller.signal.aborted) break;
        }
      } catch (error) { if (!controller.signal.aborted) throw error; }
      return { events, firstDeltaMs, totalMs: Date.now() - startTime };
    };
    const first = await chat("请解释 Section 2 的方法与 Figure 1。");
    assert.equal(first.events[0].type, "start");
    assert.equal(first.events.at(-1).type, "done");
    assert.ok(first.events.filter((e) => e.type === "delta").length > 1);
    assert.ok(first.firstDeltaMs < first.totalMs - 400, "First content must arrive before completion");
    const id = first.events[0].conversationId;
    const renamed = await json("/api/kb/chat", { method: "PATCH", headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ paperId: fixture.paperId, conversationId: id, title: "HTTP 验收 · 已重命名" }) });
    assert.equal(renamed.conversation.title, "HTTP 验收 · 已重命名");
    const catalog = await json("/api/kb/chat/models");
    assert.equal(catalog.provider, "ollama");
    assert.ok(catalog.models.some((item) => item.id === "synthetic-alternate-model"));
    const settingsBefore = (await json("/api/kb")).settings;
    const followup = await chat("请接着解释这个公式。", id, false, "synthetic-alternate-model");
    assert.equal(followup.events[0].scope.historyMessages, 2);
    assert.equal(followup.events.at(-1).type, "done");
    const requests = JSON.parse(fs.readFileSync(requestLog, "utf8"));
    assert.ok(requests.at(-1).messages.some((m) => m.role === "assistant" && m.content.includes("合成测试回复")));
    assert.equal(requests.at(-1).model, "synthetic-alternate-model");
    assert.equal(followup.events.at(-1).message.model, "synthetic-alternate-model");
    assert.deepEqual((await json("/api/kb")).settings, settingsBefore);
    await chat("停止测试：请慢慢回答。", id, true);
    let saved;
    for (let i = 0; i < 30; i++) {
      saved = await json("/api/kb/chat?paperId=" + fixture.paperId);
      if (saved.conversations.find((c) => c.id === id)?.messages.at(-1).status === "cancelled") break;
      await pause(100);
    }
    const conversation = saved.conversations.find((c) => c.id === id);
    assert.equal(conversation.title, "HTTP 验收 · 已重命名");
    assert.equal(conversation.messages.at(-1).status, "cancelled");
    assert.ok(conversation.messages.at(-1).body.includes("合成测试回复"));
    const mismatch = await fetch(base + "/api/kb/chat", { method: "POST", headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ paperId: fixture.secondPaperId, attachmentId: fixture.attachmentId, message: "must reject" }) });
    assert.equal(mismatch.status, 400);
    const state = await json("/api/kb");
    assert.match(state.notes.find((n) => n.id === fixture.noteId).body, /验收原稿/);
    const backup = Buffer.from(await (await fetch(base + "/api/kb/backup")).arrayBuffer());
    const restored = restoreBackup(backup, "/private/tmp");
    const restoredStore = new KBStore(restored.restoredDirectory);
    try { assert.deepEqual(restoredStore.snapshot().chatConversations, state.chatConversations); }
    finally { restoredStore.close(); }
    const report = { ...fixture, verifiedAt: new Date().toISOString(), firstDeltaMs: first.firstDeltaMs, completedMs: first.totalMs,
      checks: ["multiple transport deltas before done", "followup includes actual history", "abort keeps partial cancelled reply",
        "rename persists through subsequent turns", "service model catalog", "per-request model override reaches service",
        "actual response model recorded", "global model settings unchanged", "cross-paper attachment rejected", "personal note preserved", "complete backup restores all conversations"], result: "passed" };
    fs.mkdirSync("test-results", { recursive: true });
    fs.writeFileSync("test-results/reading-chat-http.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
