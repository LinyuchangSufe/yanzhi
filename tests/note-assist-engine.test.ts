import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStore, StoreError } from "../src/lib/db";
import { generateNoteAssistance, generationSchema } from "../src/lib/note-assist/engine";
import { getNoteAssistContext } from "../src/lib/note-assist/context";
import type { NoteAssistResult, NoteAssistSource } from "../src/lib/note-assist/types";
import type { GuideData } from "../src/lib/guide/types";
import type { Note, Paper, Topic } from "../src/lib/types";

// All model replies are explicit fixtures at fetch/child-process boundaries.
// They are not real model inference, research advice, or experimental evidence.
const fixturePdf = readFileSync(path.resolve("tests/fixtures/reading-fixture.pdf"));
const result = (): NoteAssistResult => ({
  overview: "显式传输测试：只整理给定笔记，不构成科研结论。",
  edits: [],
  suggestions: [{ title: "待澄清问题", body: "请明确这一想法的验证目标。", basis: "hypothesis", evidenceIds: [] }],
});

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-note-assist-engine-"));
  const previous = { ...process.env }, previousFetch = globalThis.fetch;
  process.env.KB_DATA_DIR = root;
  process.env.KB_AI_PROVIDER = "ollama";
  process.env.KB_OLLAMA_URL = "http://127.0.0.1:11434";
  process.env.KB_OLLAMA_MODEL = "explicit-note-assist-fixture-no-inference";
  const store = getStore();
  const topic = store.dispatch("topic.create", { title: "TEST 问题", description: "当前研究问题的测试描述" }) as Topic;
  const initial = store.snapshot().notes.find((note) => note.id === topic.noteId)!;
  const note = store.dispatch("note.update", { id: initial.id, revision: initial.revision,
    body: "我想理解依赖数据的影响。\n\n验证目标仍需明确。" }) as Note;
  const paper = store.dispatch("paper.create", { title: "TEST paper", abstract: "EXPLICIT ABSTRACT FIXTURE ONLY" }) as Paper;
  store.dispatch("link.set", { fromType: "topic", fromId: topic.id, toType: "paper", toId: paper.id });
  const idea = store.dispatch("note.create", { title: "TEST 想法", purpose: "idea", body: "OPTIONAL PRIVATE IDEA BODY", topicIds: [topic.id] }) as Note;
  const unrelated = store.dispatch("note.create", { title: "UNRELATED private note", purpose: "idea", body: "NEVER SEND UNRELATED PRIVATE NOTE" }) as Note;
  return {
    root, store, topic, note, paper, idea, unrelated,
    input(extra: Record<string, unknown> = {}) {
      return generationSchema.parse({ noteId: note.id, revision: note.revision, mode: "structure", ...extra });
    },
    cleanup() {
      globalThis.fetch = previousFetch;
      store.close();
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
type Context = ReturnType<typeof setup>;

function transport(reply: (sources: NoteAssistSource[], prompt: string, init?: RequestInit) => unknown | Promise<unknown> = () => result()) {
  const calls: { sources: NoteAssistSource[]; prompt: string; url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    assert.match(request.messages[0].content, /不可信资料/);
    const prompt = request.messages.find((message) => message.role === "user")!.content;
    const value = prompt.match(/<note_assist_sources>([\s\S]*)<\/note_assist_sources>/)?.[1];
    assert.ok(value);
    const sources = JSON.parse(value) as NoteAssistSource[];
    calls.push({ sources, prompt, url: String(url), init });
    const response = await reply(sources, prompt, init);
    if (response instanceof Response) return response;
    return Response.json(String(url).endsWith("/api/chat") ?
      { message: { content: JSON.stringify(response) } } :
      { choices: [{ message: { content: JSON.stringify(response) } }] });
  };
  return calls;
}

function addGuide(context: Context, count = 1, matched = true) {
  const attachment = context.store.addAttachment(context.paper.id, "TEST-source.pdf", fixturePdf);
  const evidence = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(), paperId: context.paper.id, attachmentId: attachment.id,
    attachmentSha256: attachment.sha256, pageIndex: index % 3,
    pageLabel: ["i", "1", "2"][index % 3], blockId: `${attachment.id}:${index % 3}:${index}`,
    quote: `EXPLICIT MATCHED PDF QUOTE FIXTURE ${index}`, category: "method" as const,
    title: "DO NOT SEND GUIDE INTERPRETATION TITLE", explanation: "DO NOT SEND GUIDE INTERPRETATION BODY", matched,
  }));
  const guideData: GuideData = {
    version: 1, mode: "guide", overview: "DO NOT SEND GUIDE OVERVIEW", sections: [],
    evidence, readingOrder: evidence.map((item) => item.id), questions: [], warnings: [],
    paperIds: [context.paper.id], sources: [{ paperId: context.paper.id, paperTitle: context.paper.title,
      attachmentId: attachment.id, attachmentSha256: attachment.sha256, filename: attachment.filename,
      pageCount: 3, parsedPages: [0, 1, 2], emptyPages: [], characterCount: 500 }],
  };
  context.store.saveAI({ paperId: context.paper.id, kind: "guide", body: "DO NOT SEND AI GUIDE BODY",
    provider: "fixture", model: "fixture", sourceScope: "full_text", sourceAttachmentId: attachment.id,
    sourcePageIndices: [0, 1, 2], sourceText: "", guideData, status: "completed" });
  return { attachment, evidence };
}

