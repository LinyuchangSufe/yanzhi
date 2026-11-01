import type { Annotation } from "./types";

/** A saved PDF mark becomes a sidebar comment only after the reader adds text. */
export function hasAnnotationComment(annotation: Pick<Annotation, "comment">) {
  return annotation.comment.trim().length > 0;
}

/** Keep plain highlights in storage and on the PDF, without filling the comments tab. */
export function commentedAnnotations(annotations: Annotation[], paperId: string) {
  return annotations.filter(
    (annotation) => annotation.paperId === paperId && hasAnnotationComment(annotation),
  );
}
