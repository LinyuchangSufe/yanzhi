import type { MetadataCandidate } from "./import/enrichment-types";
import { doiFromSourceUrl } from "./import/identifiers";

export const metadataFieldLabels = {
  title: "标题",
  authors: "作者",
  year: "年份",
  doi: "DOI",
  arxiv: "arXiv ID",
  source: "来源链接",
  abstract: "原文摘要",
} as const;
export type MetadataField = keyof typeof metadataFieldLabels;
export type MetadataValues = Record<MetadataField, string>;
export type MetadataQuery =
  | { action: "search"; title: string }
  | { action: "detail"; source: string; title?: string };

export function metadataQuery(values: MetadataValues, titleOnly = false): MetadataQuery | null {
  const title = values.title.trim();
  const source = values.doi.trim() ||
    (values.arxiv.trim() ? `arxiv:${values.arxiv.trim()}` : values.source.trim());
  if (!titleOnly && source) return { action: "detail", source, ...(title.length >= 2 ? { title } : {}) };
  return title.length >= 2 ? { action: "search", title } : null;
}

export function candidateValues(candidate: MetadataCandidate): MetadataValues {
  const metadata = candidate.metadata;
  return {
    title: metadata.title || "",
    authors: metadata.authors?.join("; ") || "",
    year: metadata.year ? String(metadata.year) : "",
    doi: metadata.doi || "",
    arxiv: metadata.arxivId ? `${metadata.arxivId}${metadata.arxivVersion ? `v${metadata.arxivVersion}` : ""}` : "",
    source: metadata.sourceUrl || "",
    abstract: metadata.abstract || "",
  };
}

export function defaultMetadataFields(current: MetadataValues, proposed: MetadataValues): MetadataField[] {
  return (Object.keys(metadataFieldLabels) as MetadataField[])
    .filter((field) => !current[field].trim() && Boolean(proposed[field].trim()));
}

/** Never apply a stale comparison over typing that happened after its preview. */
export function selectedMetadataChanges(
  current: MetadataValues,
  preview: MetadataValues,
  proposed: MetadataValues,
  selected: MetadataField[],
): { changes: Partial<MetadataValues>; skipped: MetadataField[] } {
  const changes: Partial<MetadataValues> = {};
  const skipped: MetadataField[] = [];
  for (const field of new Set(selected)) {
    if (!proposed[field].trim()) continue;
    if (current[field] !== preview[field]) skipped.push(field);
    else if (current[field] !== proposed[field]) changes[field] = proposed[field];
  }
  return { changes, skipped };
}

export function metadataContextKey(values: MetadataValues, pdfGeneration: number): string {
  return JSON.stringify([values.title, values.source, values.doi, values.arxiv, pdfGeneration]);
}

export function metadataSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function metadataDoiConflict(current: MetadataValues, proposed: MetadataValues): boolean {
  const normalize = (doi: string) => (doiFromSourceUrl(doi) || doi.replace(/^doi:\s*/i, "")).trim().toLowerCase();
  const existing = normalize(current.doi) || doiFromSourceUrl(current.source);
  const candidate = normalize(proposed.doi) || doiFromSourceUrl(proposed.source);
  return Boolean(existing && candidate && existing !== candidate);
}
