export type NoteAssistMode = "polish" | "structure" | "advise";

export interface NoteAssistSelection {
  from: number;
  to: number;
  text: string;
}

export interface NoteAssistEdit {
  before: string;
  after: string;
  reason: string;
}

export interface NoteAssistSuggestion {
  title: string;
  body: string;
  basis: "note" | "literature" | "hypothesis";
  evidenceIds: string[];
}

export interface NoteAssistResult {
  overview: string;
  edits: NoteAssistEdit[];
  suggestions: NoteAssistSuggestion[];
}

export interface NoteAssistSource {
  id: string;
  kind: "note" | "topic" | "idea" | "paper-abstract" | "pdf-evidence";
  title: string;
  text: string;
  noteId?: string;
  paperId?: string;
  attachmentId?: string;
  attachmentSha256?: string;
  pageIndex?: number;
  pageLabel?: string;
}

export interface NoteAssistance {
  id: string;
  noteId: string;
  mode: NoteAssistMode;
  baseRevision: number;
  baseTitle: string;
  baseBody: string;
  selection: NoteAssistSelection | null;
  paperIds: string[];
  ideaIds: string[];
  sources: NoteAssistSource[];
  result: NoteAssistResult;
  provider: string;
  model: string;
  appliedEdits: number[];
  lastAppliedRevision: number;
  createdAt: string;
}

export interface NoteRevision {
  id: string;
  noteId: string;
  noteRevision: number;
  title: string;
  body: string;
  reason: "ai-start" | "before-apply" | "before-restore" | "manual";
  createdAt: string;
}

export interface NoteAssistContext {
  topic: { id: string; title: string; description: string } | null;
  papers: {
    id: string;
    title: string;
    hasAbstract: boolean;
    evidenceCount: number;
  }[];
  ideas: { id: string; title: string }[];
}
