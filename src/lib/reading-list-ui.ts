import type { Paper, ReadingListOperation } from "./types";
export type { ReadingListOperation } from "./types";
export type ReadingListMembershipOperation = Extract<ReadingListOperation, "add" | "remove">;

/** Hidden rows must never be included in a batch action. */
export function visibleSelection(papers: readonly Paper[], selectedIds: readonly string[]): Paper[] {
  const selected = new Set(selectedIds);
  return papers.filter((paper) => !paper.deletedAt && selected.has(paper.id));
}

export function readingListMessage(operation: ReadingListMembershipOperation, count: number): string {
  return operation === "add" ? `已将 ${count} 篇文献加入待阅读。`
    : `已将 ${count} 篇文献移出待阅读。`;
}
