import type { KBStore } from "../db";
import type { KBState, Note } from "../types";
import { StoreError } from "../store-error";
import type { ChatModelMessage } from "../ai/request";
import type { IdeaMessage, IdeaSourceInput, IdeaSourceSnapshot } from "./types";
import { createHash } from "node:crypto";
import { requireExternalDiscussion, resolveExternalDiscussionSource } from "../codex-import/store";
import { externalDiscussionBody, externalDiscussionTurnStatuses, guideEvidenceProblem, ideaSourceScope } from "./source-details";

export const IDEA_SOURCE_COUNT_LIMIT = 8;
export const IDEA_SOURCE_ITEM_LIMIT = 16000;
export const IDEA_SOURCE_TOTAL_LIMIT = 24000;
export const IDEA_HISTORY_LIMIT = 80000;

function paperIsActive(state: KBState, id: string) {
  const paper = state.papers.find((item) => item.id === id);
  if (!paper) throw new StoreError("所选文献已不存在，请重新选择资料", 409);
  if (paper.deletedAt) throw new StoreError("所选文献已在回收站，请恢复后再引用", 409);
  return paper;
}

function requireReadableNote(state: KBState, note: Note) {
  if (note.purpose !== "paper") return;
  const ownerIds = state.relations.filter((relation) => relation.purpose !== "reference" &&
    ((relation.fromType === "note" && relation.fromId === note.id && relation.toType === "paper") ||
     (relation.toType === "note" && relation.toId === note.id && relation.fromType === "paper")))
    .map((relation) => relation.fromType === "paper" ? relation.fromId : relation.toId);
  for (const id of ownerIds) paperIsActive(state, id);
}

