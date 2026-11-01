import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getStore, KBStore } from "../src/lib/db";
import { createBackup, restoreBackup } from "../src/lib/archive";
import { beginIdeaTurn, ideaConversationSnapshot, updateIdeaMessage } from "../src/lib/idea-lab/store";
import type { AIContent, Note, Paper } from "../src/lib/types";
import type { GuideData } from "../src/lib/guide/types";
import type { CodexHistory } from "../src/lib/codex-import/types";
import { initCodexImportSchema, refreshCodexDiscussion, saveCodexDiscussion } from "../src/lib/codex-import/store";
import { readGuideSources } from "../src/lib/guide/sources";
import { assertIdeaSourcesAvailable, ideaUserContent, resolveIdeaSources } from "../src/lib/idea-lab/context";
import { externalDiscussionBody, guideEvidenceSourceInput } from "../src/lib/idea-lab/source-details";
import { ideaSourceInputSchema, ideaSourceSnapshotSchema } from "../src/lib/idea-lab/schemas";
import { historicalIdeaMaterialProblem, ideaMaterials, prepareIdeaMaterials } from "../src/components/ideas/idea-materials";
import { IdeaDiscussionClient } from "../src/components/ideas/idea-client";
import { snapshotSchema } from "../src/lib/validation";

interface Fixture { store: KBStore; root: string; idea: Note; paper: Paper; guide: AIContent; data: GuideData; attachmentId: string }
async function fixture(run: (value: Fixture) => Promise<void> | void) {
  const before = process.env.KB_DATA_DIR;
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-explicit-idea-sources-")); process.env.KB_DATA_DIR = root;
  const store = getStore(); initCodexImportSchema(store);
  try {
    const idea = store.dispatch("note.create", { purpose: "idea", title: "SYNTHETIC source handoff", body: "Original work note" }) as Note;
    const paper = store.dispatch("paper.create", { title: "SYNTHETIC evidence paper" }) as Paper;
    const file = store.addAttachment(paper.id, "reading-fixture.pdf", readFileSync("tests/fixtures/reading-fixture.pdf"));
    const document = (await readGuideSources([file.id]))[0], block = document.blocks[0];
    assert.ok(block && block.text.length > 20);
    const quote = block.text.slice(0, 120);
    const evidence = { id: `${randomUUID()}:0:0`, paperId: paper.id, attachmentId: file.id, attachmentSha256: file.sha256,
      pageIndex: block.pageIndex, pageLabel: document.pageLabels[block.pageIndex] || "1", blockId: block.id, quote,
      category: "problem" as const, title: "Synthetic stored original sentence", explanation: "UNSELECTED_AI_INTERPRETATION_MUST_NOT_BE_SENT", matched: true };
    const data: GuideData = { version: 1, mode: "guide", overview: "Synthetic guide fixture", sections: [],
      evidence: [evidence, { ...evidence, id: `${randomUUID()}:0:1`, title: "Another explicit source identity" }],
      readingOrder: [evidence.id], questions: ["An AI question that is not original evidence"], sources: [document.source], warnings: [], paperIds: [paper.id] };
    const guide = store.saveAI({ paperId: paper.id, kind: "guide", body: "SYNTHETIC AI GUIDE BODY", provider: "synthetic", model: "test-double",
      sourceScope: "full_text", sourceAttachmentId: file.id, sourcePageIndices: document.source.parsedPages, sourceText: quote, guideData: data, status: "completed" });
    await run({ store, root, idea, paper, guide, data, attachmentId: file.id });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); if (before === undefined) delete process.env.KB_DATA_DIR; else process.env.KB_DATA_DIR = before; }
}
function codexHistory(): CodexHistory {
  const now = "2026-10-31T00:00:00.000Z";
  return { thread: { id: randomUUID(), title: "SYNTHETIC imported discussion", cwd: "/synthetic", updatedAt: now, createdAt: now },
    turns: [{ id: "turn-a", status: "completed", startedAt: now, messages: [
      { id: "question-a", turnId: "turn-a", role: "user", text: "Public user line\r\n🧠 formula $x^2$." },
      { id: "answer-a", turnId: "turn-a", role: "assistant", text: "Public AI hypothesis still needs verification." },
    ] }], complete: true, protocol: "paginated", source: { id: "synthetic-profile", label: "Synthetic source", host: "local", home: "/PRIVATE_PROFILE_PATH_NOT_SENT", sqliteHome: null, binary: "codex" } };
}
function storage(): Storage {
  const map = new Map<string, string>();
  return { get length() { return map.size; }, key: (index) => [...map.keys()][index] ?? null, getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); }, removeItem: (key) => { map.delete(key); }, clear: () => map.clear() };
}

