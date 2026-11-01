import type { AnnotationTextSegment } from "../../lib/types";
import {
  aggregateTextSegments,
  MAX_ANNOTATION_RECTS,
  MAX_ANNOTATION_TEXT,
  MAX_TEXT_SEGMENTS,
} from "../../lib/annotation-segments";
import type { PdfSelection } from "./types";

export interface PdfDraft extends PdfSelection {
  kind: "highlight" | "region";
  textSegments?: AnnotationTextSegment[];
}

export interface DraftSelectionResult {
  draft: PdfDraft | null;
  status: "created" | "appended" | "duplicate" | "rejected";
  message?: string;
}

export function draftTextSegments(draft: PdfDraft): AnnotationTextSegment[] {
  return draft.kind === "highlight"
    ? (draft.textSegments ?? [
        { rects: draft.rects, selectedText: draft.selectedText },
      ])
    : [];
}

export function sameTextSegment(
  left: AnnotationTextSegment,
  right: AnnotationTextSegment,
) {
  return (
    left.selectedText === right.selectedText &&
    left.rects.length === right.rects.length &&
    left.rects.every((rect, index) => {
      const other = right.rects[index];
      return (
        Math.abs(rect.x - other.x) < 0.00001 &&
        Math.abs(rect.y - other.y) < 0.00001 &&
        Math.abs(rect.width - other.width) < 0.00001 &&
        Math.abs(rect.height - other.height) < 0.00001
      );
    })
  );
}

/** Never replace a pending comment's source when the user selects more text. */
export function appendDraftSelection(
  current: PdfDraft | null,
  incoming: PdfDraft,
  { saving = false }: { saving?: boolean } = {},
): DraftSelectionResult {
  const reject = (message: string): DraftSelectionResult => ({
    draft: current,
    status: "rejected",
    message,
  });
  if (saving) return reject("正在保存批注，请稍候再选择文字。");
  if (
    current &&
    (current.paperId !== incoming.paperId ||
      current.attachmentId !== incoming.attachmentId ||
      current.pageIndex !== incoming.pageIndex)
  ) {
    return reject(
      "当前批注只合并同一附件、同一物理页的文字；请先保存或取消，再批注其他页或附件。原评论已保留。",
    );
  }
  if (
    current &&
    (current.kind !== "highlight" || incoming.kind !== "highlight")
  ) {
    return reject(
      "文字高亮与区域批注不能合并；请先保存或取消当前批注。原评论已保留。",
    );
  }
  if (incoming.kind === "region") {
    return { draft: incoming, status: "created" };
  }
  const previous = current ? draftTextSegments(current) : [];
  const additions = draftTextSegments(incoming);
  if (
    !additions.length ||
    additions.some(
      (segment) => !segment.selectedText.trim() || !segment.rects.length,
    )
  ) {
    return reject("选区没有可保存的原文和位置，请重新选择。");
  }
  const segments = [...previous];
  for (const segment of additions) {
    if (!segments.some((existing) => sameTextSegment(existing, segment))) {
      segments.push(segment);
    }
  }
  if (segments.length === previous.length) {
    return { draft: current, status: "duplicate" };
  }
  const summary = aggregateTextSegments(segments);
  if (segments.length > MAX_TEXT_SEGMENTS) {
    return reject(
      `一条批注最多合并 ${MAX_TEXT_SEGMENTS} 处文字，请先保存当前批注。`,
    );
  }
  if (
    summary.rects.length > MAX_ANNOTATION_RECTS ||
    summary.selectedText.length > MAX_ANNOTATION_TEXT
  ) {
    return reject(
      "当前批注的选文过长，请先保存，再创建下一条批注。已有选段与评论已保留。",
    );
  }
  return {
    draft: { ...(current ?? incoming), ...summary, textSegments: segments },
    status: current ? "appended" : "created",
  };
}

/** A normal drag starts a fresh selection; only an explicit modifier appends. */
export function selectDraftSelection(
  current: PdfDraft | null,
  incoming: PdfDraft,
  {
    append = false,
    saving = false,
    hasComment = false,
  }: { append?: boolean; saving?: boolean; hasComment?: boolean } = {},
): DraftSelectionResult {
  if (append || saving) return appendDraftSelection(current, incoming, { saving });
  const next = appendDraftSelection(null, incoming);
  if (next.status === "rejected") return { ...next, draft: current };
  if (!current) return next;
  const sameSource = current.paperId === incoming.paperId &&
    current.attachmentId === incoming.attachmentId &&
    current.pageIndex === incoming.pageIndex && current.kind === incoming.kind;
  const previous = draftTextSegments(current);
  const additions = draftTextSegments(incoming);
  if (sameSource && current.kind === "highlight" && previous.length === additions.length &&
    previous.every((segment, index) => sameTextSegment(segment, additions[index]))) {
    return { draft: current, status: "duplicate" };
  }
  if (hasComment) {
    return {
      draft: current,
      status: "rejected",
      message: "当前批注有未保存的评论，请先保存或取消，再替换选文。按住 ⌘（Windows / Linux 为 Ctrl）可追加本页选文；原选文和评论已保留。",
    };
  }
  return next;
}

export function shouldAppendPdfSelection(
  modifiers: { metaKey: boolean; ctrlKey: boolean },
  platform: string,
): boolean {
  return modifiers.metaKey || (modifiers.ctrlKey && !/Mac|iPhone|iPad|iPod/i.test(platform));
}

/** Undo preserves earlier excerpts; removing the only excerpt cancels the draft. */
export function removeLastDraftSegment(
  draft: PdfDraft,
  saving = false,
): PdfDraft | null {
  if (saving || draft.kind !== "highlight") return draft;
  const textSegments = draftTextSegments(draft).slice(0, -1);
  return textSegments.length
    ? { ...draft, ...aggregateTextSegments(textSegments), textSegments }
    : null;
}
