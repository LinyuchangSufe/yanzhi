import { useEffect, useRef, useState } from "react";
import type { Note } from "../../lib/types";
import type { NoteAssistSelection } from "../../lib/note-assist/types";

export type NoteAction = "note.assist.apply" | "note.revision.restore" | "idea.summary.apply";
export type NoteActionHandler = (
  action: NoteAction,
  payload: Record<string, unknown>,
) => Promise<Note>;

interface EditorDraft {
  title: string;
  body: string;
  revision: number;
}

interface BridgeOptions {
  noteId: string;
  current: React.MutableRefObject<EditorDraft>;
  saved: React.MutableRefObject<{ title: string; body: string }>;
  flush: () => Promise<void>;
  getSelection: () => { from: number; to: number; head: number };
  accept: (note: Note, previous: EditorDraft) => void;
  readOnly: (locked: boolean) => void;
  onNoteAction?: NoteActionHandler;
}

/** Generation stays editable; only an explicit acceptance briefly locks the editor. */
export function useNoteAssistBridge(options: BridgeOptions) {
  const latest = useRef(options);
  latest.current = options;
  const alive = useRef(true);
  const lock = useRef(false);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, [options.noteId]);

  const prepare = async (scope: "note" | "selection") => {
    const editor = latest.current;
    const noteId = editor.noteId;
    await editor.flush();
    if (!alive.current || latest.current.noteId !== noteId)
      throw new Error("笔记已切换，请重新打开 AI 辅助。");
    const draft = { ...editor.current.current };
    let selection: NoteAssistSelection | undefined;
    if (scope === "selection") {
      const range = editor.getSelection();
      const from = Math.max(0, Math.min(range.from, draft.body.length));
      const to = Math.max(from, Math.min(range.to, draft.body.length));
      if (from === to) throw new Error("请先在正文中选中需要处理的文字。");
      selection = { from, to, text: draft.body.slice(from, to) };
    }
    return { revision: draft.revision, selection };
  };

  const act = async (action: NoteAction, payload: Record<string, unknown>) => {
    if (lock.current) throw new Error("正在保存采纳结果，请稍候。");
    const editor = latest.current;
    if (!editor.onNoteAction) throw new Error("当前编辑器尚未连接笔记操作。");
    lock.current = true;
    editor.readOnly(true);
    setApplying(true);
    try {
      await editor.flush();
      if (!alive.current || latest.current.noteId !== editor.noteId)
        throw new Error("笔记已切换，本次操作已停止。");
      const { insertAtEnd, ...actionPayload } = payload;
      const previous = { ...editor.current.current };
      const result = await editor.onNoteAction(action, {
        ...actionPayload,
        noteId: editor.noteId,
        revision: editor.current.current.revision,
        ...(payload.operation === "insert"
          ? {
              position:
                insertAtEnd === true
                  ? editor.current.current.body.length
                  : editor.getSelection().head,
            }
          : {}),
      });
      if (!alive.current || latest.current.noteId !== editor.noteId) return;
      editor.current.current = {
        body: result.body,
        title: result.title,
        revision: result.revision,
      };
      editor.saved.current = { body: result.body, title: result.title };
      editor.accept(result, previous);
    } finally {
      lock.current = false;
      if (alive.current) {
        editor.readOnly(false);
        setApplying(false);
      }
    }
  };

  return { applying, locked: lock, prepare, act };
}
