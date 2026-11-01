"use client";
import {
  PanelLeftOpen,
  PanelTopOpen,
  Search,
  X,
} from "lucide-react";
import type { WorkspaceController } from "../Workspace";
import { LibraryPages } from "../LibraryPages";
import { PaperWorkspace } from "../PaperWorkspace";
import { PaperHeader } from "./PaperHeader";
import { ResearchPages } from "../ResearchPages";
import WritingReference from "../WritingReference";
import { WorkspaceDialogs } from "../WorkspaceDialogs";
import { PdfShareDialog } from "../PdfShare";
import WorkspaceNotice from "../WorkspaceNotice";
import PaperAITaskBar from "../PaperAITaskBar";
import PaperChatActivityBar from "../PaperChatActivityBar";
import IdeaActivityBar from "../ideas/IdeaActivityBar";
import CodexImportPicker from "../codex-import/CodexImportPicker";
import ResearchItemDialog from "../research-items/ResearchItemDialog";
import LiteratureDialog from "../literature/LiteratureDialog";
import { publishLibraryChange } from "../../lib/editor/library-events";
import { useEffect, useRef, useState } from "react";
import TooltipButton from "../TooltipButton";
import { WorkspaceShortcuts } from "./WorkspaceShortcuts";
import interactionStyles from "./WorkspaceShortcuts.module.css";
import { errorMessage } from "../WorkspaceShared";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import { WorkspaceSearchResults } from "./WorkspaceSearchResults";
import chromeStyles from "./WorkspaceChrome.module.css";
import baseStyles from "../Workspace.module.css";
import contentStyles from "../styles/WorkspaceContent.module.css";
const styles = { ...baseStyles, ...contentStyles, ...chromeStyles };
export function WorkspaceShell({ c }: { c: WorkspaceController }) {
  const [hiddenTask, setHiddenTask] = useState("");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const {
    readingLayout,
    state,
    view,
    section,
    query,
    searchOpen,
    error,
    message,
    busy,
    dirty,
    paper,
    topic,
    mainRef,
    setQuery,
    setSearchOpen,
    setError,
    setMessage,
    navigate,
    chooseSection,
    openSearchResult,
  } = c;
  const controller = useRef(c);
  controller.current = c;
  const ideaWorkspace = view.kind === "note" && state.notes.some((note) => note.id === view.id && note.purpose === "idea");
  const closeSearch = () => {
    Array.from(document.querySelectorAll<HTMLInputElement>("[data-kb-search] input"))
      .find((element) => element.getClientRects().length > 0)?.focus();
    setSearchOpen(false);
  };
  useEffect(() => {
    if (!searchOpen) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-kb-search], [data-kb-search-results]")) setSearchOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing ||
          (event.target instanceof Element && event.target.closest('[role="dialog"], dialog[open]'))) return;
      event.preventDefault();
      if (!controller.current.paper) searchInput.current?.focus();
      setSearchOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [searchOpen, setSearchOpen]);
  useEffect(() => {
    const showShortcuts = () => setShortcutsOpen(true);
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey) ||
          (event.target instanceof Element && event.target.closest('[role="dialog"], dialog[open]'))) return;
      const active = controller.current;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (active.paper) window.dispatchEvent(new Event("kb:focus-search"));
        else {
          active.readingLayout.showTopbar();
          active.setSearchOpen(true);
          requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.select(); });
        }
      } else if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (saving.current) return;
        if (!active.editor.current) { active.setMessage("当前没有打开可保存的笔记；配置和批注请使用各自的保存按钮。"); return; }
        saving.current = true;
        void active.editor.current.flush().then(() => active.setMessage("当前笔记已保存。")).catch((error) => active.setError(errorMessage(error))).finally(() => { saving.current = false; });
      }
    };
    window.addEventListener("keydown", keys);
    window.addEventListener("kb:show-shortcuts", showShortcuts);
    return () => {
      window.removeEventListener("keydown", keys);
      window.removeEventListener("kb:show-shortcuts", showShortcuts);
    };
  }, []);
  return (
    <div
      className={`${styles.shell} ${readingLayout.focus ? styles.shellFocus : ""} ${ideaWorkspace ? styles.ideaWorkspaceShell : ""} kb-shell`}
    >
      {readingLayout.sidebarHidden && !readingLayout.focus && !paper && !readingLayout.isMobile && (
        <aside className={styles.sidebarRail}>
          <TooltipButton aria-label="展开左侧导航" aria-expanded={false} onClick={readingLayout.showSidebar}>
            <PanelLeftOpen size={18} />
          </TooltipButton>
        </aside>
      )}
      <WorkspaceNavigation c={c} onShortcuts={() => setShortcutsOpen(true)} />
      <div className={styles.content}>
        {readingLayout.topbarHidden && !readingLayout.focus && !paper && (
          <div className={styles.topbarRail}>
            {readingLayout.isMobile && <TooltipButton aria-label="展开左侧导航" onClick={readingLayout.showSidebar}><PanelLeftOpen size={18} /></TooltipButton>}
            <TooltipButton
              aria-label="展开顶栏"
              aria-expanded={false}
              onClick={readingLayout.showTopbar}
            >
              <PanelTopOpen size={15} />
              展开顶栏
            </TooltipButton>
          </div>
        )}
        {paper && <PaperHeader c={c} />}
        <header className={styles.topbar} hidden={!!paper || readingLayout.topbarHidden}>
          {readingLayout.isMobile && <TooltipButton className={styles.mobileMenu} aria-label="展开左侧导航"
            aria-expanded={!readingLayout.sidebarHidden} onClick={readingLayout.showSidebar}><PanelLeftOpen size={19} /></TooltipButton>}
          <span className={styles.contextLabel}>{view.kind !== "home" ? topic ? "研究问题" : view.kind === "discussion" ? "Codex 讨论" : "我的想法" : ""}</span>
          <div className={styles.searchBox} data-kb-search>
            <Search size={17} />
            <input ref={searchInput} aria-label="搜索知识库" aria-keyshortcuts="Meta+K Control+K"
              title="搜索知识库（⌘ / Ctrl + K）" value={query} onClick={() => setSearchOpen(true)}
              onFocus={() => setSearchOpen(true)} onChange={(event) => { setQuery(event.target.value); setSearchOpen(true); }}
              placeholder="搜索知识库…" />
            {query ? <TooltipButton aria-label="清空搜索" onClick={() => { setQuery(""); setSearchOpen(false); searchInput.current?.focus(); }}><X size={16} /></TooltipButton>
              : <kbd className={styles.searchHint}>⌘ / Ctrl K</kbd>}
          </div>
        </header>
        {searchOpen && query.trim() && <WorkspaceSearchResults c={c} onClose={closeSearch} />}
        {(error || message) && <WorkspaceNotice key={`${error ? "error" : "message"}:${error || message}`}
          error={error} message={message} onDismissMessage={() => setMessage("")}
          onClose={() => { setError(""); setMessage(""); }} />}
        <main
          className={`${styles.main} ${readingLayout.focus ? styles.mainFocus : ""}`}
          ref={mainRef}
        >
          <LibraryPages c={c} />
          <PaperWorkspace c={c} />
          <ResearchPages c={c} />
          {view.kind === "home" && section === "reference" && (
            <WritingReference
              onBack={c.referenceReturn ? c.returnFromReference : undefined}
            />
          )}
        </main>
        <footer
          className={styles.footer}
          hidden={!!paper || readingLayout.focus || ideaWorkspace || (!busy && !dirty)}
        >
          <div className={interactionStyles.connection} role="status">
            {busy ? "正在写入…" : "有待保存的编辑"}
          </div>
        </footer>
      </div>
      <WorkspaceShortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <WorkspaceDialogs c={c} />
      {c.literatureRequest && <LiteratureDialog state={state} context={c.literatureRequest.context} initialQuery={c.literatureRequest.query}
        onClose={c.closeLiterature} onChanged={async () => { await c.refresh(); publishLibraryChange(); }}
        onOpenPaper={(id) => { c.closeLiterature(); void c.navigate({ kind: "paper", id }); }} />}
      {c.codexImportContext && <CodexImportPicker context={c.codexImportContext}
        onImported={async () => { await c.refresh(); c.setMessage("所选 Codex 问答已导入，可在参考资料中选择引用。"); }}
        onClose={c.closeCodexImporter} />}
      {c.researchItemDraft && <ResearchItemDialog state={state} initial={c.researchItemDraft}
        onSaved={async () => { await c.refresh(); c.setMessage("已加入研究问题的待核验清单。"); }} onClose={c.closeResearchItem} />}
      <PdfShareDialog share={c.pdfShare} />
      <div className={interactionStyles.activityStack}>
        <PaperChatActivityBar c={c} />
        <IdeaActivityBar c={c} />
        {c.aiTask && c.aiTask.paperId !== paper?.id &&
        hiddenTask !== `${c.aiTask.id}:${c.aiTask.status}` && <PaperAITaskBar task={c.aiTask}
          onCancel={c.cancelAI} onDismiss={() => {
            if (c.aiTask?.status === "running") setHiddenTask(`${c.aiTask.id}:${c.aiTask.status}`);
            else c.dismissAI();
          }} onOpen={() => {
            const task = c.aiTask;
            if (task) void c.navigate({ kind: "paper", id: task.paperId }, task.kind === "summary" ? "ai" : "notes")
              .then((opened) => { if (opened) c.setAiCollapsed(false); });
          }} />}
      </div>
    </div>
  );
}