function splitsSurrogate(text: string, offset: number) {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Resolve IDs and ranges against the saved library, never trust client-supplied text. */
export function resolveIdeaSources(store: KBStore, inputs: readonly IdeaSourceInput[]): IdeaSourceSnapshot[] {
  if (inputs.length > IDEA_SOURCE_COUNT_LIMIT) throw new StoreError("本轮最多引用 8 项资料", 400);
  const state = store.snapshot();
  const seen = new Set<string>();
  let total = 0;
  return inputs.map((input) => {
    let title: string, body: string, revision: number, sourceHref: string;
    let attachment: Pick<IdeaSourceSnapshot, "paperId" | "attachmentId" | "attachmentSha256" | "pageIndex" | "pageLabel" | "guideId" | "evidenceId" | "sourceThreadId" | "externalSourceHref" | "externalContentHash" | "externalTurnStatuses" | "externalSourceId"> = {};
    if (input.type === "paper" && input.field === "abstract") {
      const paper = paperIsActive(state, input.id);
      title = paper.title; body = paper.abstract; revision = paper.revision; sourceHref = `kb://paper/${paper.id}`;
      if (!body.trim()) throw new StoreError("这篇文献没有摘要，请先补全摘要，或主动选择批注和笔记；没有读取 PDF 全文", 422);
    } else if (input.type === "note" && input.field === "body") {
      const note = state.notes.find((item) => item.id === input.id);
      if (!note) throw new StoreError("所选笔记或想法已不存在，请重新选择", 409);
      requireReadableNote(state, note);
      title = note.title; body = note.body; revision = note.revision; sourceHref = `kb://note/${note.id}`;
    } else if (input.type === "topic" && ["body", "description"].includes(input.field)) {
      const topic = state.topics.find((item) => item.id === input.id);
      if (!topic) throw new StoreError("所选研究问题已不存在，请重新选择", 409);
      const note = state.notes.find((item) => item.id === topic.noteId);
      if (!note) throw new StoreError("研究问题的综合笔记已不存在", 409);
      title = topic.title;
      body = input.field === "description" ? topic.description : note.body;
      revision = input.field === "description" ? topic.revision : note.revision;
      sourceHref = `kb://topic/${topic.id}`;
    } else if (input.type === "annotation" && ["quote", "comment"].includes(input.field)) {
      const annotation = state.annotations.find((item) => item.id === input.id);
      if (!annotation) throw new StoreError("所选批注已不存在，请重新选择", 409);
      const paper = paperIsActive(state, annotation.paperId);
      const file = state.attachments.find((item) => item.id === annotation.attachmentId && item.paperId === paper.id);
      if (!file || file.status !== "available") throw new StoreError("批注的 PDF 来源缺失，请先恢复附件", 409);
      store.attachmentPath(file.id);
      title = `${paper.title} · 物理第 ${annotation.pageIndex + 1} 页`;
      body = input.field === "quote" ? annotation.selectedText : annotation.comment;
      revision = annotation.revision; sourceHref = `kb://annotation/${annotation.id}`;
      attachment = { paperId: paper.id, attachmentId: file.id, attachmentSha256: file.sha256,
        pageIndex: annotation.pageIndex, pageLabel: annotation.pageLabel };
    } else if (input.type === "guideEvidence" && input.field === "quote" && input.evidenceId) {
      const content = state.aiContents.find((item) => item.id === input.id);
      const evidence = content?.guideData?.evidence.find((item) => item.id === input.evidenceId);
      if (!content || !evidence) throw new StoreError("导读原句证据已不存在，请重新选择；旧快照仍保留", 409);
      const problem = guideEvidenceProblem(state, content, evidence);
      if (problem) throw new StoreError(problem, 409);
      store.attachmentPath(evidence.attachmentId);
      const paper = paperIsActive(state, evidence.paperId);
      title = `${paper.title} · ${evidence.title} · 物理第 ${evidence.pageIndex + 1} 页`;
      body = evidence.quote; revision = 1; sourceHref = `kb://ai/${content.id}`;
      attachment = { paperId: evidence.paperId, attachmentId: evidence.attachmentId, attachmentSha256: evidence.attachmentSha256,
        pageIndex: evidence.pageIndex, pageLabel: evidence.pageLabel, guideId: content.id, evidenceId: evidence.id };
    } else if (input.type === "externalDiscussion" && input.field === "body") {
      const record = requireExternalDiscussion(store, input.id);
      const selected = resolveExternalDiscussionSource(store, { discussionId: record.id, revision: input.revision });
      const version = input.revision === record.revision ? record : record.history.find((item) => item.revision === input.revision)!;
      const hash = createHash("sha256").update(JSON.stringify({ threadId: record.threadId, selectedTurnIds: record.selectedTurnIds, messages: selected.messages })).digest("hex");
      if (hash !== selected.hash || record.sourceHref !== `codex://threads/${encodeURIComponent(record.threadId)}`)
        throw new StoreError("已导入讨论的正文或来源校验失败，请重新导入", 409);
      title = selected.title; body = externalDiscussionBody(selected.messages); revision = selected.revision; sourceHref = `kb://discussion/${record.id}`;
      attachment = { sourceThreadId: record.threadId, externalSourceHref: record.sourceHref, externalContentHash: selected.hash,
        externalTurnStatuses: externalDiscussionTurnStatuses(record.selectedTurnIds, version.turnStatuses), externalSourceId: record.source.id };
    } else throw new StoreError("资料类型与读取范围不匹配", 400);
    if (revision !== input.revision) throw new StoreError("所选资料已更新，请重新预览并选择后发送", 409);
    const start = input.start ?? 0, end = input.end ?? body.length;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > body.length ||
        splitsSurrogate(body, start) || splitsSurrogate(body, end)) throw new StoreError("资料片段范围已失效，请重新选择", 400);
    const text = body.slice(start, end);
    if (!text.trim()) throw new StoreError("所选资料没有可引用内容，请选择摘要、原文或已有文字", 422);
    if (text.length > IDEA_SOURCE_ITEM_LIMIT) throw new StoreError("单项资料超过 16000 字符，请选择较短片段；没有截断原文", 413);
    total += text.length;
    if (total > IDEA_SOURCE_TOTAL_LIMIT) throw new StoreError("本轮资料合计超过 24000 字符，请减少资料；没有截断原文", 413);
    const id = `${input.type}:${input.id}${input.type === "guideEvidence" ? `:${input.evidenceId}` : ""}:${input.field}:${start}:${end}:r${revision}`;
    if (seen.has(id)) throw new StoreError("本轮资料包含重复片段，请移除重复项", 400);
    seen.add(id);
    return { id, type: input.type, entityId: input.id, field: input.field, title: title.slice(0, 1000), text,
      sourceHref, revision, start, end, ...attachment };
  });
}

export function ideaUserContent(body: string, sources: readonly IdeaSourceSnapshot[]) {
  return JSON.stringify({ question: body, selectedMaterials: sources.map((source) => ({
    ...source, readingScope: ideaSourceScope(source),
  })) });
}