test("guide evidence resolves only an explicit matched original quote and carries immutable guide/page/SHA provenance", async () => fixture(({ store, guide, data }) => {
  const inputs = data.evidence.map((evidence) => guideEvidenceSourceInput(guide.id, evidence.id));
  const snapshots = resolveIdeaSources(store, inputs);
  assert.notEqual(snapshots[0].id, snapshots[1].id, "different evidence IDs in the same guide must never collapse");
  const source = snapshots[0]; assert.equal(source.text, data.evidence[0].quote);
  assert.equal(source.guideId, guide.id); assert.equal(source.evidenceId, data.evidence[0].id);
  assert.equal(source.attachmentSha256, data.evidence[0].attachmentSha256); assert.equal(source.pageIndex, data.evidence[0].pageIndex);
  assert.equal(source.sourceHref, `kb://ai/${guide.id}`); assert.equal(source.revision, 1);
  assert.doesNotMatch(JSON.stringify(source), /UNSELECTED_AI_INTERPRETATION|SYNTHETIC AI GUIDE BODY/);
  assert.match(ideaUserContent("Synthetic question", snapshots), /不含 AI 解释/);
  assert.ok(ideaSourceSnapshotSchema.safeParse(source).success);
  assert.equal(ideaSourceSnapshotSchema.safeParse({ ...source, evidenceId: undefined }).success, false);
  assert.equal(ideaSourceInputSchema.safeParse({ ...inputs[0], revision: 2 }).success, false);
  assert.throws(() => resolveIdeaSources(store, [{ ...inputs[0], evidenceId: "unknown-evidence" }]), /不存在/);
}));

test("guide preview exposes missing or stale attachments while sending verifies active paper and actual disk SHA", async () => fixture(({ store, root, idea, guide, data, paper, attachmentId }) => {
  const input = guideEvidenceSourceInput(guide.id, data.evidence[0].id);
  const state = store.snapshot(); const original = resolveIdeaSources(store, [input])[0];
  const missing = { ...state, attachments: state.attachments.map((file) => file.id === attachmentId ? { ...file, status: "missing" as const } : file) };
  const unavailable = ideaMaterials(missing, idea.id).find((item) => item.input.evidenceId === input.evidenceId)!;
  assert.match(unavailable.disabledReason || "", /缺失/); assert.equal(unavailable.text, original.text);
  const stale = { ...state, attachments: state.attachments.map((file) => file.id === attachmentId ? { ...file, sha256: "0".repeat(64) } : file) };
  assert.match(ideaMaterials(stale, idea.id).find((item) => item.input.evidenceId === input.evidenceId)?.disabledReason || "", /指纹/);
  const pathToPDF = path.join(root, state.attachments.find((file) => file.id === attachmentId)!.relativePath), bytes = readFileSync(pathToPDF);
  writeFileSync(pathToPDF, "%PDF altered synthetic fixture");
  assert.throws(() => resolveIdeaSources(store, [input]), /指纹|校验|完整|变化|不匹配/);
  writeFileSync(pathToPDF, bytes);
  store.dispatch("paper.trash", { id: paper.id, revision: paper.revision });
  assert.throws(() => resolveIdeaSources(store, [input]), /回收站/);
  assert.throws(() => assertIdeaSourcesAvailable(store, [original]), /回收站/);
  assert.equal(original.text, data.evidence[0].quote);
}));

test("new guide reports never rewrite old source snapshots, and missing reports retain readable snapshots but cannot be reused", async () => fixture(({ store, guide, data }) => {
  const source = resolveIdeaSources(store, [guideEvidenceSourceInput(guide.id, data.evidence[0].id)])[0];
  const before = structuredClone(source);
  const { id, createdAt: _createdAt, ...saved } = guide;
  const regenerated = store.saveAI({ ...saved, guideData: { ...data, overview: "A newly generated report" } });
  assert.notEqual(regenerated.id, id);
  assert.doesNotThrow(() => assertIdeaSourcesAvailable(store, [source])); assert.deepEqual(source, before);
  store.db.prepare("DELETE FROM ai_contents WHERE id=?").run(guide.id);
  assert.throws(() => assertIdeaSourcesAvailable(store, [source]), /证据.*缺失|来源改变/);
  assert.match(historicalIdeaMaterialProblem(store.snapshot(), source), /原导读记录已缺失/);
  assert.deepEqual(source, before); assert.ok(ideaSourceSnapshotSchema.safeParse(source).success);
}));

