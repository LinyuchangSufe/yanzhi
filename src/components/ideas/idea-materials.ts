import type { KBState } from "../../lib/types";
import type { IdeaSourceInput, IdeaSourceSnapshot } from "../../lib/idea-lab/types";
import type { ExternalDiscussion } from "../../lib/codex-import/types";
import { externalDiscussionBody, externalDiscussionTurnStatuses, guideEvidenceProblem, guideEvidenceSourceInput } from "../../lib/idea-lab/source-details";
import { ideaSourceInputSchema } from "../../lib/idea-lab/schemas";

export interface IdeaMaterial {
  key: string;
  input: IdeaSourceInput;
  title: string;
  label: string;
  text: string;
  sourceHref: string;
  related: boolean;
  disabledReason?: string;
  explanation?: string;
}
export interface SelectedIdeaMaterial extends IdeaMaterial {}

export function materialKey(input: IdeaSourceInput): string {
  return `${input.type}:${input.id}${input.type === "guideEvidence" ? `:${input.evidenceId}` : input.type === "externalDiscussion" ? `:r${input.revision}` : ""}:${input.field}:${input.start ?? "full"}:${input.end ?? "full"}`;
}
function associated(state: KBState, noteId: string, type: string, id: string) {
  return state.relations.some((item) => item.purpose !== "reference" &&
    ((item.fromType === "note" && item.fromId === noteId && item.toType === type && item.toId === id) ||
     (item.toType === "note" && item.toId === noteId && item.fromType === type && item.fromId === id)));
}

/** Candidate text stays local until the user explicitly adds it and sends a turn. */
export function ideaMaterials(state: KBState & { externalDiscussions?: ExternalDiscussion[] }, currentNoteId: string): IdeaMaterial[] {
  const activePapers = new Set(state.papers.filter((paper) => !paper.deletedAt).map((paper) => paper.id));
  const topics = new Map(state.topics.map((topic) => [topic.noteId, topic]));
  const result: IdeaMaterial[] = [];
  const add = (input: IdeaSourceInput, title: string, label: string, text: string, href: string, related: boolean,
    details: Pick<IdeaMaterial, "disabledReason" | "explanation"> = {}) =>
    result.push({ key: materialKey(input), input, title, label, text, sourceHref: href, related, ...details });
  for (const paper of state.papers) {
    if (!activePapers.has(paper.id)) continue;
    add({ type: "paper", id: paper.id, revision: paper.revision, field: "abstract" }, paper.title,
      "论文摘要 · 不含 PDF 全文", paper.abstract, `kb://paper/${paper.id}`, associated(state, currentNoteId, "paper", paper.id));
  }
  for (const note of state.notes) {
    if (note.id === currentNoteId || topics.has(note.id)) continue;
    if (note.purpose === "paper" && state.relations.some((item) => item.purpose !== "reference" &&
      ((item.fromType === "note" && item.fromId === note.id && item.toType === "paper" && !activePapers.has(item.toId)) ||
       (item.toType === "note" && item.toId === note.id && item.fromType === "paper" && !activePapers.has(item.fromId))))) continue;
    add({ type: "note", id: note.id, revision: note.revision, field: "body" }, note.title,
      note.purpose === "idea" ? "已有想法" : "论文笔记", note.body, `kb://note/${note.id}`, associated(state, currentNoteId, "note", note.id));
  }
  for (const topic of state.topics) {
    const related = associated(state, currentNoteId, "topic", topic.id);
    add({ type: "topic", id: topic.id, revision: topic.revision, field: "description" }, topic.title,
      "研究问题 · 描述", topic.description, `kb://topic/${topic.id}`, related);
    const note = state.notes.find((item) => item.id === topic.noteId);
    if (note) add({ type: "topic", id: topic.id, revision: note.revision, field: "body" }, topic.title,
      "研究问题 · 综合笔记", note.body, `kb://topic/${topic.id}`, related);
  }
  for (const annotation of state.annotations) {
    if (!activePapers.has(annotation.paperId) || !state.attachments.some((item) => item.id === annotation.attachmentId && item.status === "available")) continue;
    const paper = state.papers.find((item) => item.id === annotation.paperId)!;
    const title = `${paper.title} · 物理第 ${annotation.pageIndex + 1} 页`;
    const related = associated(state, currentNoteId, "paper", paper.id);
    add({ type: "annotation", id: annotation.id, revision: annotation.revision, field: "quote" }, title,
      "批注原文 · 仅已保存选段", annotation.selectedText, `kb://annotation/${annotation.id}`, related);
    if (annotation.comment.trim()) add({ type: "annotation", id: annotation.id, revision: annotation.revision, field: "comment" }, title,
      "批注评论 · 个人判断", annotation.comment, `kb://annotation/${annotation.id}`, related);
  }
  for (const content of state.aiContents) {
    if (!content.guideData || !activePapers.has(content.paperId)) continue;
    for (const evidence of content.guideData.evidence) {
      if (!activePapers.has(evidence.paperId)) continue;
      const paper = state.papers.find((item) => item.id === evidence.paperId)!;
      add(guideEvidenceSourceInput(content.id, evidence.id), `${paper.title} · ${evidence.title} · 物理第 ${evidence.pageIndex + 1} 页`,
        "导读原文证据 · 不含 AI 解释", evidence.quote, `kb://ai/${content.id}`, associated(state, currentNoteId, "paper", paper.id),
        { disabledReason: guideEvidenceProblem(state, content, evidence), explanation: evidence.explanation });
    }
  }
  for (const discussion of state.externalDiscussions ?? []) {
    const invalid = discussion.sourceHref !== `codex://threads/${encodeURIComponent(discussion.threadId)}` || !/^[a-f0-9]{64}$/.test(discussion.hash);
    const partial = Object.values(externalDiscussionTurnStatuses(discussion.selectedTurnIds, discussion.turnStatuses)).some((status) => status !== "completed");
    add({ type: "externalDiscussion", id: discussion.id, revision: discussion.revision, field: "body" }, discussion.title,
      `外部讨论 · Codex 用户与 AI 正文${partial ? " · 部分轮次未完成或状态未知，仅当时公开正文" : ""}`, externalDiscussionBody(discussion.messages), `kb://discussion/${discussion.id}`,
      discussion.noteIds.includes(currentNoteId), { disabledReason: invalid ? "这份讨论的来源或内容指纹已失效，请重新导入。" : "" });
  }
  return result.sort((left, right) => Number(right.related) - Number(left.related));
}

