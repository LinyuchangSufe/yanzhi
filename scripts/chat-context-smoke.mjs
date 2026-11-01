// Only run against reading-chat-smoke's disposable library and local AI mock.
// node --import tsx scripts/chat-context-smoke.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const fixture = JSON.parse(fs.readFileSync("/private/tmp/kb-reading-chat-smoke.json", "utf8"));
assert.match(fixture.directory, /^\/private\/tmp\/kb-reading-chat-[\w-]+$/);
const base = "http://127.0.0.1:3133";
const headers = {"Content-Type": "application/json", Origin: base};
async function json(route, options) {
  const response = await fetch(base + route, options);
  const body = await response.json();
  assert.ok(response.ok, JSON.stringify(body));
  return body;
}
async function mutate(action, payload) {
  return (await json("/api/kb", {method: "POST", headers, body: JSON.stringify({action, payload})})).result;
}
async function chat(message, extra = {}) {
  const response = await fetch(base + "/api/kb/chat", {method: "POST", headers,
    body: JSON.stringify({paperId: fixture.paperId, attachmentId: fixture.attachmentId, message, ...extra})});
  assert.equal(response.status, 200);
  return (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
}
const noteBody = "# 阅读笔记\n\n不应发送的前文。\n\n选中的研究段落：$x^2+y^2=z^2$，保留公式。\n\n不应发送的后文。";
const excerpt = "选中的研究段落：$x^2+y^2=z^2$，保留公式。";
const ideaBody = "## 我的想法\n\n尝试把 $\\alpha$ 作为自适应权重。";
const description = "研究问题描述：方法在数据分布变化时是否仍然成立？";
const note = await mutate("note.create", {title: "引用验收 · 阅读笔记", body: noteBody, purpose: "paper", paperIds: [fixture.paperId]});
const idea = await mutate("note.create", {title: "引用验收 · 我的想法", body: ideaBody, purpose: "idea"});
const topic = await mutate("topic.create", {title: "引用验收 · 研究问题", description});
const topicNote = await mutate("note.update", {id: topic.noteId, revision: 1, body: "问题综合笔记：需要区分论文结论和个人假设。"});
const secret = "UNSELECTED-" + randomUUID();
await mutate("note.create", {title: "未选择的验收笔记", body: secret, purpose: "idea"});
const contexts = [
  {noteId: note.id, revision: note.revision, mode: "excerpt", start: noteBody.indexOf(excerpt), end: noteBody.indexOf(excerpt) + excerpt.length},
  {noteId: idea.id, revision: idea.revision, mode: "full"},
  {noteId: topic.noteId, field: "description", revision: topic.revision, mode: "full"},
];
const first = await chat("合成验收：结合所选笔记、问题和想法，分析本文。", {contexts});
assert.equal(first[0].type, "start");
assert.equal(first.at(-1).type, "done");
const sourceId = first[0].conversationId;
const saved = first[0].userMessage.contexts;
assert.deepEqual(saved.map((item) => item.text), [excerpt, ideaBody, description]);
assert.equal(saved[2].sourceHref, "kb://topic/" + topic.id);
assert.equal(saved[0].sourceHref, "kb://note/" + note.id);
function calls() {return JSON.parse(fs.readFileSync(fixture.directory + "/mock-requests.json", "utf8"));}
function verifyScope(request) {
  const prompt = request.messages.map(({content}) => {
    try {
      const parsed = JSON.parse(content);
      return [parsed.question, ...(parsed.personalReferences || []).map(item => item.text)].join("\n");
    } catch {return content;}
  }).join("\n");
  for (const text of [excerpt, ideaBody, description]) assert.ok(prompt.includes(text), text);
  for (const text of ["不应发送的前文", "不应发送的后文", secret, topicNote.body]) assert.ok(!prompt.includes(text), text);
}
verifyScope(calls().at(-1));
const followup = await chat("合成验收：再解释刚才的个人假设。", {conversationId: sourceId});
assert.equal(followup.at(-1).type, "done");
verifyScope(calls().at(-1));
await mutate("note.update", {id: note.id, revision: note.revision, body: "后来修改的正文，不应改变历史快照。"});
const beforeReject = calls().length;
const stale = await chat("合成验收：版本冲突应在发送前提示。", {contexts: [contexts[0]]});
assert.equal(stale[0].type, "error");
assert.equal(stale[0].status, 409);
assert.equal(calls().length, beforeReject);
const original = (await json("/api/kb/chat?paperId=" + fixture.paperId)).conversations.find((item) => item.id === sourceId);
assert.deepEqual(original.messages[0].contexts, saved);
for (const kind of ["retry", "edit"]) {
  const message = kind === "retry" ? original.messages[0].body : "合成验收：编辑问题后，沿用原来的引用。";
  const replay = await chat(message, {replay: {sourceConversationId: sourceId, sourceMessageId: original.messages[0].id, kind}});
  assert.equal(replay.at(-1).type, "done");
  assert.notEqual(replay[0].conversationId, sourceId);
  assert.deepEqual(replay[0].userMessage.contexts, saved);
  verifyScope(calls().at(-1));
}
const after = await json("/api/kb");
assert.deepEqual(after.chatConversations.find((item) => item.id === sourceId), original);
const exported = await fetch(base + "/api/kb/export");
assert.equal(exported.status, 200);
const markdown = await exported.text();
for (const text of [excerpt, description, "kb://note/" + note.id, "kb://topic/" + topic.id, "本轮个人引用"])
  assert.ok(markdown.includes(text), text);
const {restoreBackup} = await import("../src/lib/archive.ts");
const {KBStore} = await import("../src/lib/db.ts");
const archive = await fetch(base + "/api/kb/backup");
assert.equal(archive.status, 200);
const restored = restoreBackup(Buffer.from(await archive.arrayBuffer()), "/private/tmp");
const store = new KBStore(restored.restoredDirectory);
try {assert.deepEqual(store.snapshot().chatConversations, after.chatConversations);}
finally {store.close();}
const report = {...fixture, verifiedAt: new Date().toISOString(), syntheticModelOnly: true,
  sourceConversationId: sourceId, contextNoteId: note.id, contextIdeaId: idea.id, contextTopicId: topic.id,
  checks: ["note excerpt preserves Markdown and LaTeX", "full idea and question description included", "unselected notes and unselected text excluded",
    "follow-up includes saved contexts", "stale source revision rejected before calling AI", "history snapshot survives source edits",
    "retry and edit preserve original context snapshots", "original conversation unchanged", "Markdown export includes saved references and source links", "backup restores context snapshots"], result: "passed"};
fs.writeFileSync("test-results/chat-context-http.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
