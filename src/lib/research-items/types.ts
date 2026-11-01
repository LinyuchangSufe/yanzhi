export type ResearchItemStatus = "pending" | "in_progress" | "resolved" | "parked";
export type ResearchSourceInput =
  | { kind: "note"; id: string; revision: number }
  | { kind: "noteSelection"; id: string; revision: number; from: number; to: number }
  | { kind: "annotation"; id: string; revision: number }
  | { kind: "guideEvidence"; id: string; evidenceId: string }
  | { kind: "guideQuestion"; id: string; questionIndex: number }
  | { kind: "ideaMessage"; conversationId: string; messageId: string }
  | { kind: "externalDiscussion"; id: string; revision: number; messageIds?: string[] };
export interface ResearchItemSource {
  id: string;
  input: ResearchSourceInput;
  title: string;
  text: string;
  sourceHref: string;
  fingerprint: string;
  capturedAt: string;
  origin: "personal" | "annotation" | "ai" | "external";
  paperId?: string;
  attachmentId?: string;
  attachmentSha256?: string;
  pageIndex?: number;
  pageLabel?: string;
}
export interface ResearchItem {
  id: string;
  topicId: string;
  title: string;
  body: string;
  nextAction: string;
  status: ResearchItemStatus;
  sourceRefs: ResearchItemSource[];
  resultRefs: ResearchItemSource[];
  resolution: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}
export interface ResearchItemDraft {
  topicId?: string;
  title?: string;
  body?: string;
  nextAction?: string;
  sources?: ResearchSourceInput[];
}