/** Also used while restoring a backup before its conversations have been fully inserted. */
export function assertExternalIdeaSource(store: KBStore, source: IdeaSourceSnapshot): void {
  const record = requireExternalDiscussion(store, source.entityId);
  const original = resolveExternalDiscussionSource(store, { discussionId: record.id, revision: source.revision });
  const version = source.revision === record.revision ? record : record.history.find((item) => item.revision === source.revision)!;
  if (record.threadId !== source.sourceThreadId || record.source.id !== source.externalSourceId || record.sourceHref !== source.externalSourceHref ||
      original.hash !== source.externalContentHash || externalDiscussionBody(original.messages).slice(source.start, source.end) !== source.text)
    throw new StoreError("历史外部讨论来源或修订已缺失，请重新选择；原引用快照仍保留", 409);
  const hash = createHash("sha256").update(JSON.stringify({ threadId: record.threadId, selectedTurnIds: record.selectedTurnIds, messages: original.messages })).digest("hex");
  if (hash !== original.hash) throw new StoreError("历史外部讨论内容校验失败，原引用快照仍保留", 409);
  const statuses = externalDiscussionTurnStatuses(record.selectedTurnIds, version.turnStatuses);
  if (!source.externalTurnStatuses || Object.keys(statuses).length !== Object.keys(source.externalTurnStatuses).length ||
      Object.entries(statuses).some(([id, status]) => source.externalTurnStatuses?.[id] !== status))
    throw new StoreError("外部讨论快照的完成状态与原修订不一致，原引用快照仍保留", 409);
}

/** Text revisions remain immutable snapshots; recycled or changed PDF sources are rechecked. */
export function assertIdeaSourcesAvailable(store: KBStore, sources: readonly IdeaSourceSnapshot[]) {
  const state = store.snapshot();
  for (const source of sources) {
    if (source.type === "paper") paperIsActive(state, source.entityId);
    if (source.paperId) paperIsActive(state, source.paperId);
    if (source.type === "note") {
      const note = state.notes.find((item) => item.id === source.entityId);
      if (!note) throw new StoreError("历史引用的笔记已不存在，请新建讨论并重新选择资料", 409);
      requireReadableNote(state, note);
    }
    if (source.type === "topic" && !state.topics.some((item) => item.id === source.entityId))
      throw new StoreError("历史引用的研究问题已不存在，请新建讨论并重新选择资料", 409);
    if (source.type === "annotation") {
      const annotation = state.annotations.find((item) => item.id === source.entityId);
      if (!annotation || annotation.paperId !== source.paperId || annotation.attachmentId !== source.attachmentId || annotation.pageIndex !== source.pageIndex)
        throw new StoreError("历史引用的批注已不存在或来源改变，请新建讨论并重新选择资料", 409);
    }
    if (source.type === "guideEvidence") {
      const guide = state.aiContents.find((item) => item.id === source.guideId && item.id === source.entityId);
      const evidence = guide?.guideData?.evidence.find((item) => item.id === source.evidenceId);
      if (!guide || !evidence || guideEvidenceProblem(state, guide, evidence) || evidence.paperId !== source.paperId ||
          evidence.attachmentId !== source.attachmentId || evidence.attachmentSha256 !== source.attachmentSha256 || evidence.pageIndex !== source.pageIndex ||
          evidence.quote.slice(source.start, source.end) !== source.text)
        throw new StoreError("历史导读证据已缺失或来源改变，请新建对话并重新选择；原引用快照仍保留", 409);
    }
    if (source.type === "externalDiscussion") assertExternalIdeaSource(store, source);
    if (source.attachmentId) {
      const file = state.attachments.find((item) => item.id === source.attachmentId);
      if (!file || file.sha256 !== source.attachmentSha256 || file.paperId !== source.paperId)
        throw new StoreError("批注来源附件已变化，未将本次回复标记完成", 409);
      store.attachmentPath(file.id);
    }
  }
}

/** A complete saved turn is retained intact; exceeding the bound asks for a new discussion. */
export function completedIdeaMessages(messages: readonly IdeaMessage[]): IdeaMessage[] {
  const completed: IdeaMessage[] = [];
  let pendingUser: IdeaMessage | undefined;
  for (const message of messages) {
    if (message.role === "user") { pendingUser = message; continue; }
    if (pendingUser?.status === "completed" && message.status === "completed") {
      completed.push(pendingUser, message);
    }
    pendingUser = undefined;
  }
  return completed;
}

export function ideaHistory(messages: readonly IdeaMessage[]): { messages: ChatModelMessage[]; characters: number } {
  const history: ChatModelMessage[] = completedIdeaMessages(messages).map((message) => ({ role: message.role,
    content: message.role === "user" ? ideaUserContent(message.body, message.sources) : message.body }));
  const characters = JSON.stringify(history).length;
  if (characters > IDEA_HISTORY_LIMIT) throw new StoreError("讨论历史较长，已保留全部记录。请新建讨论并主动引用需要的阶段笔记；没有静默截断历史", 413);
  return { messages: history, characters };
}
