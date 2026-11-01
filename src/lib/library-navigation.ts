import type { Paper } from "./types";

/** Browser-local opening history; it never represents a reading status. */
export function recentPaperIds(
  stored: string | null,
  papers: readonly Pick<Paper, "id" | "deletedAt">[],
): string[] {
  let value: unknown;
  try {
    value = JSON.parse(stored || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string"))
    return [];
  const active = new Set(
    papers.filter((paper) => !paper.deletedAt).map((paper) => paper.id),
  );
  return [...new Set(value)].filter((id) => active.has(id)).slice(0, 50);
}

export function rememberOpenedPaper(
  stored: string | null,
  id: string,
  papers: readonly Pick<Paper, "id" | "deletedAt">[],
): string[] {
  return recentPaperIds(
    JSON.stringify([id, ...recentPaperIds(stored, papers)]), papers,
  );
}

type SortablePaper = Pick<Paper, "id" | "title" | "createdAt" | "updatedAt">;

/** Sorting retains every filtered paper, including papers never opened. */
export function sortLibraryPapers<T extends SortablePaper>(
  papers: readonly T[],
  sort: string,
  recent: readonly string[] = [],
): T[] {
  const rank = new Map(recent.map((id, index) => [id, index]));
  const newest = (a: T, b: T) =>
    b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  return [...papers].sort((a, b) => {
    if (sort === "recent") {
      const aRank = rank.get(a.id);
      const bRank = rank.get(b.id);
      if (aRank !== undefined || bRank !== undefined)
        return (aRank ?? Number.MAX_SAFE_INTEGER) -
          (bRank ?? Number.MAX_SAFE_INTEGER);
    }
    if (sort === "title")
      return a.title.localeCompare(b.title, "zh-CN") || newest(a, b);
    if (sort === "updated")
      return b.updatedAt.localeCompare(a.updatedAt) || newest(a, b);
    return newest(a, b);
  });
}