test("external discussion uses only public body, exact CRLF/UTF-16 ranges and verified original thread links", async () => fixture(({ store }) => {
  const history = codexHistory(); const { discussion } = saveCodexDiscussion(store, history, ["turn-a"], { paperIds: [], topicIds: [], noteIds: [] });
  const body = externalDiscussionBody(discussion.messages), start = body.indexOf("🧠"), end = start + "🧠 formula".length;
  const input = { type: "externalDiscussion" as const, id: discussion.id, revision: discussion.revision, field: "body" as const, start, end };
  const source = resolveIdeaSources(store, [input])[0];
  assert.equal(source.text, "🧠 formula"); assert.equal(source.sourceHref, `kb://discussion/${discussion.id}`);
  assert.equal(source.externalSourceHref, discussion.sourceHref); assert.equal(source.sourceThreadId, discussion.threadId);
  assert.equal(source.externalContentHash, discussion.hash); assert.doesNotMatch(JSON.stringify(source), /PRIVATE_PROFILE_PATH/);
  assert.ok(ideaSourceSnapshotSchema.safeParse(source).success);
  assert.equal(ideaSourceSnapshotSchema.safeParse({ ...source, sourceThreadId: randomUUID() }).success, false);
  assert.throws(() => resolveIdeaSources(store, [{ ...input, start: start + 1 }]), /范围/);
  assert.throws(() => resolveIdeaSources(store, [{ ...input, revision: 99 }]), /修订不存在|已更新/);
}));

test("refreshing an imported discussion preserves old selected text and supports explicitly selecting its retained version", async () => fixture(({ store, idea }) => {
  const history = codexHistory(); const { discussion } = saveCodexDiscussion(store, history, ["turn-a"], { paperIds: [], topicIds: [], noteIds: [] });
  const input = { type: "externalDiscussion" as const, id: discussion.id, revision: discussion.revision, field: "body" as const };
  const source = resolveIdeaSources(store, [input])[0], before = structuredClone(source);
  const changed = { ...history, turns: history.turns.map((turn) => ({ ...turn, messages: turn.messages.map((message) => ({ ...message, text: `CHANGED_CURRENT_${message.id}` })) })) };
  const refreshed = refreshCodexDiscussion(store, discussion.id, discussion.revision, changed).discussion;
  assert.doesNotThrow(() => assertIdeaSourcesAvailable(store, [source])); assert.deepEqual(source, before);
  assert.equal(historicalIdeaMaterialProblem(store.snapshot(), source), "");
  const current = resolveIdeaSources(store, [{ ...input, revision: refreshed.revision }])[0];
  assert.match(current.text, /CHANGED_CURRENT/); assert.doesNotMatch(source.text, /CHANGED_CURRENT/);
  assert.deepEqual(resolveIdeaSources(store, [input])[0], source, "an explicit retained revision resolves the original snapshot");
  const staged = prepareIdeaMaterials(store.snapshot(), idea.id, [input]);
  assert.equal(staged[0].text, source.text); assert.equal(staged[0].input.revision, source.revision);
  assert.match(staged[0].label, /历史修订/);
  const both = prepareIdeaMaterials(store.snapshot(), idea.id, [{ ...input, revision: refreshed.revision }], staged);
  assert.equal(both.length, 2); assert.notEqual(both[0].key, both[1].key);
  store.db.prepare("DELETE FROM external_discussions WHERE id=?").run(discussion.id);
  assert.throws(() => assertIdeaSourcesAvailable(store, [source]), /不存在/); assert.deepEqual(source, before);
  assert.match(historicalIdeaMaterialProblem(store.snapshot(), source), /原讨论.*缺失/);
}));

