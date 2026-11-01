import type { Metadata } from "./metadata";

export type MetadataField = "title" | "authors" | "year" | "doi" | "arxivId" | "abstract" | "sourceUrl";
export interface MetadataProvenance {
  label: string;
  url: string;
  fields: MetadataField[];
}
export interface MetadataCandidate {
  id: string;
  metadata: Metadata;
  publication?: string;
  workType?: string;
  match: "exact" | "similar" | "different" | "unknown";
  provenance: MetadataProvenance[];
  warnings: string[];
}
export interface MetadataLookupResult {
  candidates: MetadataCandidate[];
  warnings: string[];
  queriedAt: string;
}
