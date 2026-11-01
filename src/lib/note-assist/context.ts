import { StoreError, type KBStore } from "../db";
import type { GuideEvidence } from "../guide/types";
import type { KBState, Note, Topic } from "../types";
import type {
  NoteAssistContext,
  NoteAssistSelection,
  NoteAssistSource,
} from "./types";

export const NOTE_TEXT_LIMIT = 40_000;
export const TOTAL_CONTEXT_LIMIT = 120_000;

function linkedIds(
  state: KBState,
  type: "note" | "topic",
  id: string,
  otherType: "note" | "topic" | "paper",
  includeReferences = true,
) {
  return state.relations.flatMap((relation) => {
    if (!includeReferences && relation.purpose === "reference") return [];
    if (
      relation.fromType === type &&
      relation.fromId === id &&
      relation.toType === otherType
    )
      return [relation.toId];
    if (
      relation.toType === type &&
      relation.toId === id &&
      relation.fromType === otherType
    )
      return [relation.fromId];
    return [];
  });
}

export function assistNote(state: KBState, noteId: string): Note {
  const note = state.notes.find((item) => item.id === noteId);
  if (!note) throw new StoreError("笔记不存在", 404);
  if (note.purpose === "paper") {
    const ownerIds = new Set(linkedIds(state, "note", note.id, "paper", false));
    const owners = state.papers.filter((paper) => ownerIds.has(paper.id));
    if (owners.length && owners.every((paper) => paper.deletedAt))
      throw new StoreError("笔记所属文献已在回收站，请先恢复后使用 AI 辅助", 409);
  }
  return note;
}

function associatedTopics(state: KBState, note: Note): Topic[] {
  const ids = new Set(linkedIds(state, "note", note.id, "topic"));
  return state.topics
    .filter((topic) => topic.noteId === note.id || ids.has(topic.id))
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
}

function related(state: KBState, note: Note) {
  const topics = associatedTopics(state, note);
  const paperIds = new Set(linkedIds(state, "note", note.id, "paper"));
  const ideaIds = new Set(linkedIds(state, "note", note.id, "note"));
  for (const topic of topics) {
    for (const id of linkedIds(state, "topic", topic.id, "paper"))
      paperIds.add(id);
    for (const id of linkedIds(state, "note", topic.noteId, "paper"))
      paperIds.add(id);
    for (const id of linkedIds(state, "topic", topic.id, "note"))
      ideaIds.add(id);
    for (const id of linkedIds(state, "note", topic.noteId, "note"))
      ideaIds.add(id);
  }
  return {
    topics,
    papers: state.papers.filter(
      (paper) => !paper.deletedAt && paperIds.has(paper.id),
    ),
    ideas: state.notes.filter(
      (idea) =>
        idea.purpose === "idea" && idea.id !== note.id && ideaIds.has(idea.id),
    ),
  };
}

/** Only verified historical quotes, never the AI guide's interpretation. */
function paperEvidence(state: KBState, paperId: string): GuideEvidence[] {
  const found = new Map<string, GuideEvidence>();
  const contents = state.aiContents
    .filter((content) => content.guideData)
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    );
  for (const content of contents) {
    const guide = content.guideData!;
    for (const evidence of guide.evidence) {
      if (found.size >= 6) break;
      const source = guide.sources.find(
        (item) => item.attachmentId === evidence.attachmentId,
      );
      const attachment = state.attachments.find(
        (item) => item.id === evidence.attachmentId,
      );
      if (
        evidence.paperId !== paperId ||
        !evidence.matched ||
        !evidence.quote.trim() ||
        !source ||
        source.paperId !== paperId ||
        !attachment ||
        attachment.paperId !== paperId ||
        attachment.status !== "available" ||
        source.attachmentSha256 !== attachment.sha256 ||
        evidence.attachmentSha256 !== attachment.sha256 ||
        evidence.pageIndex < 0 ||
        evidence.pageIndex >= source.pageCount ||
        !source.parsedPages.includes(evidence.pageIndex) ||
        !evidence.blockId.startsWith(`${attachment.id}:${evidence.pageIndex}:`)
      )
        continue;
      if (!found.has(evidence.id)) found.set(evidence.id, evidence);
    }
  }
  return [...found.values()];
}

