import { createHash } from "node:crypto";
import type { KBStore } from "../db";
import type { Note } from "../types";
import { StoreError } from "../store-error";
import { assertSafeInsertion } from "../note-assist/patches";
import { ideaSummaryApplySchema, ideaSummarySchema } from "./schemas";
import { ideaSummarySnapshot, requireIdeaNote, requireIdeaSummary } from "./store";
import type { IdeaSourceSnapshot, IdeaSummary, IdeaSummarySection } from "./types";

export interface PreparedIdeaSummaryApply {
  summary: IdeaSummary;
  sections: IdeaSummarySection[];
  existing?: Note;
  update?: { id: string; revision: number; title?: string; body: string };
  create?: { title: string; body: string; purpose: "idea"; paperIds?: string[]; topicIds?: string[] };
  requestId: string;
  requestFingerprint: string;
  sectionIds: string[];
}
function currentNote(store: KBStore, id: string): Note {
  const row = store.db.prepare("SELECT * FROM notes WHERE id=?").get(id);
  if (!row) throw new StoreError("采纳目标笔记不存在", 404);
  return { id: String(row.id), title: String(row.title), body: String(row.body), purpose: row.purpose as Note["purpose"],
    revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
const markdownLabel = (text: string) => text.replace(/[\r\n]+/g, " ").replace(/[\\\[\]]/g, "\\$&");
function sourceCaption(source: IdeaSourceSnapshot): string {
  const scope = source.type === "paper" ? "论文摘要" : source.type === "annotation"
    ? source.field === "quote" ? `PDF 选段 · 物理第 ${(source.pageIndex ?? 0) + 1} 页` : "个人批注评论"
    : source.type === "topic" ? source.field === "description" ? "研究问题描述" : "综合笔记" : "个人笔记";
  return `${source.title}（${scope}）`;
}
export function renderIdeaSummary(summary: IdeaSummary, sections: readonly IdeaSummarySection[], ownerTitle: string): string {
  const chosen = new Set(sections.flatMap((section) => section.sourceIds));
  const sources = summary.sources.filter((source) => chosen.has(source.id));
  return [
    `## ${markdownLabel(summary.title)}`,
    ...sections.map((section) => `### ${markdownLabel(section.title)}\n\n${section.body}`),
    ...(sources.length ? ["### 本次采用的资料\n\n" + sources.map((source) =>
      `- [${markdownLabel(sourceCaption(source))}](${source.sourceHref})`).join("\n")] : []),
    `> 整理来源：[${markdownLabel(ownerTitle)}](kb://note/${summary.noteId}) · ${summary.createdAt.slice(0, 10)}。讨论中的推测仍需验证。`,
  ].join("\n\n");
}

/** Called inside KBStore's note/mirror transaction, before any human text is changed. */
export function prepareIdeaSummaryApply(store: KBStore, input: unknown): PreparedIdeaSummaryApply {
  const request = ideaSummaryApplySchema.parse(input);
  const owner = requireIdeaNote(store, request.noteId);
  const summary = requireIdeaSummary(store, request.noteId, request.summaryId);
  const sectionIds = [...request.sectionIds].sort();
  const sections = summary.sections.filter((section) => sectionIds.includes(section.id));
  if (sections.length !== sectionIds.length) throw new StoreError("所选段落不属于此整理稿", 422);
  const requestFingerprint = createHash("sha256").update(JSON.stringify({
    noteId: request.noteId, summaryId: request.summaryId, destination: request.destination, sectionIds,
  })).digest("hex");
  const prepared: PreparedIdeaSummaryApply = { summary, sections, requestId: request.requestId, requestFingerprint, sectionIds };
  for (const other of ideaSummarySnapshot(store, request.noteId)) {
    const prior = other.applications.find((application) => application.requestId === request.requestId);
    if (!prior) continue;
    if (other.id !== summary.id || prior.requestFingerprint !== requestFingerprint)
      throw new StoreError("请求 ID 已用于不同的采纳操作", 409);
    return { ...prepared, existing: currentNote(store, prior.targetNoteId) };
  }
  const content = renderIdeaSummary(summary, sections, owner.title);
  if (request.destination.kind === "new") {
    return { ...prepared, create: { title: request.destination.title || summary.title,
      body: content, purpose: "idea" } };
  }
  let targetId = owner.id;
  if (request.destination.kind === "topic") {
    const topic = store.db.prepare("SELECT note_id FROM topics WHERE id=?").get(request.destination.topicId!);
    if (!topic) throw new StoreError("目标研究问题不存在", 404);
    targetId = String(topic.note_id);
  }
  const note = currentNote(store, targetId);
  if (request.revision !== note.revision) throw new StoreError("目标笔记已更新，请刷新后再次采纳；原稿保留", 409);
  if (request.destination.kind === "topic" && note.purpose !== "topic") throw new StoreError("研究问题的综合笔记用途不一致", 422);
  if (summary.applications.some((application) => application.targetNoteId === targetId &&
      application.sectionIds.some((id) => sectionIds.includes(id))))
    throw new StoreError("这些段落已写入目标笔记，请选择其他段落；未重复追加", 409);
  assertSafeInsertion(note.body, note.body.length);
  const body = note.body + (note.body ? "\n\n" : "") + content;
  // Unclosed fenced code/math can absorb an appended block even at the old EOF.
  if (note.body) {
    try { assertSafeInsertion(body, note.body.length + 1); }
    catch { throw new StoreError("笔记末尾仍在代码或公式等结构内部，请先闭合后再追加；原稿保留", 422); }
  }
  return { ...prepared, update: { id: note.id, revision: note.revision,
    body } };
}

export function finalizeIdeaSummaryApply(store: KBStore, prepared: PreparedIdeaSummaryApply, note: Note): void {
  if (prepared.existing) return;
  const current = requireIdeaSummary(store, prepared.summary.noteId, prepared.summary.id);
  if (JSON.stringify(current) !== JSON.stringify(prepared.summary)) throw new StoreError("整理稿已在其他窗口更新，请刷新", 409);
  const value = ideaSummarySchema.parse({ ...current, applications: [...current.applications, {
    requestId: prepared.requestId, requestFingerprint: prepared.requestFingerprint, targetNoteId: note.id,
    sectionIds: prepared.sectionIds, createdAt: new Date().toISOString(),
  }] });
  const updated = store.db.prepare("UPDATE idea_lab_summaries SET data=? WHERE id=? AND note_id=? AND data=?")
    .run(JSON.stringify(value), value.id, value.noteId, JSON.stringify(current));
  if (!updated.changes) throw new StoreError("整理稿已在其他窗口更新，请刷新", 409);
}
