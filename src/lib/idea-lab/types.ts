import type { ChatProgress } from "../ai/chat-progress";

export type IdeaSourceType = "paper" | "note" | "topic" | "annotation" | "guideEvidence" | "externalDiscussion";
export type IdeaSourceField = "abstract" | "body" | "description" | "quote" | "comment";

export interface IdeaSourceInput {
  type: IdeaSourceType;
  id: string;
  revision: number;
  field: IdeaSourceField;
  start?: number;
  end?: number;
  evidenceId?: string;
}
export interface IdeaSourceDraft { sources: IdeaSourceInput[]; prompt?: string; title?: string }
export interface IdeaSourceSnapshot {
  id: string;
  type: IdeaSourceType;
  entityId: string;
  field: IdeaSourceField;
  title: string;
  text: string;
  sourceHref: string;
  revision: number;
  start: number;
  end: number;
  paperId?: string;
  attachmentId?: string;
  attachmentSha256?: string;
  pageIndex?: number;
  pageLabel?: string;
  guideId?: string;
  evidenceId?: string;
  sourceThreadId?: string;
  externalSourceHref?: string;
  externalContentHash?: string;
  externalTurnStatuses?: Record<string, string>;
  externalSourceId?: string;
}
export interface IdeaMessage {
  id: string;
  conversationId: string;
  requestId: string;
  role: "user" | "assistant";
  body: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  sources: IdeaSourceSnapshot[];
  provider: string;
  model: string;
  error: string;
  createdAt: string;
  updatedAt: string;
  progress?: ChatProgress;
  /** Public bibliographic links actually returned by the controlled lookup tool; not full-text evidence. */
  literatureSources?: string[];
}
export interface IdeaConversation {
  id: string;
  noteId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: IdeaMessage[];
}
export interface IdeaSummarySection {
  id: string;
  title: string;
  body: string;
  sourceIds: string[];
}
export interface IdeaSummaryApplication {
  requestId: string;
  requestFingerprint: string;
  targetNoteId: string;
  sectionIds: string[];
  createdAt: string;
}
export interface IdeaSummary {
  id: string;
  requestId: string;
  noteId: string;
  conversationId: string;
  title: string;
  sections: IdeaSummarySection[];
  messageIds: string[];
  messages: IdeaMessage[];
  sources: IdeaSourceSnapshot[];
  baseRevision: number;
  provider: string;
  model: string;
  requestedModel?: string;
  createdAt: string;
  applications: IdeaSummaryApplication[];
}