/** Candidate metadata only: opening the panel never sends personal text to a model. */
export function getNoteAssistContext(
  store: KBStore,
  noteId: string,
): NoteAssistContext {
  const state = store.snapshot();
  const note = assistNote(state, noteId);
  const context = related(state, note);
  const topic = context.topics[0];
  return {
    topic: topic
      ? { id: topic.id, title: topic.title, description: topic.description }
      : null,
    papers: context.papers.map((paper) => ({
      id: paper.id,
      title: paper.title,
      hasAbstract: Boolean(paper.abstract.trim()),
      evidenceCount: paperEvidence(state, paper.id).length,
    })),
    ideas: context.ideas.map((idea) => ({ id: idea.id, title: idea.title })),
  };
}

export function buildNoteAssistSources(
  store: KBStore,
  state: KBState,
  note: Note,
  selection: NoteAssistSelection | undefined,
  paperIds: string[],
  ideaIds: string[],
): NoteAssistSource[] {
  const text = selection?.text ?? note.body;
  if (!text.trim())
    throw new StoreError("请先写下文献笔记、研究问题或想法，再使用 AI 辅助", 422);
  if (text.length > NOTE_TEXT_LIMIT)
    throw new StoreError(
      "当前正文或选段超过 4 万字符，请缩小选段后再试；没有截断原文",
      413,
    );
  const context = related(state, note);
  const sources: NoteAssistSource[] = [
    {
      id: `note:${note.id}`,
      kind: "note",
      title: note.title,
      text,
      noteId: note.id,
    },
  ];
  const topic = context.topics[0];
  if (topic)
    sources.push({
      id: `topic:${topic.id}`,
      kind: "topic",
      title: topic.title,
      text: topic.description,
    });
  for (const id of paperIds) {
    if (state.papers.some((paper) => paper.id === id && paper.deletedAt))
      throw new StoreError("所选文献已在回收站，请先恢复后用于 AI 建议", 409);
    const paper = context.papers.find((item) => item.id === id);
    if (!paper)
      throw new StoreError(
        "所选文献未与当前笔记、研究问题或想法关联，请先建立关联",
        422,
      );
    if (paper.abstract.trim())
      sources.push({
        id: `abstract:${paper.id}`,
        kind: "paper-abstract",
        title: paper.title,
        text: paper.abstract,
        paperId: paper.id,
      });
    const evidence = paperEvidence(state, paper.id);
    const verifiedFiles = new Set<string>();
    for (const item of evidence) {
      if (!verifiedFiles.has(item.attachmentId)) {
        // attachmentPath checks the physical file, safe path, and its actual SHA256.
        store.attachmentPath(item.attachmentId);
        verifiedFiles.add(item.attachmentId);
      }
      sources.push({
        id: `evidence:${paper.id}:${item.id}`,
        kind: "pdf-evidence",
        title: paper.title,
        text: item.quote,
        paperId: paper.id,
        attachmentId: item.attachmentId,
        attachmentSha256: item.attachmentSha256,
        pageIndex: item.pageIndex,
        pageLabel: item.pageLabel,
      });
    }
    if (!paper.abstract.trim() && evidence.length === 0)
      throw new StoreError(
        "所选文献没有可用摘要或已验证的 PDF 原文证据，请先补全摘要或生成论文导读",
        422,
      );
  }
  for (const id of ideaIds) {
    const idea = context.ideas.find((item) => item.id === id);
    if (!idea)
      throw new StoreError(
        "所选想法未与当前笔记、研究问题或想法关联，请先建立关联",
        422,
      );
    sources.push({
      id: `idea:${idea.id}`,
      kind: "idea",
      title: idea.title,
      text: idea.body,
      noteId: idea.id,
    });
  }
  if (JSON.stringify(sources).length > TOTAL_CONTEXT_LIMIT)
    throw new StoreError(
      "所选材料合计超过 12 万字符，请减少文献、想法或缩小选段；没有截断资料",
      413,
    );
  return sources;
}
