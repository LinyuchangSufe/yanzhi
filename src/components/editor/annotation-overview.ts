import type { Annotation } from "../../lib/types";
import { hasAnnotationComment } from "../../lib/annotation-display";

export type AnnotationFilter = "all" | "highlights" | "comments";
export function annotationOverview(annotations: readonly Annotation[], paperId: string) {
  const all = annotations.filter((annotation) => annotation.paperId === paperId);
  return { all, highlights: all.filter((annotation) => !hasAnnotationComment(annotation)), comments: all.filter(hasAnnotationComment) };
}

/** Deletion is physical: do not dispatch anything before a clear confirmation. */
export async function confirmAnnotationDeletion(annotation: Annotation, {
  referenced, confirm, remove,
}: { referenced: boolean; confirm: (message: string) => boolean; remove: () => Promise<void> }): Promise<boolean> {
  if (referenced) throw new Error("这条标注已被笔记引用，请先移除引用后再删除。");
  const label = hasAnnotationComment(annotation) ? "标注及评论" : "高亮标记";
  if (!confirm(`删除第 ${annotation.pageIndex + 1} 页的这条${label}？此操作无法单独撤销，原 PDF 不会修改。`)) return false;
  await remove(); return true;
}
