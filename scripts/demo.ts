import { mkdtempSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { KBStore } from "../src/lib/db";
import type { Note, Paper, Topic } from "../src/lib/types";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = process.env.KB_DEMO_PORT || "3135";
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535 || Number(port) === 3000)
  throw new Error("演示端口需为 1024–65535 且不能使用默认正式端口 3000。");
const directory = mkdtempSync(path.join(tmpdir(), "yanzhi-demo-"));
process.chdir(root);
const store = new KBStore(directory);
let paperId: string;
try {
  store.dispatch("settings.update", { aiProvider: "none" });
  const paper = store.dispatch("paper.create", { title: "示例文献 · 从阅读到研究笔记", authors: ["YanZhi Demo"], year: 2026,
    abstract: "这是原创合成示例，用来体验 PDF 阅读、批注、笔记和研究问题，不是已发表论文，也不包含真实研究结论。", tags: ["示例", "研究方法"], inReadingList: true }) as Paper;
  paperId = paper.id;
  store.addAttachment(paper.id, "synthetic-reading-demo.pdf", readFileSync(path.join(root, "tests/fixtures/reading-fixture.pdf")));
  const note = store.snapshot().notes.find(item => item.purpose === "paper")!;
  store.dispatch("note.update", { id: note.id, revision: note.revision, body: "# 从阅读到研究笔记\n\n> 此页为合成示例，PDF 每页标有 TEST FIXTURE。\n\n## 先提出问题\n\n阅读时先记录：研究对象是什么？结论依赖哪些条件？证据来自哪一页？\n\n## 保留自己的判断\n\n- 原文观点与个人推测分别记录。\n- 通过批注留下原文位置。\n- 有疑问时建立研究问题，再继续查找资料。\n\n## 公式与引用\n\n支持 Markdown 和 LaTeX，例如 $x_{t+1}=x_t-\\eta_t g_t$。这只是排版示例，不代表已验证结论。" });
  const topic = store.dispatch("topic.create", { title: "示例问题 · 如何把阅读转成可验证的问题？", description: "区分原文证据、个人判断和待验证假设。此条目仅供体验。" }) as Topic;
  store.dispatch("note.create", { purpose: "idea", title: "示例想法 · 先讨论，再整理", body: "# 先讨论，再整理\n\n我想把阅读中的疑问整理成一条清晰的研究思路。\n\n1. 找到相关文献和笔记。\n2. 记录已有认识、反例与未知之处。\n3. 阶段性整理为工作笔记。\n\n演示默认关闭 AI；需要时请使用自己的提供方配置。", paperIds: [paper.id], topicIds: [topic.id] }) as Note;
} finally { store.close(); }
console.log(`\n研知演示：只使用新建的临时库，AI 默认关闭。\n数据：${directory}\n打开：http://127.0.0.1:${port}/?view=paper&id=${paperId}\nCtrl+C 停止；再次运行会创建新的演示库。\n`);
const child = spawn(process.execPath, ["scripts/serve.mjs", "start"], { cwd: root, stdio: "inherit",
  env: { ...process.env, PORT: port, KB_DATA_DIR: directory, KB_AI_PROVIDER: "none", NEXT_TELEMETRY_DISABLED: "1" } });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.once("error", () => { console.error("无法启动演示，请先运行 npm run setup。"); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