function savedCount(context: Context) {
  return (context.store.db.prepare("SELECT COUNT(*) AS n FROM note_assists").get() as { n: number }).n;
}

test("opening assist context exposes candidate metadata only; default generation sends only current note/topic", async () => {
  const context = setup();
  try {
    const metadata = getNoteAssistContext(context.store, context.note.id);
    assert.deepEqual(metadata.papers, [{ id: context.paper.id, title: context.paper.title, hasAbstract: true, evidenceCount: 0 }]);
    assert.deepEqual(metadata.ideas, [{ id: context.idea.id, title: context.idea.title }]);
    assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE IDEA BODY|NEVER SEND|EXPLICIT ABSTRACT/);
    const calls = transport();
    const before = context.store.snapshot().notes;
    const record = await generateNoteAssistance(context.input());
    assert.deepEqual(calls[0].sources.map((source) => source.kind), ["note", "topic"]);
    assert.doesNotMatch(calls[0].prompt, /OPTIONAL PRIVATE|NEVER SEND|EXPLICIT ABSTRACT/);
    assert.match(calls[0].prompt, /不可信用户或文献资料/);
    assert.equal(record.baseBody, context.note.body);
    assert.equal(record.baseRevision, context.note.revision);
    assert.equal(record.lastAppliedRevision, context.note.revision);
    assert.deepEqual(record.appliedEdits, []);
    assert.deepEqual(context.store.snapshot().notes, before);
    assert.equal(savedCount(context), 1);
    const row = context.store.db.prepare("SELECT data FROM note_revisions WHERE note_id=?").get(context.note.id) as { data: string };
    const snapshot = JSON.parse(row.data) as { body: string; reason: string };
    assert.equal(snapshot.body, context.note.body);
    assert.equal(snapshot.reason, "ai-start");
    context.store.dispatch("paper.trash", { id: context.paper.id, revision: context.paper.revision });
    assert.deepEqual(getNoteAssistContext(context.store, context.note.id).papers, []);
    const beforeRejected = context.store.snapshot();
    await assert.rejects(generateNoteAssistance(context.input({ paperIds: [context.paper.id] })),
      (error: unknown) => error instanceof StoreError && error.status === 409 && /回收站/.test(error.message));
    assert.equal(calls.length, 1, "recycled opt-in paper never reaches the model");
    assert.deepEqual(context.store.snapshot(), beforeRejected);
  } finally { context.cleanup(); }
});

