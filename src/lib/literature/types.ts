import type { KBState } from "../types";
import type { MetadataCandidate } from "../import/enrichment-types";

export interface LiteratureContext { paperIds?: string[]; noteId?: string }
export interface LiteratureCandidate extends MetadataCandidate {
  candidateToken: string;
  existingPaperId?: string;
  existingTrashed?: boolean;
  hasPdf?: boolean;
}
export interface LiteratureSearchResult {
  candidates: LiteratureCandidate[];
  warnings: string[];
  inheritedTags: string[];
  contextPaperIds: string[];
  queriedAt: string;
}
export interface LiteratureImportResult {
  paperId: string;
  created: boolean;
  downloaded: boolean;
  alreadyHadPdf: boolean;
  warnings: string[];
  inheritedTags: string[];
  state: KBState;
}
export type SearchResult = LiteratureSearchResult;
export type ImportResult = LiteratureImportResult;
