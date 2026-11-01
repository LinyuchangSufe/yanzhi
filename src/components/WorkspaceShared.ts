import type {
  Annotation,
  EntityType,
  KBState,
  Paper,
  Topic,
} from "../lib/types";
export type Section =
  | "all"
  | "unread"
  | "trash"
  | "topics"
  | "ideas"
  | "reference"
  | "discussions"
  | "settings";
export type View =
  { kind: "home" } | { kind: "paper" | "topic" | "note" | "discussion"; id: string };
export type Tab = "notes" | "annotations" | "ai" | "chat";
export type Dialog =
  | {
      kind: "paper";
      paper?: Paper;
      citeToNoteId?: string;
      initialQuery?: string;
    }
  | { kind: "topic"; topic?: Topic }
  | { kind: "idea" }
  | { kind: "paper-trash"; paper: Paper }
  | { kind: "links"; type: "paper" | "topic" | "note"; id: string }
  | { kind: "cite" }
  | { kind: "insert"; text: string; noteId?: string }
  | null;
export const formatDate = (value: string) =>
  new Date(value).toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
  });
export const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试";
export async function readResponse(response: Response) {
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(
        value.error || value.message || `请求失败（${response.status}）`,
      ),
      { details: value.details, status: response.status },
    );
  return value;
}
export function linked(
  state: KBState,
  fromType: EntityType,
  fromId: string,
  toType: EntityType,
  toId: string,
) {
  return state.relations.some(
    (r) =>
      r.purpose !== "reference" &&
      ((r.fromType === fromType &&
        r.fromId === fromId &&
        r.toType === toType &&
        r.toId === toId) ||
        (r.fromType === toType &&
          r.fromId === toId &&
          r.toType === fromType &&
          r.toId === fromId)),
  );
}
export function paperNote(state: KBState, id: string) {
  return state.notes.find(
    (note) =>
      note.purpose === "paper" && linked(state, "note", note.id, "paper", id),
  );
}
export function citeAnnotation(a: Annotation, state: KBState) {
  const title = state.papers.find((p) => p.id === a.paperId)?.title || "文献";
  return `\n> ${(a.selectedText || "[页内区域批注]").replace(/\n/g, "\n> ")}\n> — [${title} · 第 ${a.pageIndex + 1} 页${a.pageLabel ? `（${a.pageLabel}）` : ""}](kb://annotation/${a.id})\n\n`;
}
