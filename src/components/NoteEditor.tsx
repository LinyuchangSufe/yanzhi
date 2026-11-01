"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import CodeMirror, {
  EditorView,
  ExternalChange,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { startCompletion } from "@codemirror/autocomplete";
import { Compartment, EditorState } from "@codemirror/state";
import {
  Download,
  Ellipsis,
  LayoutTemplate,
  Quote,
  Save,
  Sparkles,
} from "lucide-react";
import type { Note, Paper } from "../lib/types";
import type { ResearchItemDraft } from "../lib/research-items/types";
import {
  insertPaperAt,
  paperCompletion,
  paperInsertion,
  paperTrigger,
  type PaperTrigger,
} from "../lib/editor/paper-completion";
import { useNoteImages } from "./editor/useNoteImages";
import {
  useNoteAssistBridge,
  type NoteActionHandler,
  type NoteAction,
} from "./editor/useNoteAssistBridge";
import NoteAssistPanel from "./editor/NoteAssistPanel";
import NoteWindowButton from "./editor/NoteWindowButton";
import NoteInsertMenu from "./editor/NoteInsertMenu";
import { useNoteModeShortcut } from "./editor/useNoteModeShortcut";
import { inlineMathInsertion } from "../lib/editor/inline-math";
import { clearMatchingDraft, draftKey, editorSessionId, readRecoveryDraft, writeDraft } from "../lib/editor/note-drafts";
import Markdown from "./Markdown";
import TooltipButton from "./TooltipButton";
import baseStyles from "./Workspace.module.css";
import contentStyles from "./styles/WorkspaceContent.module.css";
import noteStyles from "./styles/NoteEditor.module.css";
const styles = { ...baseStyles, ...contentStyles, ...noteStyles };

export interface NoteEditorPosition {
  from: number;
  to: number;
  scrollTop: number;
  mode: "edit" | "preview";
}
export interface NoteEditorHandle {
  flush: () => Promise<void>;
  getRevision: () => number;
  insert: (text: string) => void;
  insertPaper: (paper: Paper) => void;
  capturePosition: () => NoteEditorPosition;
  restorePosition: (position: NoteEditorPosition) => void;
  applyAction: (action: NoteAction, payload: Record<string, unknown>) => Promise<void>;
}
interface Props {
  note: Note;
  initialMode?: "edit" | "preview";
  detached?: boolean;
  compact?: boolean;
  onSave: (
    id: string,
    revision: number,
    title: string,
    body: string,
  ) => Promise<Note>;
  onNavigate: (href: string) => void;
  onDirty?: (dirty: boolean) => void;
  onRecover?: (title: string, body: string) => Promise<void>;
  onCite?: () => void;
  onResearchItem?: (draft: ResearchItemDraft) => void;
  papers?: Paper[];
  onAddPaper?: (query: string) => void;
  onFindPaper?: (query?: string) => void;
  onNoteAction?: NoteActionHandler;
  onAssistOpenChange?: (open: boolean) => void;
  match?: string;
}
const paperTemplate =
  "## 研究问题\n\n## 我理解的核心思路\n\n## 值得记住的结果与原文位置\n\n## 不理解的假设或证明步骤\n\n## 我的评价\n\n## 和当前研究的联系\n\n## 后续想法\n";
const topicTemplate =
  "## 问题定义\n\n## 已读相关论文\n\n## 各种方法的比较\n\n## 我目前的理解\n\n## 仍未解决的问题\n\n## 下一步想验证什么\n";