test("selection sends no other正文; stale revision or mismatched selection never calls a model", async () => {
  const context = setup();
  try {
    const calls = transport();
    const text = "验证目标仍需明确。", from = context.note.body.indexOf(text);
    const record = await generateNoteAssistance(context.input({ selection: { from, to: from + text.length, text } }));
    assert.equal(calls[0].sources[0].text, text);
    assert.doesNotMatch(calls[0].prompt, /我想理解依赖数据的影响/);
    assert.equal(record.baseBody, context.note.body, "immutable base stores whole original locally for safe adoption");
    await assert.rejects(generateNoteAssistance(context.input({ revision: 1 })), (error: unknown) => error instanceof StoreError && error.status === 409);
    await assert.rejects(generateNoteAssistance(context.input({ selection: { from: 0, to: 3, text: "不匹配" } })), (error: unknown) => error instanceof StoreError && error.status === 409);
    assert.equal(calls.length, 1);
  } finally { context.cleanup(); }
});

test("opt-in related abstracts, six matched PDF quotes, and selected idea carry explicit source boundaries", async () => {
  const context = setup();
  try {
    const { attachment } = addGuide(context, 8);
    assert.equal(getNoteAssistContext(context.store, context.note.id).papers[0].evidenceCount, 6);
    const calls = transport((sources) => ({ ...result(), suggestions: [{ title: "摘要层面的观察", body: "测试不推断全文。",
      basis: "literature", evidenceIds: sources.filter((source) => source.kind === "pdf-evidence").slice(0, 1).map((source) => source.id) }] }));
    const record = await generateNoteAssistance(context.input({ paperIds: [context.paper.id], ideaIds: [context.idea.id] }));
    assert.equal(record.sources.filter((source) => source.kind === "pdf-evidence").length, 6);
    assert.ok(record.sources.filter((source) => source.kind === "pdf-evidence").every((source) => source.attachmentSha256 === attachment.sha256 && source.pageIndex !== undefined));
    assert.match(calls[0].prompt, /OPTIONAL PRIVATE IDEA BODY/);
    assert.match(calls[0].prompt, /EXPLICIT ABSTRACT FIXTURE ONLY/);
    assert.match(calls[0].prompt, /只是摘要，不是全文/);
    assert.doesNotMatch(calls[0].prompt, /DO NOT SEND|NEVER SEND/);
  } finally { context.cleanup(); }
});

test("PDF evidence requires unchanged physical file and matched page/block association", async () => {
  const context = setup();
  try {
    const { attachment } = addGuide(context);
    const calls = transport();
    writeFileSync(context.store.attachmentPath(attachment.id), "tampered physical source");
    await assert.rejects(generateNoteAssistance(context.input({ paperIds: [context.paper.id] })), /PDF指纹已改变/);
    assert.equal(calls.length, 0);
    context.store.db.prepare("UPDATE ai_contents SET guide_data=json_set(guide_data,'$.evidence[0].matched',json('false'))").run();
    assert.equal(getNoteAssistContext(context.store, context.note.id).papers[0].evidenceCount, 0);
    const record = await generateNoteAssistance(context.input({ paperIds: [context.paper.id] }));
    assert.equal(record.sources.filter((source) => source.kind === "pdf-evidence").length, 0);
    assert.equal(record.sources.filter((source) => source.kind === "paper-abstract").length, 1);
  } finally { context.cleanup(); }
});

test("unrelated choices, empty paper sources and duplicates fail before transport", async () => {
  const context = setup();
  try {
    const calls = transport();
    const unrelatedPaper = context.store.dispatch("paper.create", { title: "UNRELATED paper" }) as Paper;
    await assert.rejects(generateNoteAssistance(context.input({ paperIds: [unrelatedPaper.id] })), /未与当前笔记、研究问题或想法关联/);
    await assert.rejects(generateNoteAssistance(context.input({ ideaIds: [context.unrelated.id] })), /未与当前笔记、研究问题或想法关联/);
    context.store.dispatch("paper.update", { id: context.paper.id, revision: context.paper.revision, abstract: "" });
    await assert.rejects(generateNoteAssistance(context.input({ paperIds: [context.paper.id] })), /没有可用摘要或已验证/);
    assert.throws(() => context.input({ paperIds: [context.paper.id, context.paper.id] }), /不能重复/);
    assert.equal(calls.length, 0);
  } finally { context.cleanup(); }
});

