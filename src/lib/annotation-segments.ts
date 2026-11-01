import type { Annotation, AnnotationTextSegment } from "./types";

export const MAX_TEXT_SEGMENTS = 30;
export const MAX_ANNOTATION_RECTS = 500;
export const MAX_ANNOTATION_TEXT = 100000;

/** Keep legacy search/reference fields complete without joining separate geometry. */
export function aggregateTextSegments(
  segments: readonly AnnotationTextSegment[],
): Pick<Annotation, "rects" | "selectedText"> {
  return {
    rects: segments.flatMap((segment) =>
      segment.rects.map((rect) => ({ ...rect })),
    ),
    selectedText: segments.map((segment) => segment.selectedText).join("\n\n"),
  };
}

/** Old single-selection annotations are treated as a single excerpt for rendering. */
export function annotationTextSegments(
  annotation: Pick<Annotation, "rects" | "selectedText" | "textSegments">,
): AnnotationTextSegment[] {
  return (
    annotation.textSegments ?? [
      { rects: annotation.rects, selectedText: annotation.selectedText },
    ]
  );
}

export function matchesSegmentSummary(
  annotation: Pick<Annotation, "rects" | "selectedText" | "textSegments">,
): boolean {
  if (!annotation.textSegments) return true;
  const summary = aggregateTextSegments(annotation.textSegments);
  return (
    summary.selectedText === annotation.selectedText &&
    summary.rects.length === annotation.rects.length &&
    summary.rects.every((rect, index) => {
      const flat = annotation.rects[index];
      return (
        rect.x === flat.x &&
        rect.y === flat.y &&
        rect.width === flat.width &&
        rect.height === flat.height
      );
    })
  );
}