const NoteEditor = forwardRef<NoteEditorHandle, Props>(function NoteEditor(
  {
    note,
    initialMode,
    detached = false,
    compact = false,
    onSave,
    onNavigate,
    onDirty,
    onRecover,
    onCite,
    onResearchItem,
    papers = [],
    onAddPaper,
    onFindPaper,
    onNoteAction,
    onAssistOpenChange,
    match,
  },
  ref,
) {
  const [body, setBody] = useState(note.body);
  const [title, setTitle] = useState(note.title);
  const [mode, setMode] = useState<"edit" | "preview">(
    initialMode ?? (note.purpose === "paper" ? "edit" : "preview"),
  );
  const [toolsOpen, setToolsOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [assistOpen, setAssistOpen] = useState(false);
  const assistOpenChange = useRef(onAssistOpenChange);
  assistOpenChange.current = onAssistOpenChange;
  const showAssist = (open: boolean) => {
    setAssistOpen(open);
    assistOpenChange.current?.(open);
  };
  useEffect(() => () => assistOpenChange.current?.(false), []);
  const [selectionSize, setSelectionSize] = useState(0);
  const editorReadOnly = useMemo(() => new Compartment(), []);
  const toolsId = useId();
  const toolsButton = useRef<HTMLButtonElement>(null);
  const toolsPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!toolsOpen) return;
    toolsPanel.current?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !toolsPanel.current?.contains(target) && !toolsButton.current?.contains(target)) setToolsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      setToolsOpen(false);
      toolsButton.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [toolsOpen]);
  const [status, setStatus] = useState<"saved" | "dirty" | "saving" | "error">(
    "saved",
  );
  const [error, setError] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const recoveringRef = useRef(false);
  const latestNote = useRef(note);
  latestNote.current = note;
  const [draft, setDraft] = useState<{
    body: string;
    title: string;
    revision: number;
    key: string;
  } | null>(null);
  const recoveryOrigin = useRef<typeof draft>(null);
  const current = useRef({
    body: note.body,
    title: note.title,
    revision: note.revision,
  });
  const saved = useRef({ body: note.body, title: note.title });
  const pending = useRef<Promise<void> | null>(null);
  const cursor = useRef({ from: 0, to: 0 });
  const code = useRef<ReactCodeMirrorRef>(null);
  const root = useRef<HTMLElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const focusMode = useRef<"edit" | "preview" | null>(null);
  const positionRestore = useRef<NoteEditorPosition | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const pendingPaper = useRef<PaperTrigger | null>(null);
  const latestReferences = useRef({ papers, onAddPaper });
  latestReferences.current = { papers, onAddPaper };
  const images = useNoteImages({
    noteId: note.id,
    getView: () => code.current?.view,
    onStart: () => {
      setMode("edit");
      onDirty?.(true);
    },
  });
  const referenceExtension = useMemo(
    () =>
      paperCompletion({
        papers: () => latestReferences.current.papers,
        canAdd: () => Boolean(latestReferences.current.onAddPaper),
        addPaper: (query, trigger) => {
          pendingPaper.current = trigger;
          latestReferences.current.onAddPaper?.(query);
        },
      }),
    [],
  );
  const extensions = useMemo(
    () => [
      markdown(),
      EditorView.lineWrapping,
      referenceExtension,
      images.extension,
      editorReadOnly.of([
        EditorView.editable.of(true),
        EditorState.readOnly.of(false),
      ]),
    ],
    [referenceExtension, images.extension, editorReadOnly],
  );
  useEffect(() => {
    if (match && mode === "edit") {
      const at = current.current.body
        .toLocaleLowerCase()
        .indexOf(match.toLocaleLowerCase());
      if (at >= 0)
        code.current?.view?.dispatch({
          selection: { anchor: at, head: at + match.length },
          scrollIntoView: true,
        });
    }
  }, [match, mode]);
  const id = note.id;
  const key = draftKey(id, editorSessionId());
  const dirty = useCallback(
    () =>
      current.current.body !== saved.current.body ||
      current.current.title !== saved.current.title,
    [],
  );
  const persistDraft = useCallback(() => {
    try {
      writeDraft(localStorage, key, current.current);
    } catch {
      /* Browser draft storage can be unavailable; server save remains authoritative. */
    }
  }, [key]);
  const clearRecoveredDraft = useCallback(() => {
    const origin = recoveryOrigin.current;
    if (!origin) return;
    try { clearMatchingDraft(localStorage, origin.key, origin); } catch {}
    recoveryOrigin.current = null;
  }, []);
  useEffect(() => {
    try {
      const found = readRecoveryDraft(localStorage, id, note);
      if (found) setDraft({ ...found.value, key: found.key });
    } catch {
      /* Ignore invalid recovery drafts. */
    }
  }, [key]); // A recovery draft is checked only when opening this note, not during its own autosave.
  const flush = useCallback(async () => {
    await images.wait();
    while (pending.current) {
      await pending.current;
    }
    if (!dirty()) {
      onDirty?.(false);
      return;
    }
    const version = { ...current.current };
    setStatus("saving");
    setError("");
    persistDraft();
    const task = (async () => {
      try {
        const result = await onSave(
          id,
          version.revision,
          version.title,
          version.body,
        );
        saved.current = { body: version.body, title: version.title };
        current.current.revision = result.revision;
        clearRecoveredDraft();
        const remains = dirty();
        setStatus(remains ? "dirty" : "saved");
        onDirty?.(remains);
        if (!remains) {
          try {
            clearMatchingDraft(localStorage, key, version);
          } catch {}
          setDraft(null);
        }
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "保存失败，请重试");
        persistDraft();
        throw err;
      } finally {
        pending.current = null;
      }
    })();
    pending.current = task;
    await task;
    if (dirty()) await flush();
  }, [dirty, id, key, onDirty, onSave, persistDraft, images.wait, clearRecoveredDraft]);
  const assist = useNoteAssistBridge({
    noteId: id,
    current,
    saved,
    flush,
    onNoteAction,
    getSelection: () => {
      const selection = code.current?.view?.state.selection.main;
      return selection
        ? { from: selection.from, to: selection.to, head: selection.head }
        : { ...cursor.current, head: cursor.current.to };
    },
    readOnly: (locked) => {
      code.current?.view?.dispatch({
        effects: editorReadOnly.reconfigure([
          EditorView.editable.of(!locked),
          EditorState.readOnly.of(locked),
        ]),
      });
    },
    accept: (result, previous) => {
      const view = code.current?.view;
      if (view && view.state.doc.toString() !== result.body) {
        // Update the real document before releasing the lock: the controlled
        // wrapper may otherwise delay a value change after recent typing.
        const head = Math.min(
          view.state.selection.main.head,
          result.body.length,
        );
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: result.body },
          selection: { anchor: head },
          annotations: ExternalChange.of(true),
        });
      }
      pendingPaper.current = null;
      setBody(result.body);
      setTitle(result.title);
      setStatus("saved");
      setError("");
      setDraft(null);
      onDirty?.(false);
      // Do not erase a different draft written by another open tab.
      try {
        clearMatchingDraft(localStorage, key, previous);
      } catch {}
      clearRecoveredDraft();
    },
  });
  useEffect(() => {
    if (status !== "dirty" || recovering) return;
    const timer = setTimeout(() => {
      void flush().catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
  }, [body, title, status, flush, recovering]);
  const hadUploads = useRef(false);
  useEffect(() => {
    const busy = images.pending > 0 || images.failures.length > 0;
    const finished = hadUploads.current && !busy;
    hadUploads.current = busy;
    if (finished && !recovering) void flush().catch(() => {});
  }, [images.pending, images.failures.length, flush, recovering]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (dirty() || images.hasUnsaved() || assist.locked.current || recoveringRef.current) {
        persistDraft();
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty, persistDraft, images.hasUnsaved]);
  useEffect(() => {
    if (detached) document.documentElement.dataset.noteBusy = String(assist.applying || recovering);
    return () => { if (detached) delete document.documentElement.dataset.noteBusy; };
  }, [detached, assist.applying, recovering]);
  useEffect(() => {
    if (note.revision > current.current.revision && !dirty()) {
      current.current = {
        body: note.body,
        title: note.title,
        revision: note.revision,
      };
      saved.current = { body: note.body, title: note.title };
      setBody(note.body);
      setTitle(note.title);
    }
  }, [note, dirty]);
  const change = (next: string) => {
    current.current.body = next;
    setBody(next);
    setStatus("dirty");
    onDirty?.(true);
    persistDraft();
  };
  const insert = (text: string) => {
    if (assist.locked.current) return;
    const view = code.current?.view;
    if (view && mode === "edit") {
      const selection = view.state.selection.main;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: text },
        selection: { anchor: selection.from + text.length },
        scrollIntoView: true,
        userEvent: "input",
      });
      view.focus();
      setToolsOpen(false);
      return;
    }
    const { from, to } = cursor.current;
    const value = current.current.body;
    const at = Math.min(from, value.length);
    change(value.slice(0, at) + text + value.slice(Math.max(at, to)));
    cursor.current = { from: at + text.length, to: at + text.length };
    setMode("edit");
    setToolsOpen(false);
  };
  const insertPaper = (paper: Paper) => {
    if (assist.locked.current) return;
    const view = code.current?.view;
    if (view && mode === "edit") {
      insertPaperAt(
        view,
        paper,
        pendingPaper.current ??
          paperTrigger(view.state, view.state.selection.main.head),
      );
      pendingPaper.current = null;
      return;
    }
    const value = current.current.body;
    const state = EditorState.create({
      doc: value,
      selection: {
        anchor: Math.min(cursor.current.from, value.length),
        head: Math.min(cursor.current.to, value.length),
      },
    });
    const transaction = state.update(
      paperInsertion(state, paper, pendingPaper.current),
    );
    change(transaction.newDoc.toString());
    cursor.current = {
      from: transaction.newSelection.main.from,
      to: transaction.newSelection.main.to,
    };
    pendingPaper.current = null;
    setMode("edit");
  };
  const openReferences = () => {
    if (assist.locked.current) return;
    setMode("edit");
    setToolsOpen(false);
    requestAnimationFrame(() => {
      const view = code.current?.view;
      if (!view) return;
      if (!paperTrigger(view.state, view.state.selection.main.head)) {
        const at = view.state.selection.main.to;
        view.dispatch({
          changes: { from: at, insert: "[[" },
          selection: { anchor: at + 2 },
          userEvent: "input",
        });
      }
      view.focus();
      startCompletion(view);
    });
  };
  const exportNote = async (bundle: boolean) => {
    try {
      await flush();
      const link = document.createElement("a");
      link.href = `/api/kb/export?noteId=${id}${bundle ? "&format=bundle" : ""}`;
      link.download = "";
      link.click();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "请先保存笔记后再导出。",
      );
    }
  };
  const switchMode = (next: "edit" | "preview") => {
    if (assist.locked.current || recoveringRef.current ||
      (next === "preview" && (images.pending > 0 || images.failures.length > 0))) return;
    setInsertOpen(false);
    if (next === mode) return;
    if (mode === "edit" && code.current?.view) {
      const range = code.current.view.state.selection.main;
      cursor.current = { from: range.from, to: range.to };
    }
    focusMode.current = next;
    setMode(next);
    setToolsOpen(false);
    setInsertOpen(false);
  };
  const noteScroller = () => root.current?.closest<HTMLElement>("aside") ?? root.current?.parentElement;
  const applyRestoredPosition = (view = code.current?.view) => {
    const position = positionRestore.current;
    if (!position || (position.mode === "edit" && !view) || (position.mode === "preview" && !preview.current)) return false;
    if (position.mode === "edit" && view) {
      view.dispatch({ selection: { anchor: Math.min(position.from, view.state.doc.length), head: Math.min(position.to, view.state.doc.length) } });
      view.focus();
    } else preview.current?.focus({ preventScroll: true });
    const scroller = noteScroller();
    if (scroller) scroller.scrollTop = position.scrollTop;
    positionRestore.current = null;
    focusMode.current = null;
    return true;
  };
  const focusEditor = (view: EditorView) => {
    if (applyRestoredPosition(view)) return;
    if (focusMode.current !== "edit") return;
    const { from, to } = cursor.current;
    view.dispatch({ selection: { anchor: Math.min(from, view.state.doc.length), head: Math.min(to, view.state.doc.length) }, scrollIntoView: true });
    view.focus();
    focusMode.current = null;
  };
  useNoteModeShortcut(root, () => switchMode(mode === "edit" ? "preview" : "edit"));
  useEffect(() => {
    if (applyRestoredPosition()) return;
    if (focusMode.current === "preview") {
      preview.current?.focus({ preventScroll: true });
      focusMode.current = null;
    } else if (mode === "edit" && code.current?.view) focusEditor(code.current.view);
  }, [mode]);
  const titleInput = (
    <input
      aria-label="笔记标题"
      className={styles.noteTitle}
      value={title}
      disabled={assist.applying}
      onChange={(e) => {
        if (assist.locked.current) return;
        current.current.title = e.target.value;
        setTitle(e.target.value);
        setStatus("dirty");
        onDirty?.(true);
        persistDraft();
      }}
      onBlur={() => void flush().catch(() => {})}
    />
  );
  const insertMath = () => {
    const view = code.current?.view;
    if (mode !== "edit" || !view || view.state.readOnly ||
      assist.locked.current || recoveringRef.current || view.composing) return;
    view.dispatch(inlineMathInsertion(view.state));
    view.focus();
    setToolsOpen(false);
  };
  const prepareToLeave = async () => {
    const guard = () => {
      if (assist.locked.current || recoveringRef.current)
        throw new Error("正在保存笔记操作，请完成后再切换或关闭窗口。");
    };
    guard();
    await flush();
    guard();
  };
  useImperativeHandle(ref, () => ({
    flush: prepareToLeave,
    getRevision: () => current.current.revision,
    insert,
    insertPaper,
    applyAction: assist.act,
    capturePosition: () => {
      const range = code.current?.view?.state.selection.main ?? cursor.current;
      return { from: range.from, to: range.to, scrollTop: noteScroller()?.scrollTop ?? 0, mode };
    },
    restorePosition: (position) => {
      cursor.current = { from: position.from, to: position.to };
      positionRestore.current = position;
      setMode(position.mode);
      requestAnimationFrame(() => applyRestoredPosition());
    },
  }));
  return (
    <section
      ref={root}
      className={`${styles.noteEditor} ${compact ? styles.compact : ""} ${assistOpen ? styles.assistContainer : ""}`}
      onKeyDownCapture={(event) => {
        const view = code.current?.view;
        if (!view || !view.contentDOM.contains(event.target as Node) ||
          event.key.toLowerCase() !== "m" || !event.ctrlKey || event.metaKey ||
          event.altKey || event.shiftKey || event.nativeEvent.isComposing ||
          event.keyCode === 229 || view.composing) return;
        // Capture before CodeMirror's Ctrl-M Tab-focus binding. Held repeats
        // are consumed without inserting additional dollar pairs.
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) insertMath();
      }}
      onKeyDown={(event) => {
        if (event.key.toLowerCase() === "s" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (!event.repeat) void prepareToLeave().catch((error: unknown) => setError(error instanceof Error ? error.message : "保存失败，请重试。"));
        }
      }}
    >
      <div className={styles.editorTop}>
        <div className={styles.segmented}>
          <TooltipButton
            aria-pressed={mode === "edit"}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            title="切换编辑 / 预览（⌘ + Enter / Ctrl + Enter）"
            disabled={assist.applying || recovering}
            onClick={() => switchMode("edit")}
          >
            编辑
          </TooltipButton>
          <TooltipButton
            aria-pressed={mode === "preview"}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            disabled={
              assist.applying ||
              recovering ||
              images.pending > 0 ||
              images.failures.length > 0
            }
            title={images.pending > 0 ? "图片上传完成后可预览" : "切换编辑 / 预览（⌘ + Enter / Ctrl + Enter）"}
            onClick={() => switchMode("preview")}
          >
            预览
          </TooltipButton>
        </div>
        <NoteInsertMenu open={insertOpen} disabled={assist.applying} mathDisabled={mode !== "edit" || assist.applying || recovering}
          onOpenChange={(open) => { setInsertOpen(open); if (open) setToolsOpen(false); }} onMath={insertMath} onReference={openReferences}
          onImage={() => { setMode("edit"); requestAnimationFrame(() => imageInput.current?.click()); }} />
        {onNoteAction && (
          <TooltipButton
            className={styles.assistToggle}
            aria-expanded={assistOpen}
            aria-label="AI 润色与建议"
            title="AI 润色、梳理与研究建议"
            disabled={assist.applying}
            onClick={() => {
              setToolsOpen(false);
              setInsertOpen(false);
              showAssist(!assistOpen);
            }}
          >
            <Sparkles size={14} aria-hidden="true" />
            AI 建议
          </TooltipButton>
        )}
        <input
          className={styles.hiddenInput}
          ref={imageInput}
          type="file"
          disabled={assist.applying}
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          aria-label="选择笔记图片"
          onChange={(event) => {
            if (assist.locked.current) return;
            images.add([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <span
          role="status"
          className={status === "error" ? styles.errorText : styles.saveStatus}
        >
          {
            {
              saved: "已保存",
              dirty: "待保存",
              saving: "保存中…",
              error: "保存失败",
            }[status]
          }
        </span>
        <TooltipButton
          ref={toolsButton}
          className={styles.toolsToggle}
          aria-label="笔记设置"
          title="笔记设置与导出"
          aria-expanded={toolsOpen}
          aria-controls={toolsId}
          disabled={assist.applying}
          onClick={() => { setInsertOpen(false); setToolsOpen((open) => !open); }}
        >
          <Ellipsis size={17} aria-hidden="true" />
        </TooltipButton>
      </div>
      {toolsOpen && (
        <div ref={toolsPanel} className={styles.noteSettings} id={toolsId} tabIndex={-1}>
          <label className={styles.titleSetting}>笔记标题{titleInput}</label>
          <div className={styles.editorTools}>
            {onFindPaper && <button type="button" onClick={() => { setToolsOpen(false); onFindPaper(); }}>查找并收藏文献</button>}
            {onResearchItem && <button type="button" disabled={mode !== "edit" || !selectionSize || assist.applying || recovering}
              title="先在笔记正文中选择要核验的内容" onClick={() => { void (async () => {
                const view = code.current?.view; if (!view) return;
                const range = view.state.selection.main, text = view.state.sliceDoc(range.from, range.to), original = view.state.doc.toString();
                if (!text.trim() || text.length > 20000) throw new Error("请选择有内容且不超过 20,000 字符的笔记选段。");
                await flush(); if (current.current.body !== original) throw new Error("笔记在保存期间已变化，请重新选择选段；输入保留。");
                setToolsOpen(false); onResearchItem({ title: text.replace(/\s+/g, " ").slice(0, 140), body: text,
                  sources: [{ kind: "noteSelection", id, revision: current.current.revision, from: range.from, to: range.to }] });
              })().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "选段准备失败，请重试。")); }}>选段加入待核验</button>}
            {!detached && <NoteWindowButton noteId={id} prepare={prepareToLeave} disabled={assist.applying || recovering} />}
            <button
              onClick={() => {
                setToolsOpen(false);
                void flush().catch(() => {});
              }}
            >
              <Save size={13} aria-hidden="true" />
              立即保存 <kbd>⌘ / Ctrl + S</kbd>
            </button>
            <button
              onClick={() => {
                setToolsOpen(false);
                void exportNote(false);
              }}
            >
              <Download size={13} aria-hidden="true" />
              导出 Markdown
            </button>
            <button
              onClick={() => {
                setToolsOpen(false);
                void exportNote(true);
              }}
            >
              <Download size={13} aria-hidden="true" />
              导出笔记与图片
            </button>
            <button
              disabled={assist.applying}
              onClick={() =>
                insert(note.purpose === "topic" ? topicTemplate : paperTemplate)
              }
            >
              <LayoutTemplate size={13} aria-hidden="true" />
              插入可选模板
            </button>
            {onCite && (
              <button
                onClick={() => {
                  setToolsOpen(false);
                  onCite();
                }}
              >
                <Quote size={13} aria-hidden="true" />
                引用来源
              </button>
            )}
          </div>
        </div>
      )}
      {images.pending > 0 && (
        <div className={styles.uploadStatus} role="status">
          正在保存 {images.pending}{" "}
          张图片…你可以继续编辑，离开前会等待上传完成。
        </div>
      )}
      {images.failures.map((failure) => (
        <div key={failure.id} className={styles.uploadError} role="alert">
          <span>
            {failure.filename}：{failure.error}
          </span>
          <button onClick={() => images.retry(failure.id)}>重试</button>
          <button onClick={() => images.dismiss(failure.id)}>
            移除失败上传
          </button>
        </div>
      ))}
      {draft && (
        <div className={styles.notice}>
          发现尚未保存的本地草稿。
          <button
            disabled={assist.applying}
            onClick={() => {
              recoveryOrigin.current = draft;
              current.current.revision = draft.revision;
              current.current.title = draft.title;
              setTitle(draft.title);
              change(draft.body);
              setDraft(null);
              setMode("edit");
            }}
          >
            恢复草稿
          </button>
          <button
            onClick={() => {
              setDraft(null);
            }}
          >
            忽略草稿
          </button>
        </div>
      )}
      {recoveryMessage && (
        <div className={styles.notice} role="status">
          {recoveryMessage}
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert">
          {error}
          <div className={styles.actions}>
            <button onClick={() => void flush().catch(() => {})}>重试</button>
            {onRecover && (
              <button
                disabled={recovering}
                onClick={async () => {
                  if (recoveringRef.current) return;
                  recoveringRef.current = true;
                  setRecovering(true);
                  setRecoveryMessage("");
                  const snapshot = { ...current.current };
                  try {
                    await onRecover(
                      `${snapshot.title}（恢复副本）`,
                      snapshot.body,
                    );
                    clearRecoveredDraft();
                    if (
                      current.current.body !== snapshot.body ||
                      current.current.title !== snapshot.title
                    ) {
                      // A delayed recovery request must never discard newer typing.
                      setStatus("dirty");
                      onDirty?.(true);
                      persistDraft();
                      setError("");
                      setRecoveryMessage(
                        "恢复副本已保存；另存期间新增的输入仍保留在当前编辑器，正在尝试保存。",
                      );
                    } else {
                      const original = latestNote.current;
                      current.current = {
                        body: original.body,
                        title: original.title,
                        revision: original.revision,
                      };
                      saved.current = {
                        body: original.body,
                        title: original.title,
                      };
                      setBody(original.body);
                      setTitle(original.title);
                      setStatus("saved");
                      setError("");
                      onDirty?.(false);
                      try {
                        clearMatchingDraft(localStorage, key, snapshot);
                      } catch {}
                      setDraft(null);
                      setRecoveryMessage(
                        "恢复副本已保存到我的想法，原笔记保留。",
                      );
                    }
                  } catch (error) {
                    persistDraft();
                    setStatus("error");
                    setError(
                      `恢复副本保存失败：${error instanceof Error ? error.message : "请重试"}。原输入仍保留。`,
                    );
                    onDirty?.(dirty());
                  } finally {
                    recoveringRef.current = false;
                    setRecovering(false);
                  }
                }}
              >
                {recovering ? "正在另存恢复副本…" : "将本地内容另存为想法"}
              </button>
            )}
          </div>
          <small>
            本地输入仍保留。修订冲突时请先另存副本，再重新打开原笔记。
          </small>
        </div>
      )}
      {match && (
        <div className={styles.notice}>
          搜索命中：<mark>{match}</mark>。已打开对应笔记。
        </div>
      )}
      {assist.applying && (
        <p className={styles.uploadStatus} role="status">
          正在保存采纳结果与原稿快照…
        </p>
      )}
      <div className={assistOpen ? styles.assistLayout : undefined}>
        <div className={styles.writingPane}>
          {mode === "edit" ? (
            <div
              className={styles.codeEditor}
              onBlur={() => void flush().catch(() => {})}
              onFocusCapture={() => { setToolsOpen(false); setInsertOpen(false); }}
            >
              <CodeMirror
                ref={code}
                value={body}
                readOnly={assist.applying}
                editable={!assist.applying}
                extensions={extensions}
                basicSetup={{
                  lineNumbers: false,
                  foldGutter: false,
                  highlightActiveLine: false,
                }}
                minHeight="340px"
                aria-label="笔记正文"
                onChange={change}
                onCreateEditor={focusEditor}
                onUpdate={(view) => {
                  images.update(view);
                  if (view.docChanged && pendingPaper.current) {
                    const target = pendingPaper.current;
                    const from = view.changes.mapPos(target.from, 1);
                    const to = view.changes.mapPos(target.to, -1);
                    pendingPaper.current =
                      from <= to ? { ...target, from, to } : null;
                  }
                  cursor.current = {
                    from: view.state.selection.main.from,
                    to: view.state.selection.main.to,
                  };
                  if (view.selectionSet || view.docChanged) {
                    const nextSize =
                      view.state.selection.main.to -
                      view.state.selection.main.from;
                    setSelectionSize((size) =>
                      size === nextSize ? size : nextSize,
                    );
                  }
                }}
              />
            </div>
          ) : (
            <div ref={preview} className={styles.preview} tabIndex={0} role="region" aria-label="笔记预览">
              <Markdown body={body} onNavigate={onNavigate} onFindPaper={onFindPaper} />
            </div>
          )}
        </div>
        {assistOpen && onNoteAction && (
          <NoteAssistPanel
            key={note.id}
            noteId={note.id}
            title={title}
            body={body}
            revision={current.current.revision}
            hasSelection={selectionSize > 0}
            applying={assist.applying}
            prepare={assist.prepare}
            onAction={assist.act}
            onNavigate={onNavigate}
            onClose={() => showAssist(false)}
          />
        )}
      </div>
    </section>
  );
});
export default NoteEditor;