test("paper reading notes generate separate suggestions, preserve formulas, and apply and restore only on explicit actions", async () => {
  const context = setup();
  try {
    addGuide(context);
    const initial = context.store.snapshot().notes.find((note) => note.purpose === "paper")!;
    const original = "这篇论文的思路仍需梳理。\n\n保留公式 $a_n \\to a$ 和 `x = 1`。";
    const note = context.store.dispatch("note.update", {
      id: initial.id, revision: initial.revision, body: original,
    }) as Note;
    const metadata = getNoteAssistContext(context.store, note.id);
    assert.deepEqual(metadata.papers, [{ id: context.paper.id, title: context.paper.title, hasAbstract: true, evidenceCount: 1 }]);
    assert.deepEqual(metadata.ideas, []);
    assert.equal(metadata.topic, null);
    assert.doesNotMatch(JSON.stringify(metadata), /EXPLICIT ABSTRACT|MATCHED PDF QUOTE|PRIVATE IDEA/);
    const calls = transport(() => ({ ...result(), edits: [{
      before: "这篇论文的思路仍需梳理。", after: "这篇论文的核心思路仍需梳理。", reason: "明确笔记整理对象",
    }] }));
    const before = context.store.snapshot().notes;
    const mirror = readFileSync(path.join(context.root, "notes", `${note.id}.md`), "utf8");
    const record = await generateNoteAssistance(context.input({ noteId: note.id, revision: note.revision, mode: "polish" }));
    assert.deepEqual(calls[0].sources.map((source) => source.kind), ["note"]);
    assert.match(calls[0].prompt, /当前对象：文献阅读笔记/);
    assert.doesNotMatch(calls[0].prompt, /当前对象：我的想法|EXPLICIT ABSTRACT|MATCHED PDF QUOTE|DO NOT SEND|OPTIONAL PRIVATE/);
    assert.deepEqual(context.store.snapshot().notes, before, "generation never rewrites a reading note");
    assert.equal(readFileSync(path.join(context.root, "notes", `${note.id}.md`), "utf8"), mirror);
    const base = context.store.snapshot().noteRevisions!.find((item) => item.noteId === note.id && item.reason === "ai-start")!;
    assert.equal(base.body, original);
    const applied = context.store.dispatch("note.assist.apply", {
      noteId: note.id, revision: note.revision, assistanceId: record.id, operation: "all",
    }) as Note;
    assert.equal(applied.body, original.replace("论文的思路", "论文的核心思路"));
    assert.ok(applied.body.includes("$a_n \\to a$ 和 `x = 1`"));
    const restored = context.store.dispatch("note.revision.restore", {
      noteId: note.id, revision: applied.revision, snapshotId: base.id,
    }) as Note;
    assert.equal(restored.body, original);
    assert.equal(restored.title, note.title);
    const savedApplied = context.store.snapshot().noteRevisions!.find((item) => item.noteId === note.id && item.reason === "before-restore")!;
    assert.equal(savedApplied.body, applied.body, "restoring the original also preserves the explicitly accepted version");
  } finally { context.cleanup(); }
});

test("a paper reading note includes its own abstract and verified quotes only after opt-in", async () => {
  const context = setup();
  try {
    const { attachment } = addGuide(context);
    const initial = context.store.snapshot().notes.find((note) => note.purpose === "paper")!;
    const note = context.store.dispatch("note.update", {
      id: initial.id, revision: initial.revision, body: "核对论文中已经给出的假设。",
    }) as Note;
    const calls = transport();
    const record = await generateNoteAssistance(context.input({
      noteId: note.id, revision: note.revision, paperIds: [context.paper.id],
    }));
    assert.deepEqual(record.sources.map((source) => source.kind), ["note", "paper-abstract", "pdf-evidence"]);
    assert.equal(record.sources[2].attachmentId, attachment.id);
    assert.equal(record.sources[2].pageIndex, 0);
    assert.match(calls[0].prompt, /EXPLICIT ABSTRACT FIXTURE ONLY/);
    assert.match(calls[0].prompt, /EXPLICIT MATCHED PDF QUOTE FIXTURE 0/);
    assert.doesNotMatch(calls[0].prompt, /DO NOT SEND|OPTIONAL PRIVATE|NEVER SEND/);
    assert.equal(context.store.snapshot().notes.find((item) => item.id === note.id)!.body, note.body);
  } finally { context.cleanup(); }
});