test("unfinished external turns stay marked as partial after refresh, without changing the text selection surface", async () => fixture(({ store, idea }) => {
  const history = codexHistory(); history.turns[0].status = "interrupted";
  const { discussion } = saveCodexDiscussion(store, history, ["turn-a"], { paperIds: [], topicIds: [], noteIds: [] });
  const source = resolveIdeaSources(store, [{ type: "externalDiscussion", id: discussion.id, revision: discussion.revision, field: "body" }])[0];
  assert.equal(source.text, externalDiscussionBody(discussion.messages));
  assert.deepEqual(source.externalTurnStatuses, { "turn-a": "interrupted" });
  assert.match(ideaUserContent("Explicit synthetic question", [source]), /部分轮次未完成/);
  const state = { ...store.snapshot(), externalDiscussions: [discussion] };
  assert.match(ideaMaterials(state, idea.id).find((item) => item.input.type === "externalDiscussion")?.label || "", /部分轮次未完成/);
  const completed = { ...history, turns: history.turns.map((turn) => ({ ...turn, status: "completed" })) };
  refreshCodexDiscussion(store, discussion.id, discussion.revision, completed);
  assert.doesNotThrow(() => assertIdeaSourcesAvailable(store, [source]));
  assert.deepEqual(source.externalTurnStatuses, { "turn-a": "interrupted" });
  assert.match(prepareIdeaMaterials(store.snapshot(), idea.id, [{ type: "externalDiscussion", id: discussion.id, revision: discussion.revision, field: "body" }])[0].label, /部分轮次未完成/);
  assert.throws(() => assertIdeaSourcesAvailable(store, [{ ...source, externalTurnStatuses: { "turn-a": "completed" } }]), /完成状态/);
}));

test("older snapshots without new research collections still validate and retain existing notes and guide evidence", async () => fixture(({ store, idea, guide }) => {
  const legacy = structuredClone(store.snapshot());
  delete legacy.externalDiscussions; delete legacy.researchItems;
  const parsed = snapshotSchema.parse(legacy);
  assert.deepEqual(parsed.externalDiscussions, []); assert.deepEqual(parsed.researchItems, []);
  assert.equal(parsed.notes.find((note) => note.id === idea.id)?.body, idea.body);
  assert.deepEqual(parsed.aiContents.find((content) => content.id === guide.id)?.guideData?.evidence, guide.guideData?.evidence);
}));

test("a full backup restores guide and partial external discussion provenance without recomputing their text", async () => fixture(({ store, root, idea, guide, data }) => {
  const history = codexHistory(); history.turns[0].status = "interrupted";
  const { discussion } = saveCodexDiscussion(store, history, ["turn-a"], { paperIds: [], topicIds: [], noteIds: [] });
  const sources = resolveIdeaSources(store, [guideEvidenceSourceInput(guide.id, data.evidence[0].id),
    { type: "externalDiscussion", id: discussion.id, revision: discussion.revision, field: "body" }]);
  const turn = beginIdeaTurn(store, { noteId: idea.id, requestId: randomUUID(), message: "Synthetic provenance backup check", sources, provider: "synthetic", model: "test-double" });
  updateIdeaMessage(store, { ...turn.assistantMessage, body: "Synthetic saved answer, not a research conclusion.", status: "completed" });
  const restored = restoreBackup(createBackup(store), root);
  const copy = new KBStore(restored.restoredDirectory);
  try {
    const recovered = ideaConversationSnapshot(copy, idea.id)[0].messages[0].sources;
    assert.deepEqual(recovered, sources);
    assert.doesNotThrow(() => assertIdeaSourcesAvailable(copy, recovered));
    assert.equal(recovered[1].externalTurnStatuses?.["turn-a"], "interrupted");
  } finally { copy.close(); }
}));

