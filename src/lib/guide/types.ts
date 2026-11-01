export type GuideCategory =
  | "problem"
  | "method"
  | "assumption"
  | "theorem"
  | "proof"
  | "experiment"
  | "limitation";
export interface GuideEvidence {
  id: string;
  paperId: string;
  attachmentId: string;
  attachmentSha256: string;
  pageIndex: number;
  pageLabel: string;
  blockId: string;
  quote: string;
  category: GuideCategory;
  title: string;
  explanation: string;
  matched: boolean;
}
export interface GuideSource {
  paperId: string;
  paperTitle: string;
  attachmentId: string;
  attachmentSha256: string;
  filename: string;
  pageCount: number;
  parsedPages: number[];
  emptyPages: number[];
  characterCount: number;
}
export interface GuideSection {
  key: string;
  title: string;
  body: string;
  basis: "author" | "analysis" | "question" | "not-stated";
  evidenceIds: string[];
}
export interface GuideData {
  version: 1;
  mode: "guide" | "comparison";
  overview: string;
  sections: GuideSection[];
  evidence: GuideEvidence[];
  readingOrder: string[];
  questions: string[];
  sources: GuideSource[];
  warnings: string[];
  paperIds: string[];
}
export interface GuideJob {
  id: string;
  paperId: string;
  mode: "guide" | "comparison";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  completedChunks: number;
  totalChunks: number;
  message: string;
  resultId: string | null;
  error: string;
  createdAt: string;
  updatedAt: string;
}
