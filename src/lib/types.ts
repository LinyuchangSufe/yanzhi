import type { NoteAssistance, NoteRevision } from "./note-assist/types";
import type { GuideData } from "./guide/types";
import type { PaperChatConversation } from "./paper-chat/types";
import type { IdeaConversation, IdeaSummary } from "./idea-lab/types";
import type { ExternalDiscussion } from "./codex-import/types";
import type { ResearchItem } from "./research-items/types";
export type ReadingStatus = "unread" | "reading" | "read";
export type ReadingListOperation =
  "add" | "remove" | "read" | "reading" | "unread";
export type EntityType =
  "paper" | "annotation" | "note" | "topic" | "ai" | "tag";
export type NotePurpose = "paper" | "topic" | "idea";
export interface Paper {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  abstract: string;
  sourceUrl: string;
  doi: string;
  arxivId: string;
  arxivVersion: number | null;
  readingStatus: ReadingStatus;
  /** Separate from reading progress; absent only in legacy snapshots. */
  inReadingList?: boolean;
  /** Absent in legacy snapshots; null means the paper is in the active library. */
  deletedAt?: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface Attachment {
  id: string;
  paperId: string;
  relativePath: string;
  filename: string;
  mimeType: string;
  sha256: string;
  status: "available" | "missing";
  createdAt: string;
}
/** Normalized unrotated PDF coordinates, x right/y up, origin page.view[0,1]. */
export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** Discontinuous excerpts belonging to one annotation on the same PDF page. */
export interface AnnotationTextSegment {
  rects: AnnotationRect[];
  selectedText: string;
}
export interface Annotation {
  id: string;
  paperId: string;
  attachmentId: string;
  kind: "highlight" | "region";
  pageIndex: number;
  pageLabel: string;
  rects: AnnotationRect[];
  selectedText: string;
  textSegments?: AnnotationTextSegment[] | null;
  comment: string;
  color: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface Note {
  id: string;
  title: string;
  body: string;
  purpose: NotePurpose;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface NoteImage {
  id: string;
  noteId: string;
  relativePath: string;
  filename: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  status: "available" | "missing";
  createdAt: string;
}
export interface Topic {
  id: string;
  title: string;
  description: string;
  noteId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface AIContent {
  id: string;
  paperId: string;
  kind: "summary" | "translation" | "explanation" | "markdown" | "guide" | "comparison";
  body: string;
  provider: string;
  model: string;
  sourceScope: "abstract" | "full_text" | "partial_text" | "selection" | "selection_context" | "page_image" | "selection_image";
  sourceAttachmentId: string | null;
  sourcePageIndices: number[];
  sourceText: string;
  guideData?: GuideData | null;
  status: "completed";
  createdAt: string;
}
export interface Tag {
  id: string;
  name: string;
}
export interface Relation {
  id: string;
  fromType: EntityType;
  fromId: string;
  toType: EntityType;
  toId: string;
  purpose: "manual" | "reference" | "tag";
  createdAt: string;
}
export interface ReadingPosition {
  paperId: string;
  attachmentId: string;
  pageIndex: number;
  scale: number | "page-width";
  rotation: number;
  updatedAt: string;
}
export interface Settings {
  aiProvider: "none" | "ollama" | "codex" | "openai-compatible";
  codexModel: string;
  ollamaUrl: string;
  ollamaModel: string;
  openaiUrl: string;
  openaiModel: string;
  appearance: "light" | "system";
  splitRatio: number;
}
export interface SearchResult {
  type: EntityType | "idea" | "discussion" | "research-item";
  id: string;
  title: string;
  snippet: string;
  paperId?: string;
  attachmentId?: string;
  topicId?: string;
}
export interface KBState {
  papers: Paper[];
  attachments: Attachment[];
  annotations: Annotation[];
  notes: Note[];
  noteImages?: NoteImage[];
  noteAssists?: NoteAssistance[];
  noteRevisions?: NoteRevision[];
  chatConversations?: PaperChatConversation[];
  ideaConversations?: IdeaConversation[];
  ideaSummaries?: IdeaSummary[];
  externalDiscussions?: ExternalDiscussion[];
  researchItems?: ResearchItem[];
  topics: Topic[];
  aiContents: AIContent[];
  tags: Tag[];
  relations: Relation[];
  readingPositions: ReadingPosition[];
  settings: Settings;
  searchResults?: SearchResult[];
}
export interface MutationResponse {
  state: KBState;
  result: unknown;
}
