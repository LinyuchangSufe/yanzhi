import type { PaperRefKind } from "./paper-refs";

/** A reference is always owned by a paper and, when supplied, one PDF version. */
export interface PaperReferenceScope {
  paperId: string;
  attachmentId?: string;
}
export interface PaperReferenceRequest extends PaperReferenceScope {
  kind: PaperRefKind;
  label: string;
}
export const PAPER_REFERENCE_EVENT = "yanzhi:paper-reference";
const KINDS = new Set<PaperRefKind>([
  "figure", "table", "equation", "section", "algorithm", "appendix",
  "theorem", "lemma", "proposition", "definition", "corollary",
]);

/** AI-authored Markdown cannot choose arbitrary destinations or another file. */
export function parseReferenceRequest(value: unknown): PaperReferenceRequest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.paperId !== "string" || !candidate.paperId ||
      candidate.paperId.length > 200 || typeof candidate.kind !== "string" ||
      !KINDS.has(candidate.kind as PaperRefKind) || typeof candidate.label !== "string" ||
      !/^(?:\d+(?:\.\d+)*|[A-Z](?:(?:\.\d+)+|\d*)?)$/.test(candidate.label) ||
      candidate.label.length > 32 || (candidate.attachmentId !== undefined &&
      (typeof candidate.attachmentId !== "string" || !candidate.attachmentId))) return null;
  return candidate as unknown as PaperReferenceRequest;
}

export function referenceMatchesScope(
  request: PaperReferenceRequest,
  scope: PaperReferenceScope,
): boolean {
  return request.paperId === scope.paperId &&
    (!request.attachmentId || request.attachmentId === scope.attachmentId);
}

/** Explicit clicks may return to a known immutable attachment of this paper. */
export function referenceRouting(
  request: PaperReferenceRequest,
  scope: PaperReferenceScope,
  attachments: readonly { id: string; paperId: string; status: string }[],
): "current" | "switch" | "missing" | "ignore" {
  if (request.paperId !== scope.paperId) return "ignore";
  if (referenceMatchesScope(request, scope)) return "current";
  return attachments.some((attachment) => attachment.id === request.attachmentId &&
    attachment.paperId === scope.paperId && attachment.status === "available") ? "switch" : "missing";
}
