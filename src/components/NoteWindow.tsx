"use client";
import { ArrowUpRight, BookOpen, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KBState, MutationResponse, Note } from "../lib/types";
import { publishLibraryChange, publishLibraryNavigation } from "../lib/editor/library-events";
import NoteEditor, { type NoteEditorHandle } from "./NoteEditor";
import { useLibrarySync } from "./editor/useLibrarySync";
import { errorMessage, readResponse } from "./WorkspaceShared";
import LiteratureDialog from "./literature/LiteratureDialog";
import base from "./Workspace.module.css";
import styles from "./styles/NoteWindow.module.css";

export default function NoteWindow() {
  const [state, setState] = useState<KBState | null>(null);
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  const [closing, setClosing] = useState(false);
  const [notice, setNotice] = useState("");
  const [literatureQuery, setLiteratureQuery] = useState<string | null>(null);
  const editor = useRef<NoteEditorHandle>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    await queue.current.catch(() => {});
    const request = ++generation.current;
    try {
      const next: KBState = await readResponse(await fetch("/api/kb", { cache: "no-store" }));
      if (request === generation.current) { setState(next); setError(""); }
    } catch (error) { if (request === generation.current) setError(errorMessage(error)); }
  }, []);
  const mutate = useCallback(async (action: string, payload: unknown): Promise<MutationResponse> => {
    ++generation.current;
    const task = queue.current.catch(() => {}).then(async () => {
      const next: MutationResponse = await readResponse(await fetch("/api/kb", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }),
      }));
      ++generation.current;
      setState(next.state);
      publishLibraryChange();
      return next;
    });
    queue.current = task;
    return task;
  }, []);
  useLibrarySync(refresh);
  useEffect(() => {
    const noteId = new URL(window.location.href).searchParams.get("id") || "";
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(noteId)) {
      setError("笔记标识无效，请从主界面的笔记工具栏重新打开。");
      return;
    }
    setId(noteId);
    void refresh();
  }, [refresh]);
  const note = state?.notes.find((item) => item.id === id);
  useEffect(() => { if (note) document.title = `${note.title} · 独立笔记`; }, [note?.title]);
  const navigate = (href: string) => {
    publishLibraryNavigation(href);
    try {
      const main = window.opener || (window.parent !== window ? window.parent.opener : null);
      main?.focus();
    } catch {}
    setNotice("已请求在主界面打开来源，独立笔记保留在这里。");
  };
  const save = useCallback(async (noteId: string, revision: number, title: string, body: string): Promise<Note> => {
    const next = await mutate("note.update", { id: noteId, revision, title, body });
    const updated = next.state.notes.find((item) => item.id === noteId);
    if (!updated) throw new Error("保存后未找到笔记，当前输入仍保留。");
    return updated;
  }, [mutate]);
  const close = async () => {
    setClosing(true);
    try {
      await editor.current?.flush();
      if (window.parent !== window) window.parent.close(); else window.close();
      setNotice("笔记已保存，可以关闭此窗口。");
    } catch (error) { setError(`${errorMessage(error)}。当前输入保留，请重试或另存副本。`); }
    finally { setClosing(false); }
  };
  return <div className={`${base.shell} ${styles.shell} kb-shell`}>
    <header className={styles.header}>
      <BookOpen size={18} aria-hidden="true" />
      <div><strong>{note?.title || "独立笔记"}</strong><small>可在主界面继续查阅资料</small></div>
      <button type="button" aria-label="在主界面查看" title="在主界面查看这条笔记"
        onClick={() => navigate(`kb://note/${id}`)} disabled={!note}>
        <ArrowUpRight size={16} aria-hidden="true" />
      </button>
      <button type="button" aria-label="保存并关闭" title="保存并关闭" disabled={closing}
        onClick={() => void close()}><X size={16} aria-hidden="true" /></button>
    </header>
    {error && <div className={styles.message} role="alert">{error}<button onClick={() => void refresh()}>重新读取</button></div>}
    {notice && <div className={styles.message} role="status">{notice}<button onClick={() => setNotice("")}>关闭提示</button></div>}
    <main className={styles.main}>
      {note ? <NoteEditor key={note.id} ref={editor} note={note} initialMode="edit" detached
        onSave={save} onNavigate={navigate}
        onFindPaper={(query) => setLiteratureQuery(query || "")}
        onDirty={(dirty) => { document.documentElement.dataset.noteDirty = String(dirty); }}
        papers={state?.papers.filter((paper) => !paper.deletedAt)}
        onNoteAction={async (action, payload) => {
          const next = await mutate(action, payload);
          const updated = next.state.notes.find((item) => item.id === id);
          if (!updated) throw new Error("笔记不存在，当前输入仍保留。");
          return updated;
        }}
        onRecover={async (title, body) => { await mutate("note.create", { title, body, purpose: "idea" }); }}
      /> : <p className={styles.empty}>{state ? "笔记不存在，请在主界面检查。" : error ? "暂时无法读取笔记。" : "正在读取笔记…"}</p>}
    </main>
    {state && literatureQuery !== null && <LiteratureDialog state={state} context={{ noteId: id }} initialQuery={literatureQuery}
      onClose={() => setLiteratureQuery(null)} onChanged={async () => { await refresh(); publishLibraryChange(); }}
      onOpenPaper={(paperId) => { setLiteratureQuery(null); navigate(`kb://paper/${paperId}`); }} />}
  </div>;
}
