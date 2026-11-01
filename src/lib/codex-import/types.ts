export interface CodexSource { id: string; label: string; host: string; home: string; sqliteHome: string | null; binary: string }
export interface CodexThread { id: string; title: string; cwd: string; updatedAt: string; createdAt: string }
export interface ExternalMessage { id: string; turnId: string; role: "user" | "assistant"; text: string }
export interface CodexTurn { id: string; status: string; startedAt: string | null; messages: ExternalMessage[] }
export interface CodexHistory { thread: CodexThread; turns: CodexTurn[]; complete: true; source: CodexSource; protocol: "paginated" | "legacy" }
export interface ExternalDiscussionContext { paperIds: string[]; topicIds: string[]; noteIds: string[] }
export interface ExternalDiscussionVersion {
  revision: number; hash: string; messages: ExternalMessage[]; title: string;
  sourceUpdatedAt: string; capturedAt: string;
  turnStatuses?: Record<string, string>;
}
/** A selected, immutable-source copy; previous revisions remain available after refresh. */
export interface ExternalDiscussion extends ExternalDiscussionContext {
  id: string; title: string; threadId: string; sourceHref: string; source: CodexSource;
  selectedTurnIds: string[]; messages: ExternalMessage[]; revision: number; hash: string;
  importedAt: string; refreshedAt: string; sourceUpdatedAt: string;
  history: ExternalDiscussionVersion[];
  turnStatuses?: Record<string, string>;
}