test("a trashed source paper blocks reading-note AI even when the note references an active paper", async () => {
  const context = setup();
  try {
    const other = context.store.dispatch("paper.create", { title: "ACTIVE reference", abstract: "ACTIVE ABSTRACT" }) as Paper;
    const initial = context.store.snapshot().notes.find((note) => note.purpose === "paper")!;
    const note = context.store.dispatch("note.update", { id: initial.id, revision: initial.revision,
      body: `我的原稿公式 $x^2$。\n\n[参考文献](kb://paper/${other.id})` }) as Note;
    context.store.dispatch("paper.trash", { id: context.paper.id, revision: context.paper.revision });
    const calls = transport();
    const before = context.store.snapshot();
    const isTrashed = (error: unknown) => error instanceof StoreError && error.status === 409 && /所属文献已在回收站/.test(error.message);
    assert.throws(() => getNoteAssistContext(context.store, note.id), isTrashed);
    await assert.rejects(generateNoteAssistance(context.input({ noteId: note.id, revision: note.revision })), isTrashed);
    assert.equal(calls.length, 0);
    assert.deepEqual(context.store.snapshot(), before);
  } finally { context.cleanup(); }
});

test("moving a paper to trash while reading-note AI is running saves no new suggestion", async () => {
  const context = setup();
  try {
    const initial = context.store.snapshot().notes.find((note) => note.purpose === "paper")!;
    const note = context.store.dispatch("note.update", { id: initial.id, revision: initial.revision, body: "正在整理的原稿 $x^2$。" }) as Note;
    const calls = transport(() => {
      context.store.dispatch("paper.trash", { id: context.paper.id, revision: context.paper.revision });
      return result();
    });
    await assert.rejects(generateNoteAssistance(context.input({ noteId: note.id, revision: note.revision })),
      (error: unknown) => error instanceof StoreError && error.status === 409 && /回收站/.test(error.message));
    assert.equal(calls.length, 1);
    assert.equal(savedCount(context), 0);
    assert.equal(context.store.snapshot().notes.find((item) => item.id === note.id)!.body, note.body);
  } finally { context.cleanup(); }
});

test("AI output cannot invent source IDs or label personal notes as literature", async () => {
  const context = setup();
  try {
    transport(() => ({ ...result(), suggestions: [{ title: "坏引用", body: "测试", basis: "literature", evidenceIds: ["invented-source"] }] }));
    await assert.rejects(generateNoteAssistance(context.input()), /未提供或重复的来源/);
    transport((sources) => ({ ...result(), suggestions: [{ title: "坏文献依据", body: "测试", basis: "literature", evidenceIds: [sources[0].id] }] }));
    await assert.rejects(generateNoteAssistance(context.input()), /缺少实际文献证据/);
    assert.equal(savedCount(context), 0);
    assert.equal(context.store.snapshot().notes.find((note) => note.id === context.note.id)!.body, context.note.body);
  } finally { context.cleanup(); }
});

test("strict output format and protected original content reject unsafe revisions without saving result", async () => {
  const context = setup();
  try {
    transport(() => ({ ...result(), unexpected: "must reject" }));
    await assert.rejects(generateNoteAssistance(context.input()), /返回格式无效/);
    transport(() => ({ ...result(), edits: [{ before: "不存在的片段", after: "改写", reason: "测试" }] }));
    await assert.rejects(generateNoteAssistance(context.input()), /AI 修改与原文不匹配/);
    transport(() => ({ ...result(), edits: [{ before: "验证目标仍需明确。", after: "验证目标已经完成。", reason: "不应修改" }] }));
    await assert.rejects(generateNoteAssistance(context.input({ mode: "advise" })), /研究建议不能修改原稿/);
    const math = context.store.dispatch("note.update", { id: context.note.id, revision: context.note.revision, body: "公式是 $x+y$，待核查。" }) as Note;
    transport(() => ({ ...result(), edits: [{ before: "$x+y$", after: "$x-y$", reason: "测试公式保护" }] }));
    await assert.rejects(generateNoteAssistance(context.input({ revision: math.revision })), /受保护内容/);
    assert.equal(savedCount(context), 0);
  } finally { context.cleanup(); }
});

