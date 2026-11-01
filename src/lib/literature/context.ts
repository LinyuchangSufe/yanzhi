import { createHash } from "node:crypto";
import type { KBStore } from "../db";
import type { KBState } from "../types";
import { StoreError } from "../store-error";
import { literatureContextSchema } from "./schemas";
import type { LiteratureContext } from "./types";

export interface ResolvedLiteratureContext {
  context: LiteratureContext; paperIds: string[]; tags: { id: string; name: string }[]; fingerprint: string;
}
export function resolveLiteratureContext(store: KBStore, raw: LiteratureContext = {}, state: KBState = store.snapshot()): ResolvedLiteratureContext {
  const input = literatureContextSchema.parse(raw);
  if (input.noteId && !state.notes.some(note => note.id === input.noteId)) throw new StoreError("来源笔记已不存在，请重新打开后查找文献。", 409);
  const paperIds = [...new Set(input.paperIds ?? (input.noteId ? state.relations.filter(relation => relation.purpose !== "reference" &&
    ((relation.fromType === "note" && relation.fromId === input.noteId && relation.toType === "paper") ||
      (relation.toType === "note" && relation.toId === input.noteId && relation.fromType === "paper")))
    .map(relation => relation.fromType === "paper" ? relation.fromId : relation.toId)
    .filter(id => state.papers.some(paper => paper.id === id && !paper.deletedAt)) : []))].sort();
  if (paperIds.length > 16) throw new StoreError("关联文献超过 16 篇，请明确选择本次继承标签的来源文献。", 400);
  for (const id of paperIds) if (!state.papers.some(paper => paper.id === id && !paper.deletedAt)) throw new StoreError("标签来源文献已不存在或在回收站，请重新选择范围。", 409);
  const tagIds = new Set(state.relations.filter(relation => relation.purpose === "tag" &&
    ((relation.fromType === "paper" && paperIds.includes(relation.fromId) && relation.toType === "tag") ||
      (relation.toType === "paper" && paperIds.includes(relation.toId) && relation.fromType === "tag")))
    .map(relation => relation.fromType === "tag" ? relation.fromId : relation.toId));
  const tags = state.tags.filter(tag => tagIds.has(tag.id)).map(tag => ({ id: tag.id, name: tag.name })).sort((a, b) => a.id.localeCompare(b.id));
  const context = { ...(input.noteId ? { noteId: input.noteId } : {}), ...(input.paperIds ? { paperIds } : {}) };
  const fingerprint = createHash("sha256").update(JSON.stringify({ context, paperIds, tags })).digest("hex");
  return { context, paperIds, tags, fingerprint };
}