/** Stages only explicit IDs against current saved previews; never adds related materials implicitly. */
export function prepareIdeaMaterials(state: KBState, noteId: string, inputs: readonly IdeaSourceInput[], current: readonly SelectedIdeaMaterial[] = []): SelectedIdeaMaterial[] {
  const candidates = ideaMaterials(state, noteId), selected = [...current];
  for (const raw of inputs) {
    const input = ideaSourceInputSchema.parse(raw);
    let candidate = candidates.find((item) => item.input.type === input.type && item.input.id === input.id &&
      item.input.field === input.field && item.input.evidenceId === input.evidenceId);
    if (candidate && input.type === "externalDiscussion" && candidate.input.revision !== input.revision) {
      const record = state.externalDiscussions?.find((item) => item.id === input.id), version = record?.history.find((item) => item.revision === input.revision);
      if (version && record) {
        const partial = Object.values(externalDiscussionTurnStatuses(record.selectedTurnIds, version.turnStatuses)).some((status) => status !== "completed");
        candidate = { ...candidate, title: version.title, text: externalDiscussionBody(version.messages),
          input: { ...candidate.input, revision: input.revision }, label: `外部讨论 · 历史修订 ${input.revision} · ${partial ? "部分轮次未完成或状态未知，仅当时公开正文" : "当时公开正文"}` };
      }
    }
    if (!candidate || candidate.input.revision !== input.revision) throw new Error("所选资料已不存在或版本改变，请重新预览后选择；原草稿保留。");
    const start = input.start ?? 0, end = input.end ?? candidate.text.length;
    const split = (offset: number) => offset > 0 && offset < candidate.text.length &&
      /[\uD800-\uDBFF]/.test(candidate.text[offset - 1]) && /[\uDC00-\uDFFF]/.test(candidate.text[offset]);
    if (end > candidate.text.length || end <= start || split(start) || split(end)) throw new Error("资料片段范围已失效，请重新选择；原草稿保留。");
    const material = input.start === undefined ? selectIdeaMaterial(candidate) : selectIdeaMaterial(candidate, start, end);
    if (selected.some((item) => item.key === material.key && item.input.revision === material.input.revision)) continue;
    const error = materialAdditionError(selected, material);
    if (error) throw new Error(error);
    selected.push(material);
  }
  return selected;
}

export function selectIdeaMaterial(item: IdeaMaterial, start?: number, end?: number): SelectedIdeaMaterial {
  const input = start === undefined || end === undefined ? { ...item.input } : { ...item.input, start, end };
  return { ...item, input, key: materialKey(input), text: start === undefined ? item.text : item.text.slice(start, end) };
}

export function materialAdditionError(current: readonly SelectedIdeaMaterial[], item: SelectedIdeaMaterial): string {
  if (item.disabledReason) return item.disabledReason;
  if (!item.text.trim()) return "这项资料没有可引用文字；论文可先补摘要，区域批注可选择个人评论。";
  if (current.some((value) => value.key === item.key)) return "这段资料已在本轮选择中。";
  if (item.text.length > 16000) return "单项资料最多 16,000 字符，请选择较短片段。";
  if (current.length >= 8 || current.reduce((sum, value) => sum + value.text.length, item.text.length) > 24000)
    return "本轮最多 8 项、共 24,000 字符，请减少资料或选择片段。";
  return "";
}

/** Availability labels never replace the text already saved with a discussion. */
export function historicalIdeaMaterialProblem(state: KBState, source: IdeaSourceSnapshot): string {
  if (source.type === "guideEvidence") {
    const guide = state.aiContents.find((item) => item.id === source.guideId);
    const evidence = guide?.guideData?.evidence.find((item) => item.id === source.evidenceId);
    if (!guide || !evidence) return "原导读记录已缺失；下方仍是当时保存的原句快照，不能继续作为有效来源发送。";
    return guideEvidenceProblem(state, guide, evidence);
  }
  if (source.type === "externalDiscussion") {
    const record = state.externalDiscussions?.find((item) => item.id === source.entityId);
    const version = record?.revision === source.revision ? record : record?.history.find((item) => item.revision === source.revision);
    if (!record || !version || version.hash !== source.externalContentHash || record.source.id !== source.externalSourceId ||
        record.threadId !== source.sourceThreadId || record.sourceHref !== source.externalSourceHref)
      return "原讨论或所引用修订已缺失；下方仍是当时公开正文的快照，不能继续作为有效来源发送。";
  }
  return "";
}