test("suggestion Markdown cannot introduce an unknown library reference or a new external link", async () => {
  const context = setup();
  try {
    for (const body of ["[虚构论文](kb://paper/00000000-0000-4000-8000-000000000000)",
      "请读 https://invented-research-fixture.invalid/a", "![虚构图片](/api/kb/image?id=00000000-0000-4000-8000-000000000000)"]) {
      transport(() => ({ ...result(), suggestions: [{ title: "不应出现的新链接", body, basis: "hypothesis", evidenceIds: [] }] }));
      await assert.rejects(generateNoteAssistance(context.input()), /未提供的链接或引用/);
    }
    transport(() => ({ ...result(), suggestions: [{ title: "已选择的文献", body: `[关联论文](kb://paper/${context.paper.id})`, basis: "hypothesis", evidenceIds: [] }] }));
    await generateNoteAssistance(context.input({ paperIds: [context.paper.id] }));
    assert.equal(savedCount(context), 1);
  } finally { context.cleanup(); }
});

test("typing during generation never changes immutable base or overwrites the newer human note", async () => {
  const context = setup();
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const invoked = new Promise<void>((resolve) => { started = resolve; });
    transport(async () => { started(); await held; return { ...result(), edits: [{ before: "验证目标仍需明确。", after: "验证目标尚待明确。", reason: "微调措辞" }] }; });
    const generating = generateNoteAssistance(context.input({ mode: "polish" }));
    await invoked;
    const newer = context.store.dispatch("note.update", { id: context.note.id, revision: context.note.revision,
      body: `${context.note.body}\n\nHUMAN KEEPS TYPING DURING REQUEST` }) as Note;
    release();
    const record = await generating;
    assert.equal(record.baseRevision, context.note.revision);
    assert.equal(record.baseBody, context.note.body);
    assert.equal(context.store.snapshot().notes.find((note) => note.id === context.note.id)!.body, newer.body);
    assert.equal(savedCount(context), 1);
  } finally { context.cleanup(); }
});

test("oversized sources are rejected explicitly; a valid selection can process a large note", async () => {
  const context = setup();
  try {
    const large = context.store.dispatch("note.update", { id: context.note.id, revision: context.note.revision, body: `小选段。${"字".repeat(40_000)}` }) as Note;
    const calls = transport();
    await assert.rejects(generateNoteAssistance(context.input({ revision: large.revision })), /超过 4 万字符/);
    await generateNoteAssistance(context.input({ revision: large.revision, selection: { from: 0, to: 4, text: "小选段。" } }));
    context.store.dispatch("note.update", { id: context.idea.id, revision: context.idea.revision, body: "a".repeat(120_000) });
    await assert.rejects(generateNoteAssistance(context.input({ revision: large.revision,
      selection: { from: 0, to: 4, text: "小选段。" }, ideaIds: [context.idea.id] })), /超过 12 万字符/);
    assert.equal(calls.length, 1);
  } finally { context.cleanup(); }
});