test("snapshot import rejects forged evidence, file, profile, revision and turn-status bindings and rolls back", async () => fixture(({ store, root, idea, guide, data }) => {
  const history = codexHistory(); history.turns[0].status = "interrupted";
  const { discussion } = saveCodexDiscussion(store, history, ["turn-a"], { paperIds: [], topicIds: [], noteIds: [] });
  const sources = resolveIdeaSources(store, [guideEvidenceSourceInput(guide.id, data.evidence[0].id),
    { type: "externalDiscussion", id: discussion.id, revision: discussion.revision, field: "body" }]);
  const turn = beginIdeaTurn(store, { noteId: idea.id, requestId: randomUUID(), message: "Synthetic source restore integrity", sources, provider: "synthetic", model: "test-double" });
  updateIdeaMessage(store, { ...turn.assistantMessage, body: "Synthetic saved reply.", status: "completed" });
  const mutations: Array<(value: typeof sources) => void> = [
    (value) => { value[0].attachmentSha256 = "0".repeat(64); },
    (value) => { value[0].evidenceId = "not-the-original-evidence"; },
    (value) => { value[0].pageIndex = value[0].pageIndex! + 1; },
    (value) => { value[0].text = `X${value[0].text.slice(1)}`; },
    (value) => { value[1].externalSourceId = "another-profile"; },
    (value) => { value[1].externalContentHash = "0".repeat(64); },
    (value) => { value[1].externalTurnStatuses = { "turn-a": "completed" }; },
    (value) => { value[1].revision = 999; },
    (value) => { value[1].sourceThreadId = "another-thread"; value[1].externalSourceHref = "codex://threads/another-thread"; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const snapshot = structuredClone(store.snapshot());
    for (const message of snapshot.ideaConversations![0].messages) mutate(message.sources);
    const target = new KBStore(path.join(root, `invalid-source-${index}`));
    try {
      assert.throws(() => target.importSnapshot(snapshot), /备份讨论/);
      assert.equal(target.snapshot().notes.length, 0, "invalid provenance must roll back the complete import");
    } finally { target.close(); }
  }
}));

test("restoring historical guide snapshots allows missing PDF files, recycled papers and deleted guide records", async () => fixture(({ store, root, idea, guide, data, paper }) => {
  const sources = resolveIdeaSources(store, [guideEvidenceSourceInput(guide.id, data.evidence[0].id)]);
  const turn = beginIdeaTurn(store, { noteId: idea.id, requestId: randomUUID(), message: "Synthetic orphan snapshot preservation", sources, provider: "synthetic", model: "test-double" });
  updateIdeaMessage(store, { ...turn.assistantMessage, body: "Synthetic preserved reply.", status: "completed" });
  store.dispatch("paper.trash", { id: paper.id, revision: paper.revision });
  for (const deletedGuide of [false, true]) {
    const snapshot = structuredClone(store.snapshot());
    if (deletedGuide) snapshot.aiContents = snapshot.aiContents.filter((content) => content.id !== guide.id);
    const target = new KBStore(path.join(root, `read-only-history-${deletedGuide}`));
    try {
      target.importSnapshot(snapshot);
      const restored = target.snapshot();
      assert.equal(restored.attachments[0].status, "missing");
      assert.deepEqual(restored.ideaConversations![0].messages[0].sources, sources);
      assert.throws(() => assertIdeaSourcesAvailable(target, sources), /回收站/);
    } finally { target.close(); }
  }
}));

test("cross-mount evidence handoff is a bounded explicit draft and preserves existing work without any AI call", async () => fixture(async ({ store, idea, guide, data }) => {
  const memory = storage(); let posts = 0;
  const transport: typeof fetch = async (_url, init) => {
    if (init?.method) { posts++; throw new Error("must not call AI during handoff"); }
    return Response.json({ conversations: [], summaries: [], configuration: {} });
  };
  const input = guideEvidenceSourceInput(guide.id, data.evidence[0].id), state = store.snapshot();
  const client = new IdeaDiscussionClient(idea.id, transport, memory); client.setDraft("Keep my unfinished question.");
  assert.equal(client.prepareFromSources(state, [input], "Follow this explicit source."), true);
  assert.match(client.getSnapshot().draft, /Keep my unfinished question/); assert.match(client.getSnapshot().draft, /Follow this explicit source/);
  assert.equal(client.getSnapshot().materials.length, 1); assert.equal(posts, 0);
  const restored = new IdeaDiscussionClient(idea.id, transport, memory); await restored.load();
  assert.equal(restored.getSnapshot().draft, client.getSnapshot().draft); assert.deepEqual(restored.getSnapshot().materials, client.getSnapshot().materials);
  const before = structuredClone(restored.getSnapshot().materials), draft = restored.getSnapshot().draft;
  assert.equal(restored.prepareFromSources(state, [{ ...input, evidenceId: "missing" }], "must not replace"), false);
  assert.deepEqual(restored.getSnapshot().materials, before); assert.equal(restored.getSnapshot().draft, draft); assert.equal(posts, 0);
  assert.throws(() => prepareIdeaMaterials(state, idea.id, [{ ...input, end: data.evidence[0].quote.length + 1, start: 0 }]), /范围/);
}));
