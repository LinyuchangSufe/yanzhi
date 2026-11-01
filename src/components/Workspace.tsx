"use client";
import {
  BookOpen,
  BookOpenText,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  FolderOpen,
  Lightbulb,
  LoaderCircle,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EntityType,
  AIContent,
  KBState,
  MutationResponse,
  Note,
  Paper,
  SearchResult,
} from "../lib/types";
import { WorkspaceShell } from "./layout/WorkspaceShell";
import { useReadingLayout } from "./layout/useReadingLayout";
import NoteEditor, { type NoteEditorHandle } from "./NoteEditor";
import { useLibrarySync } from "./editor/useLibrarySync";
import { publishLibraryChange } from "../lib/editor/library-events";
import { usePaperAI } from "./editor/usePaperAI";
import type { PaperAIKind } from "../lib/paper-ai-task";
import PaperRowActions from "./PaperRowActions";
import { usePdfShare } from "./PdfShare";
import { paperSource } from "../lib/paper-actions";
import { readingListMessage, type ReadingListMembershipOperation } from "../lib/reading-list-ui";
import { recentPaperIds, sortLibraryPapers } from "../lib/library-navigation";
import { useWorkspaceNavigation } from "./layout/useWorkspaceNavigation";
import { useLibrarySearch } from "./layout/useLibrarySearch";
import { useResearchWorkflow } from "./layout/useResearchWorkflow";
import { prepareWorkspaceLeave } from "../lib/editor/pending-edits";
import type { PdfLocation, PdfSelection } from "./pdf/types";
import type { LiteratureContext } from "../lib/literature/types";
import contentStyles from "./styles/WorkspaceContent.module.css";
import baseStyles from "./Workspace.module.css";
import listStyles from "./styles/LibraryPaperList.module.css";
import {
  type Dialog,
  errorMessage,
  formatDate,
  linked,
  paperNote,
  readResponse,
} from "./WorkspaceShared";
const styles = { ...baseStyles, ...contentStyles };
function useWorkspaceController() {
  const pdfShare = usePdfShare();
  const [state, setState] = useState<KBState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [query, setQuery] = useState("");
  const { results, searching, searchError, retrySearch } = useLibrarySearch(query, state);
  const [searchOpen, setSearchOpen] = useState(false);
  const [match, setMatch] = useState("");
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [literatureRequest, setLiteratureRequest] = useState<{ query: string; context: LiteratureContext } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [assistNoteId, setAssistNoteId] = useState<string | null>(null);
  const [sort, setSort] = useState("newest");
  const [topicFilter, setTopicFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [missingOnly, setMissingOnly] = useState(false);
  const [target, setTarget] = useState<PdfLocation | undefined>();
  const [selectedAnnotation, setSelectedAnnotation] = useState("");
  const [focusResearchItemId, setFocusResearchItemId] = useState("");
  const [selection, setSelection] = useState<PdfSelection | null>(null);
  const [aiConfig, setAiConfig] = useState<Record<string, unknown> | null>(
    null,
  );
  const [restoreMessage, setRestoreMessage] = useState("");
  const editor = useRef<NoteEditorHandle>(null);
  const mutationQueue = useRef<Promise<unknown>>(Promise.resolve());
  const snapshotGeneration = useRef(0);
  const paperMutationPending = useRef(false);
  const appendPending = useRef(false);
  const pendingInsert = useRef<{ noteId: string; text: string } | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const attachInput = useRef<HTMLInputElement>(null);
  const attachmentTarget = useRef<string | null>(null);
  const [split, setSplit] = useState(60);
  const splitRef = useRef(split);
  const splitLoaded = useRef(false);
  splitRef.current = split;
  const splitContainer = useRef<HTMLDivElement>(null);
  const leaveEditor = useCallback(async () => {
    try {
      await editor.current?.flush();
      return await prepareWorkspaceLeave();
    } catch (e) {
      setError(`${errorMessage(e)}。当前编辑内容保留；请先重试或另存副本。`);
      return false;
    }
  }, []);
  const deepLink = useRef<((href: string) => Promise<void>) | null>(null);
  const {
    view, section, tab, setView, setSection, setTab, navigate, chooseSection,
    referenceReturn, returnFromReference, settingsReturn, returnFromSettings,
  } = useWorkspaceNavigation({
    state, stateRef, beforeLeave: leaveEditor, mainRef, editor, deepLink,
    onMissing: () => setError("目标内容不存在，请从文献库重新打开。"),
    onNavigate: (searchMatch) => {
      setMatch(searchMatch);
      setSearchOpen(false);
      setTarget(undefined);
      setSelectedAnnotation("");
      setFocusResearchItemId("");
      setDirty(false);
    },
  });
  const paper = state?.papers.find(
    (p) => view.kind === "paper" && p.id === view.id,
  );
  const topic = state?.topics.find(
    (t) => view.kind === "topic" && t.id === view.id,
  );
  const activeNote = state
    ? paper
      ? paperNote(state, paper.id)
      : topic
        ? state.notes.find((n) => n.id === topic.noteId)
        : view.kind === "note"
          ? state.notes.find((n) => n.id === view.id)
          : undefined
    : undefined;
  const activeNoteId = useRef(activeNote?.id);
  activeNoteId.current = activeNote?.id;

  const refresh = useCallback(async () => {
    await mutationQueue.current.catch(() => {});
    const request = ++snapshotGeneration.current;
    try {
      const next = await readResponse(
        await fetch("/api/kb", { cache: "no-store" }),
      );
      if (request === snapshotGeneration.current) {
        stateRef.current = next;
        setState(next);
        setLoadError("");
      }
    } catch (e) {
      if (request === snapshotGeneration.current) setLoadError(errorMessage(e));
    }
  }, []);
  const paperAI = usePaperAI(refresh);
  const aiTask = paperAI.task;
  const aiBusy = aiTask?.status === "running";
  const aiError = aiTask && aiTask.paperId === paper?.id && aiTask.status === "error"
    ? aiTask.error || "AI 请求失败，请重试。" : "";
  const mutate = useCallback(
    async (action: string, payload: unknown): Promise<MutationResponse> => {
      ++snapshotGeneration.current;
      const task = mutationQueue.current
        .catch(() => {})
        .then(async () => {
          const next = await readResponse(
            await fetch("/api/kb", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action, payload }),
            }),
          );
          ++snapshotGeneration.current;
          stateRef.current = next.state;
          setState(next.state);
          publishLibraryChange();
          return next as MutationResponse;
        });
      mutationQueue.current = task;
      return task;
    },
    [],
  );
  const safeMutate = async (action: string, payload: unknown) => {
    try {
      setError("");
      return await mutate(action, payload);
    } catch (e) {
      setError(errorMessage(e));
      return null;
    }
  };
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!state || splitLoaded.current) return;
    splitLoaded.current = true;
    if (state?.settings.splitRatio)
      setSplit(
        Math.max(
          35,
          Math.min(
            75,
            state.settings.splitRatio *
              (state.settings.splitRatio <= 1 ? 100 : 1),
          ),
        ),
      );
  }, [state?.settings.splitRatio, Boolean(state)]);
  const readingLayout = useReadingLayout(leaveEditor, Boolean(paper));
  useEffect(() => {
    if (view.kind === "paper" && tab !== "notes") readingLayout.revealNotes();
  }, [view, tab, readingLayout.revealNotes]);
  const changePaperAvailability = async (item: Paper, restore: boolean) => {
    if (paperMutationPending.current || busy) return false;
    paperMutationPending.current = true;
    setBusy(true);
    setError("");
    try {
      if (!(await leaveEditor())) return false;
      await mutate(restore ? "paper.restore" : "paper.trash", {
        id: item.id,
        revision: item.revision,
      });
      setMessage(
        restore
          ? "文献已恢复，原有 PDF、笔记、批注和关联均已保留。"
          : "文献已移入回收站，可从左栏恢复。PDF、笔记、批注和关联均已保留。",
      );
      return true;
    } catch (error) {
      setError(errorMessage(error));
      return false;
    } finally {
      paperMutationPending.current = false;
      setBusy(false);
    }
  };
  const changeReadingList = async (items: readonly Paper[], operation: ReadingListMembershipOperation) => {
    if (!items.length || paperMutationPending.current || busy) return false;
    if (items.length > 500) { setError("每次最多处理 500 篇文献，请分批操作。"); return false; }
    paperMutationPending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (!(await leaveEditor())) return false;
      const papers = items.map((item) => {
        currentActionPaper(item.id);
        return { id: item.id, revision: item.revision };
      });
      await mutate("paper.reading-list", { papers, operation });
      setMessage(readingListMessage(operation, papers.length));
      return true;
    } catch (error) {
      setError(errorMessage(error));
      return false;
    } finally {
      paperMutationPending.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (readingLayout.topbarHidden) setSearchOpen(false);
  }, [readingLayout.topbarHidden]);
  const navigateLink = useCallback(
    async (href: string) => {
      const parsed =
        /^(?:kb:\/\/|#)(paper|annotation|note|topic|ai|discussion|research-item)\/([a-zA-Z0-9-]+)$/.exec(
          href,
        );
      if (!parsed || !stateRef.current) return;
      const [, type, id] = parsed;
      if (["annotation", "note", "ai"].includes(type))
        readingLayout.revealNotes();
      const data = stateRef.current;
      if (type === "discussion") {
        if (!(data.externalDiscussions ?? []).some(item => item.id === id)) { setError("导入讨论不存在，已保存的引用快照仍保留。"); return; }
        await navigate({ kind: "discussion", id });
      } else if (type === "research-item") {
        const item = data.researchItems?.find(item => item.id === id);
        if (!item) { setError("待核验条目不存在，笔记中已写回的内容仍保留。"); return; }
        if (await navigate({ kind: "topic", id: item.topicId })) setFocusResearchItemId(id);
      } else if (type === "annotation") {
        const item = data.annotations.find((a) => a.id === id);
        if (!item) {
          setError("批注来源不存在，笔记中的摘录仍保留。");
          return;
        }
        if (
          !(await navigate({ kind: "paper", id: item.paperId }, "annotations"))
        )
          return;
        setTarget({
          attachmentId: item.attachmentId,
          pageIndex: item.pageIndex,
          rects: item.rects,
          annotationId: item.id,
        });
        setSelectedAnnotation(item.id);
      } else if (type === "ai") {
        const item = data.aiContents.find((a) => a.id === id);
        if (item) {
          if (await navigate({ kind: "paper", id: item.paperId }, "ai")) {
            const source = data.papers.find((p) => p.id === item.paperId);
            if (source && !paperAI.showSaved(source, item) && paperAI.task?.status === "running") {
              setMessage("AI 正在生成；可以继续阅读，或先停止当前任务后查看其他回复。");
            }
          }
        }
        else setError("AI 来源不存在。");
      } else if (type === "note") {
        const n = data.notes.find((n) => n.id === id);
        if (!n) {
          setError("笔记来源不存在。");
          return;
        }
        const t = data.topics.find((t) => t.noteId === id);
        const p = data.papers.find((p) => paperNote(data, p.id)?.id === id);
        await navigate(
          t
            ? { kind: "topic", id: t.id }
            : p
              ? { kind: "paper", id: p.id }
              : { kind: "note", id },
        );
      } else if (type === "topic") {
        if (!data.topics.some((topic) => topic.id === id)) {
          setError("研究问题来源不存在，引用快照仍保留。");
          return;
        }
        await navigate({ kind: "topic", id });
      } else if (type === "paper")
        await navigate({ kind: type, id });
    },
    [navigate, readingLayout.revealNotes],
  );
  useLibrarySync(refresh, (href) => { void navigateLink(href); });
  deepLink.current = navigateLink;
  useEffect(() => {
    const pending = pendingInsert.current;
    if (pending && activeNote?.id === pending.noteId && editor.current) {
      editor.current.insert(pending.text);
      pendingInsert.current = null;
    }
  }, [activeNote?.id, tab]);
  useEffect(() => {
    if (selectedAnnotation && tab === "annotations")
      requestAnimationFrame(() =>
        document
          .getElementById(`annotation-${selectedAnnotation}`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
      );
  }, [selectedAnnotation, tab]);
  const saveNote = useCallback(
    async (
      id: string,
      revision: number,
      title: string,
      body: string,
    ): Promise<Note> => {
      const next = await mutate("note.update", { id, revision, title, body });
      const note = next.state.notes.find((n) => n.id === id);
      if (!note) throw new Error("保存后未找到笔记");
      return note;
    },
    [mutate],
  );
  const createIdea = async (
    title: string,
    body = "",
    paperIds: string[] = [],
    topicIds: string[] = [],
  ) => {
    const next = await mutate("note.create", {
      title,
      body,
      purpose: "idea",
      paperIds,
      topicIds,
    });
    const id = (next.result as { id?: string } | undefined)?.id;
    const item = next.state.notes.find((n) => n.id === id && n.purpose === "idea");
    if (!item) throw new Error("未能确认刚创建的想法，已停止交接。请刷新后检查。");
    return item;
  };
  const insertInto = async (noteId: string, text: string) => {
    if (!(await leaveEditor())) return;
    readingLayout.revealNotes();
    if (activeNote?.id === noteId) {
      setTab("notes");
      if (editor.current) editor.current.insert(text);
      else {
        pendingInsert.current = { noteId, text };
      }
    } else {
      pendingInsert.current = { noteId, text };
      await navigateLink(`kb://note/${noteId}`);
    }
    setDialog(null);
  };
  const appendInto = async (noteId: string, text: string) => {
    if (appendPending.current || busy) return;
    appendPending.current = true;
    setBusy(true); setError("");
    try {
      if (!(await leaveEditor())) return;
      const note = stateRef.current?.notes.find(item => item.id === noteId);
      if (!note) throw new Error("目标综合笔记已不存在，未写入内容。");
      await mutate("note.update", { id: note.id, revision: note.revision, title: note.title, body: note.body + text });
      setDialog(null);
      await navigateLink(`kb://note/${noteId}`);
      setMessage("核验记录已追加到综合笔记末尾。");
    } catch (error) { setError(errorMessage(error)); }
    finally { appendPending.current = false; setBusy(false); }
  };
  const researchWorkflow = useResearchWorkflow({ stateRef, activeNote, topicId: topic?.id,
    leaveEditor, createIdea, navigate, setError, setMessage, setDialog });
  const openLiterature = (query = "", context?: LiteratureContext) => {
    setLiteratureRequest({ query, context: context ?? (paper ? { paperIds: [paper.id] }
      : activeNote ? { noteId: activeNote.id } : {}) });
  };
  const insertPaperInto = async (
    noteId: string,
    cited: Paper,
    live: () => boolean = () => true,
  ) => {
    if (!live()) return false;
    if (!stateRef.current?.notes.some((note) => note.id === noteId))
      throw new Error("文献已保存，但原笔记不存在；可从文献库再次引用。");
    if (!(await leaveEditor())) return false;
    if (!live()) return false;
    readingLayout.revealNotes();
    if (activeNoteId.current === noteId && editor.current) {
      setTab("notes");
      editor.current.insertPaper(cited);
    } else {
      throw new Error(
        "文献已保存，但原笔记已关闭。请返回原笔记后通过文献搜索插入引用。",
      );
    }
    return true;
  };
  const backlinks = (type: EntityType, id: string) =>
    state?.relations
      .filter(
        (r) => r.purpose === "reference" && r.toType === type && r.toId === id,
      )
      .map((r) => state.notes.find((n) => n.id === r.fromId))
      .filter((n): n is Note => Boolean(n)) || [];
  const openSearchResult = async (result: SearchResult) => {
    setMatch(query);
    if (result.type === "tag") {
      if (!(await navigate({ kind: "home" }))) return;
      setTopicFilter("");
      setMissingOnly(false);
      setTagFilter(result.id);
      setSection("all");
    } else if (result.type === "idea") {
      await navigate({ kind: "note", id: result.id }, "notes", query);
    } else {
      await navigateLink(`kb://${result.type}/${result.id}`);
      setMatch(query);
    }
    setSearchOpen(false);
  };
  const uploadPdf = async (file: File, paperId: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("paperId", paperId);
    const data = await readResponse(
      await fetch("/api/kb/attachment", { method: "POST", body: form }),
    );
    setState(data.state);
    setMessage("PDF 已保存；既有笔记与批注保持关联。");
  };
  const currentActionPaper = (id: string) => {
    const item = stateRef.current?.papers.find((entry) => entry.id === id);
    if (!item) throw new Error("这篇文献已不存在，请刷新文献库。");
    if (item.deletedAt) throw new Error("请先从回收站恢复这篇文献。");
    return item;
  };
  const requestAttachment = (item: Paper) => {
    if (busy || paperMutationPending.current) return;
    try {
      attachmentTarget.current = currentActionPaper(item.id).id;
      attachInput.current?.click();
    } catch (error) { setError(errorMessage(error)); }
  };
  const runPaperFileAction = async (id: string, action: (item: Paper) => Promise<void>) => {
    if (busy || paperMutationPending.current) return;
    paperMutationPending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try { await action(currentActionPaper(id)); }
    catch (error) { setError(errorMessage(error)); }
    finally { paperMutationPending.current = false; setBusy(false); }
  };
  const uploadAttachment = (file: File, paperId: string) =>
    runPaperFileAction(paperId, (item) => uploadPdf(file, item.id));
  const fetchPdf = (item: Paper) => runPaperFileAction(item.id, async (current) => {
    const source = paperSource(current);
    if (!source) throw new Error("请先编辑文献信息，添加来源链接、DOI 或 arXiv 标识。");
    const data = await readResponse(await fetch("/api/kb/resolve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, paperId: current.id, downloadPdf: true }),
    }));
    if (data.state) setState(data.state);
    setMessage(data.warnings?.join("；") || "PDF 已从来源保存到这篇文献；既有附件和笔记均已保留。");
  });
  const generateAI = async (
    kind: PaperAIKind,
    selected?: PdfSelection,
    force = false,
  ) => {
    const source = stateRef.current?.papers.find((p) => p.id === (selected?.paperId || paper?.id));
    if (!source) return;
    if (selected) setSelection(selected);
    if (!(await paperAI.start(source, kind, selected, force)))
      setMessage("已有 AI 请求正在生成；你可以继续阅读，或停止当前生成后再试。");
  };
  const changeLink = async (
    fromType: EntityType,
    fromId: string,
    toType: EntityType,
    toId: string,
    enabled: boolean,
  ) => {
    if (!state) return;
    const existing = state.relations.find(
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
    await safeMutate(
      enabled ? "link.set" : "link.unset",
      existing
        ? {
            fromType: existing.fromType,
            fromId: existing.fromId,
            toType: existing.toType,
            toId: existing.toId,
            purpose: existing.purpose,
          }
        : { fromType, fromId, toType, toId, purpose: "manual" },
    );
  };
  const sourceLists = (type: EntityType, id: string) => (
    <div className={styles.backlinks}>
      <h4>反向引用</h4>
      {backlinks(type, id).length ? (
        backlinks(type, id).map((n) => (
          <button
            key={n.id}
            onClick={() => void navigateLink(`kb://note/${n.id}`)}
          >
            <FileText size={13} />
            {n.title}
          </button>
        ))
      ) : (
        <p>还没有笔记引用此内容。</p>
      )}
    </div>
  );
  const editorFor = (note: Note, options?: { compact?: boolean }) => (
    <NoteEditor
      key={note.id}
      ref={editor}
      note={note}
      compact={options?.compact}
      onSave={saveNote}
      onResearchItem={researchWorkflow.openResearchItem}
      onFindPaper={(query) => openLiterature(query, { noteId: note.id, ...(paper ? { paperIds: [paper.id] } : {}) })}
      onAssistOpenChange={(open) =>
        setAssistNoteId((current) =>
          open ? note.id : current === note.id ? null : current,
        )
      }
      onNoteAction={async (action, payload) => {
        const result = await mutate(action, payload);
        const updated = result.state.notes.find((item) => item.id === note.id);
        if (!updated) throw new Error("笔记已不存在，未替换当前输入。");
        return updated;
      }}
      onNavigate={(href) => void navigateLink(href)}
      onDirty={setDirty}
      onCite={() => setDialog({ kind: "cite" })}
      papers={state?.papers.filter((item) => !item.deletedAt)}
      onAddPaper={(initialQuery) =>
        setDialog({ kind: "paper", citeToNoteId: note.id, initialQuery })
      }
      onRecover={async (title, body) => {
        await createIdea(title, body);
        setMessage("恢复副本已保存到我的想法，可重新打开原笔记处理冲突。");
      }}
      match={match}
    />
  );

  if (!state) return { ready: false as const, loadError, refresh };
  const activePapers = state.papers.filter((item) => !item.deletedAt);
  const trashedPapers = state.papers.filter((item) => Boolean(item.deletedAt));
  const papers = state.papers.filter(
    (p) =>
      (section === "trash" ? Boolean(p.deletedAt) : !p.deletedAt) &&
      (section === "trash" ||
        ((section !== "unread" || p.inReadingList === true) &&
          (!missingOnly ||
            !state.attachments.some(
              (a) => a.paperId === p.id && a.status === "available",
            )) &&
          (!topicFilter ||
            linked(state, "paper", p.id, "topic", topicFilter)) &&
          (!tagFilter || linked(state, "paper", p.id, "tag", tagFilter)))),
  );
  let recent: string[] = [];
  try {
    if (typeof window !== "undefined")
      recent = recentPaperIds(localStorage.getItem("research-recent"), activePapers);
  } catch {}
  const visiblePapers = section === "trash"
    ? papers.sort((a, b) => (b.deletedAt || "").localeCompare(a.deletedAt || ""))
    : sortLibraryPapers(papers, sort, recent);
  const ideas = state.notes
    .filter((n) => n.purpose === "idea")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const navigation = [
    {
      id: "all",
      label: "全部文献",
      icon: BookOpen,
      count: activePapers.length,
    },
    {
      id: "unread",
      label: "待阅读",
      icon: Clock3,
      count: activePapers.filter((p) => p.inReadingList === true).length,
    },
    { id: "topics", label: "研究问题", icon: FolderOpen },
    { id: "ideas", label: "我的想法", icon: Lightbulb },
  ] as const;
  const toolNavigation = [
    { id: "reference", label: "格式速查", icon: BookOpenText },
    { id: "trash", label: "回收站", icon: Trash2, count: trashedPapers.length },
  ] as const;
  const paperRow = (p: Paper, removable?: () => void, selection?: { checked: boolean; disabled?: boolean; onToggle: () => void }) => {
    const tags = state.tags.filter((t) =>
      linked(state, "paper", p.id, "tag", t.id),
    );
    const hasPdf = state.attachments.some(
      (a) => a.paperId === p.id && a.status === "available",
    );
    const note = paperNote(state, p.id);
    return (
      <div className={`${styles.paperRow} ${selection?.checked ? listStyles.selectedRow : ""}`} data-selected={selection?.checked || undefined} key={p.id}>
        {selection && !p.deletedAt && <label className={listStyles.rowSelect} title={`选择文献：${p.title}`}>
          <input type="checkbox" aria-label={`选择文献：${p.title}`} checked={selection.checked} disabled={busy || selection.disabled} onChange={selection.onToggle} />
        </label>}
        <button
          className={styles.paperOpen}
          title={p.title}
          onClick={() => void navigate({ kind: "paper", id: p.id })}
        >
          <div className={styles.paperIcon}>
            <FileText size={20} />
          </div>
          <div className={styles.paperInfo}>
            <strong>{p.title}</strong>
            <span>
              {p.authors.slice(0, 3).join("、") || "作者待补充"}
              {p.year ? ` · ${p.year}` : ""}
            </span>
            <div className={styles.paperMeta}>
              {p.deletedAt && <span>已移入回收站</span>}
              {!p.deletedAt && p.inReadingList && section !== "unread" && <span className={listStyles.inReadingList}>待阅读</span>}
              <span>{hasPdf ? "PDF" : "待补 PDF"}</span>
              {tags.slice(0, 2).map((t) => (
                <span key={t.id}>#{t.name}</span>
              ))}
              {note?.body && <span>有笔记</span>}
            </div>
          </div>
          <span
            className={styles.rowDate}
            title={
              p.deletedAt
                ? `移入回收站：${new Date(p.deletedAt).toLocaleString("zh-CN")}`
                : undefined
            }
          >
            {formatDate(p.deletedAt || p.updatedAt)}
          </span>
          <ChevronRight size={16} />
        </button>
        <PaperRowActions paper={p} busy={busy} hasPdf={hasPdf} sharing={pdfShare.pending}
          onEdit={() => { setError(""); setDialog({ kind: "paper", paper: p }); }}
          onLink={() => { setError(""); setDialog({ kind: "links", type: "paper", id: p.id }); }}
          onUpload={(file) => void uploadAttachment(file, p.id)}
          onFetch={() => void fetchPdf(p)}
          onShowPdf={() => void pdfShare.prepare(p.id)}
          onTrash={() => { setError(""); setDialog({ kind: "paper-trash", paper: p }); }}
          onRestore={() => void changePaperAvailability(p, true)}
          onUnlink={removable}
        />
      </div>
    );
  };

  return {
    ready: true as const,
    ...researchWorkflow,
    literatureRequest,
    openLiterature,
    closeLiterature: () => setLiteratureRequest(null),
    focusResearchItemId,
    readingLayout,
    pdfShare,
    setState,
    backlinks,
    state,
    view,
    section,
    tab,
    query,
    results,
    searching,
    searchError,
    retrySearch,
    searchOpen,
    match,
    error,
    message,
    dialog,
    busy,
    dirty,
    assistNoteId,
    sort,
    topicFilter,
    tagFilter,
    missingOnly,
    target,
    selectedAnnotation,
    aiBusy,
    aiError,
    aiTask: paperAI.task,
    aiResult: paperAI.result,
    aiCollapsed: paperAI.collapsed,
    setAiCollapsed: paperAI.setCollapsed,
    cancelAI: paperAI.cancel,
    dismissAI: paperAI.dismiss,
    showAIResult: (result: AIContent) => {
      const source = stateRef.current?.papers.find((p) => p.id === result.paperId);
      if (source && !paperAI.showSaved(source, result))
        setMessage("当前 AI 仍在生成。请先停止，或等待完成后查看其他回复。");
    },
    selection,
    aiConfig,
    restoreMessage,
    editor,
    attachInput,
    attachmentTarget,
    split,
    splitRef,
    splitContainer,
    paper,
    topic,
    activeNote,
    visiblePapers,
    activePapers,
    trashedPapers,
    ideas,
    navigation,
    toolNavigation,
    paperRow,
    sourceLists,
    editorFor,
    mainRef,
    setView,
    setSection,
    setTab,
    setQuery,
    setSearchOpen,
    setMatch,
    setError,
    setMessage,
    setDialog,
    setBusy,
    setDirty,
    setSort,
    setTopicFilter,
    setTagFilter,
    setMissingOnly,
    setTarget,
    setSelectedAnnotation,
    setSelection,
    setAiConfig,
    setRestoreMessage,
    setSplit,
    refresh,
    mutate,
    safeMutate,
    leaveEditor,
    changePaperAvailability,
    changeReadingList,
    navigate,
    navigateLink,
    createIdea,
    chooseSection,
    referenceReturn,
    returnFromReference,
    settingsReturn,
    returnFromSettings,
    insertInto,
    appendInto,
    insertPaperInto,
    openSearchResult,
    uploadPdf,
    uploadAttachment,
    requestAttachment,
    fetchPdf,
    generateAI,
    changeLink,
  };
}

export type WorkspaceController = Extract<
  ReturnType<typeof useWorkspaceController>,
  { ready: true }
>;

export default function Workspace() {
  const c = useWorkspaceController();
  if (!c.ready)
    return (
      <main className={styles.loading}>
        {c.loadError ? (
          <>
            <CircleHelp size={28} />
            <h2>暂时无法打开本地知识库</h2>
            <p>{c.loadError}</p>
            <button onClick={() => void c.refresh()}>重试</button>
          </>
        ) : (
          <>
            <LoaderCircle className={styles.spin} size={28} />
            <p>正在读取本地知识库…</p>
          </>
        )}
      </main>
    );
  return <WorkspaceShell c={c} />;
}