test("provider settings route through common transport; unavailable configuration and diagnostics remain safe", async () => {
  const context = setup();
  try {
    process.env.KB_AI_PROVIDER = "none";
    const calls = transport();
    await assert.rejects(generateNoteAssistance(context.input()), /请先在设置中配置/);
    assert.equal(calls.length, 0);
    process.env.KB_AI_PROVIDER = "openai-compatible";
    process.env.KB_OPENAI_URL = "https://explicit-model-fixture.invalid/v1";
    process.env.KB_OPENAI_MODEL = "explicit-compatible-fixture";
    const record = await generateNoteAssistance(context.input());
    assert.equal(record.provider, "openai-compatible");
    assert.equal(record.model, "explicit-compatible-fixture");
    assert.equal(calls[0].url, "https://explicit-model-fixture.invalid/v1/chat/completions");
    transport(() => { throw new Error("SECRET RAW NETWORK PAYLOAD"); });
    await assert.rejects(generateNoteAssistance(context.input()), (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /SECRET|导读|分段/);
      assert.match(error.message, /原稿保留/);
      return true;
    });
    assert.equal(savedCount(context), 1);
  } finally { context.cleanup(); }
});

test("cancellation before and after transport completion saves no new AI results", async () => {
  const context = setup();
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    const calls = transport();
    await assert.rejects(generateNoteAssistance(context.input(), cancelled.signal), (error: unknown) => error instanceof StoreError && error.status === 499);
    assert.equal(calls.length, 0);
    const during = new AbortController();
    transport(() => { during.abort(); return result(); });
    await assert.rejects(generateNoteAssistance(context.input(), during.signal), /已取消/);
    assert.equal(savedCount(context), 0);
    assert.equal(context.store.snapshot().notes.find((note) => note.id === context.note.id)!.body, context.note.body);
  } finally { context.cleanup(); }
});

test("idea assistance derives candidates from its associated problem and uses the idea-specific brief", async () => {
  const context = setup();
  try {
    const metadata = getNoteAssistContext(context.store, context.idea.id);
    assert.equal(metadata.topic?.id, context.topic.id);
    assert.deepEqual(metadata.papers.map((paper) => paper.id), [context.paper.id]);
    assert.deepEqual(metadata.ideas, []);
    const calls = transport();
    await generateNoteAssistance(context.input({ noteId: context.idea.id, revision: context.idea.revision, mode: "advise" }));
    assert.match(calls[0].prompt, /核心机制、必要条件、失败方式和最小验证步骤/);
    assert.match(calls[0].prompt, /OPTIONAL PRIVATE IDEA BODY/);
    assert.doesNotMatch(calls[0].prompt, /验证目标仍需明确|NEVER SEND/);
  } finally { context.cleanup(); }
});

test("Codex uses the isolated CLI transport and strict schema, without real login/model/network", async () => {
  const context = setup();
  try {
    const executable = path.join(context.root, "explicit codex fixture.mjs");
    const log = path.join(context.root, "cli-call.json");
    const script = `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2); let input=''; for await(const chunk of process.stdin)input+=chunk;
const index=args.indexOf('--output-schema');
fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({args,input,cwd:process.cwd(),schema:JSON.parse(fs.readFileSync(args[index+1],'utf8'))}));
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
emit({type:'thread.started',model:'explicit-cli-fixture'});
emit({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(result()))}}});
emit({type:'turn.completed'});\n`;
    writeFileSync(executable, script); chmodSync(executable, 0o700);
    process.env.KB_AI_PROVIDER = "codex";
    process.env.KB_CODEX_BIN = executable;
    process.env.KB_CODEX_MODEL = "explicit-cli-fixture";
    const record = await generateNoteAssistance(context.input());
    assert.equal(record.provider, "codex");
    assert.equal(record.model, "explicit-cli-fixture");
    const invocation = JSON.parse(readFileSync(log, "utf8")) as { args: string[]; input: string; cwd: string; schema: { additionalProperties: boolean; required: string[] } };
    assert.ok(invocation.args.includes('--ignore-user-config'));
    assert.ok(invocation.args.includes('features.shell_tool=false'));
    assert.ok(invocation.args.includes('web_search="disabled"'));
    assert.notEqual(invocation.cwd, context.root);
    assert.equal(invocation.schema.additionalProperties, false);
    assert.deepEqual(invocation.schema.required, ["overview", "edits", "suggestions"]);
    assert.doesNotMatch(invocation.input, /OPTIONAL PRIVATE|NEVER SEND/);
  } finally { context.cleanup(); }
});
