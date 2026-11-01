import type { PdfDraft } from "../../components/pdf/annotation-draft";
import type { Annotation } from "../types";
import { MAX_ANNOTATION_RECTS, MAX_ANNOTATION_TEXT, MAX_TEXT_SEGMENTS } from "../annotation-segments";

export interface PendingAnnotation {
  draft: PdfDraft | null;
  comment: string;
  color: string;
  expanded: boolean;
  sha256: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function rects(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_ANNOTATION_RECTS && value.every((rect: unknown) => {
    if (!record(rect)) return false;
    return [rect.x, rect.y, rect.width, rect.height].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1.001) &&
      Number(rect.x) + Number(rect.width) <= 1.001 && Number(rect.y) + Number(rect.height) <= 1.001;
  });
}
/** Recovery never assigns geometry to a different immutable attachment. */
export function isPendingAnnotation(value: unknown): value is PendingAnnotation {
  if (!record(value) || !record(value.draft) || typeof value.comment !== "string" ||
      typeof value.color !== "string" || !/^#[0-9a-f]{6}$/i.test(value.color) ||
      typeof value.expanded !== "boolean" || typeof value.sha256 !== "string") return false;
  const draft = value.draft;
  return (draft.kind === "highlight" || draft.kind === "region") &&
    typeof draft.paperId === "string" && typeof draft.attachmentId === "string" &&
    typeof draft.pageIndex === "number" && Number.isSafeInteger(draft.pageIndex) && draft.pageIndex >= 0 &&
    typeof draft.pageLabel === "string" && typeof draft.selectedText === "string" &&
    draft.selectedText.length <= MAX_ANNOTATION_TEXT && rects(draft.rects) &&
    (draft.textSegments === undefined || (Array.isArray(draft.textSegments) &&
      draft.textSegments.length <= MAX_TEXT_SEGMENTS && draft.textSegments.every((segment: unknown) =>
        record(segment) && typeof segment.selectedText === "string" && rects(segment.rects))));
}

export function matchesDraftAttachment(value: PendingAnnotation, paperId: string,
  attachments: readonly { id: string; sha256: string }[]): boolean {
  return value.draft?.paperId === paperId && attachments.some((item) =>
    item.id === value.draft?.attachmentId && item.sha256 === value.sha256);
}

/** A successful response can be lost on reload; offer the saved record, not a duplicate. */
export function savedAnnotationForDraft(value: PendingAnnotation, annotations: readonly Annotation[]): Annotation | undefined {
  const draft = value.draft;
  if (!draft) return undefined;
  return annotations.find((item) => item.paperId === draft.paperId && item.attachmentId === draft.attachmentId &&
    item.kind === draft.kind && item.pageIndex === draft.pageIndex && item.selectedText === draft.selectedText &&
    item.comment === value.comment && item.color === value.color && item.rects.length === draft.rects.length &&
    item.rects.every((rect, index) => {
      const other = draft.rects[index];
      return rect.x === other.x && rect.y === other.y && rect.width === other.width && rect.height === other.height;
    }));
}
