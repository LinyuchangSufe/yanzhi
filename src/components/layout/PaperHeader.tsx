"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Ellipsis,
  ExternalLink,
  FolderOpen,
  Info,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
  X,
  Trash2,
  RotateCcw,
} from "lucide-react";
import type { WorkspaceController } from "../Workspace";
import TooltipButton from "../TooltipButton";
import { paperSource } from "../../lib/paper-actions";
import { linked } from "../WorkspaceShared";
import styles from "./PaperHeader.module.css";

type Panel = "information" | "actions" | "search";

/** The reading page has one shared header; paper management stays on demand. */
export function PaperHeader({ c }: { c: WorkspaceController }) {
  const {
    paper,
    state,
    readingLayout,
    busy,
    dirty,
    query,
    searching,
    requestAttachment,
    fetchPdf,
    setQuery,
    setSearchOpen,
    setDialog,
    setError,
    navigate,
  } = c;
  const [panel, setPanel] = useState<Panel | null>(null);
  const root = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const compact = readingLayout.focus || readingLayout.topbarHidden;

  useEffect(() => setPanel(null), [paper?.id, compact]);
  useEffect(() => {
    const focusSearch = () => {
      trigger.current = searchTrigger.current;
      setPanel("search");
      setSearchOpen(true);
      requestAnimationFrame(() => panelRef.current?.querySelector<HTMLInputElement>("input")?.focus());
    };
    window.addEventListener("kb:focus-search", focusSearch);
    return () => window.removeEventListener("kb:focus-search", focusSearch);
  }, [setSearchOpen]);
  useEffect(() => {
    if (panel !== "search") setSearchOpen(false);
  }, [panel, setSearchOpen]);
  useEffect(() => {
    if (!panel) return;
    const content = panelRef.current;
    if (panel === "search")
      content?.querySelector<HTMLInputElement>("input")?.focus();
    else content?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !panelRef.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node) &&
        !(
          event.target instanceof Element &&
          event.target.closest("[data-kb-search-results]")
        )
      )
        setPanel(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest('[role="dialog"]'))
      )
        return;
      event.preventDefault();
      setPanel(null);
      setSearchOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [panel, setSearchOpen]);

  if (!paper) return null;
  const source = paperSource(paper);
  const authors = paper.authors.join("、") || "作者待补充";
  const subtitle = `${authors}${paper.year ? ` · ${paper.year}` : ""}`;
  const tags = state.tags.filter((tag) =>
    linked(state, "paper", paper.id, "tag", tag.id),
  );
  const topics = state.topics.filter((topic) =>
    linked(state, "paper", paper.id, "topic", topic.id),
  );
  function toggle(next: Panel, element: HTMLButtonElement) {
    trigger.current = element;
    setPanel((current) => (current === next ? null : next));
  }
  function closeAnd(action: () => void) {
    trigger.current?.focus();
    setPanel(null);
    action();
  }
  return (
    <header
      ref={root}
      className={`${styles.header} ${compact ? styles.compact : ""}`}
      aria-label="论文顶栏"
      onKeyDown={(event) => {
        if (event.key === "Escape" && panel && !event.defaultPrevented && !event.nativeEvent.isComposing) {
          event.preventDefault();
          setPanel(null);
          trigger.current?.focus();
        }
      }}
    >
      <div className={styles.navigation}>
        <TooltipButton
          className={styles.icon}
          aria-label="返回文献库"
          title="返回文献库"
          onClick={() => void navigate({ kind: "home" })}
        >
          <ArrowLeft size={18} />
        </TooltipButton>
        <TooltipButton
          className={styles.icon}
          aria-label={
            readingLayout.sidebarHidden ? "展开左侧导航" : "收起左侧导航"
          }
          title={readingLayout.sidebarHidden ? "展开左侧导航" : "收起左侧导航"}
          aria-expanded={!readingLayout.sidebarHidden}
          onClick={
            readingLayout.sidebarHidden
              ? readingLayout.showSidebar
              : readingLayout.toggleSidebar
          }
        >
          {readingLayout.sidebarHidden ? (
            <PanelLeftOpen size={17} />
          ) : (
            <PanelLeftClose size={17} />
          )}
        </TooltipButton>
      </div>
      <div className={styles.identity}>
        <h1 title={paper.title}>{paper.title}</h1>
      </div>
      <div className={styles.actions}>
        {(busy || dirty) && <span
          className={`${styles.saveIndicator} ${dirty ? styles.pending : ""}`}
          role="status"
          title={
            busy ? "正在保存" : "有待保存的编辑"
          }
        >
          {busy ? "保存中" : "待保存"}
        </span>}
        <TooltipButton
          className={styles.labeled}
          aria-label="论文信息"
          aria-expanded={panel === "information"}
          aria-controls="paper-information"
          onClick={(event) => toggle("information", event.currentTarget)}
        >
          <Info size={16} />
          <span>论文信息</span>
        </TooltipButton>
        <TooltipButton
          ref={searchTrigger}
          data-kb-search
          className={`${styles.icon} ${styles.searchTrigger}`}
          aria-label="搜索知识库"
          aria-keyshortcuts="Meta+K Control+K"
          tooltip="搜索知识库（⌘ / Ctrl + K）"
          aria-expanded={panel === "search"}
          onClick={(event) => toggle("search", event.currentTarget)}
        >
          <Search size={17} />
        </TooltipButton>
        <TooltipButton
          className={styles.labeled}
          disabled={readingLayout.changing}
          aria-label={
            readingLayout.notesHidden ? "展开笔记侧栏" : "收起笔记侧栏"
          }
          aria-expanded={!readingLayout.notesHidden}
          onClick={() => void readingLayout.toggleNotes()}
        >
          {readingLayout.notesHidden ? (
            <PanelRightOpen size={17} />
          ) : (
            <PanelRightClose size={17} />
          )}
          <span>笔记</span>
        </TooltipButton>
        <TooltipButton
          className={styles.icon}
          disabled={readingLayout.changing}
          aria-label={readingLayout.focus ? "退出专注阅读" : "专注阅读"}
          title={readingLayout.focus ? "退出专注阅读" : "专注阅读"}
          aria-pressed={readingLayout.focus}
          onClick={() => void readingLayout.toggleFocus()}
        >
          {readingLayout.focus ? (
            <Minimize2 size={17} />
          ) : (
            <Maximize2 size={17} />
          )}
        </TooltipButton>
        <TooltipButton
          className={styles.icon}
          aria-label="更多论文操作"
          title="更多论文操作"
          aria-expanded={panel === "actions"}
          aria-controls="paper-actions"
          onClick={(event) => toggle("actions", event.currentTarget)}
        >
          <Ellipsis size={19} />
        </TooltipButton>
      </div>

      {panel && (
        <div
          ref={panelRef}
          data-kb-search={panel === "search" || undefined}
          tabIndex={-1}
          className={`${styles.popover} ${panel === "information" ? styles.information : panel === "search" ? styles.searchPopover : styles.menu}`}
          id={
            panel === "information"
              ? "paper-information"
              : panel === "actions"
                ? "paper-actions"
                : "paper-search"
          }
          role="region"
          aria-label={
            panel === "information"
              ? "论文资料"
              : panel === "actions"
                ? "论文操作"
                : "知识库搜索"
          }
        >
          <div className={styles.panelHeading}>
            <strong>
              {panel === "information"
                ? "论文信息"
                : panel === "actions"
                  ? "更多操作"
                  : "搜索知识库"}
            </strong>
            <TooltipButton
              className={styles.icon}
              aria-label="关闭展开面板"
              onClick={() => {
                setPanel(null);
                trigger.current?.focus();
              }}
            >
              <X size={15} />
            </TooltipButton>
          </div>
          {panel === "information" && (
            <>
              <h2>{paper.title}</h2>
              <p className={styles.authors}>{subtitle}</p>
              <div className={styles.facts}>
                {paper.doi && (
                  <p>
                    <span>DOI</span>
                    {paper.doi}
                  </p>
                )}
                {paper.arxivId && (
                  <p>
                    <span>arXiv</span>
                    {paper.arxivId}
                  </p>
                )}
                {source && <p><span>来源</span>{source}</p>}
                {tags.length > 0 && (
                  <p>
                    <span>标签</span>
                    {tags.map((tag) => `#${tag.name}`).join("　")}
                  </p>
                )}
                {topics.length > 0 && (
                  <div className={styles.topics}>
                    <span>研究问题</span>
                    {topics.map((topic) => (
                      <TooltipButton
                        key={topic.id}
                        onClick={() =>
                          closeAnd(
                            () =>
                              void navigate({ kind: "topic", id: topic.id }),
                          )
                        }
                      >
                        {topic.title}
                      </TooltipButton>
                    ))}
                  </div>
                )}
              </div>
              <div className={styles.informationActions}>
                <TooltipButton
                  disabled={Boolean(paper.deletedAt)}
                  onClick={() =>
                    closeAnd(() => setDialog({ kind: "paper", paper }))
                  }
                >
                  编辑文献信息
                </TooltipButton>
                <TooltipButton
                  onClick={() =>
                    closeAnd(() =>
                      setDialog({ kind: "links", type: "paper", id: paper.id }),
                    )
                  }
                >
                  关联问题与想法
                </TooltipButton>
              </div>
            </>
          )}
          {panel === "actions" && (
            <div className={styles.menuItems}>
              <p className={styles.menuLabel}>附件与来源</p>
              <TooltipButton disabled={Boolean(paper.deletedAt)} onClick={() => closeAnd(() => c.openLiterature("", { paperIds: [paper.id] }))}>查找并收藏文献</TooltipButton>
              {source && <a href={source} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />打开原始来源</a>}
              <TooltipButton
                disabled={busy || Boolean(paper.deletedAt)}
                onClick={() => closeAnd(() => requestAttachment(paper))}
              >
                添加 PDF 附件
              </TooltipButton>
                <TooltipButton
                  disabled={busy || Boolean(paper.deletedAt) || !source}
                  title={source ? "从来源获取 PDF" : "请先编辑文献信息，添加来源链接、DOI 或 arXiv 标识"}
                  onClick={() => closeAnd(() => void fetchPdf(paper))}
                >
                  从来源获取 PDF
                </TooltipButton>
              <TooltipButton
                disabled={busy || c.pdfShare.pending || Boolean(paper.deletedAt) || !state.attachments.some((attachment) => attachment.paperId === paper.id && attachment.status === "available")}
                title={state.attachments.some((attachment) => attachment.paperId === paper.id && attachment.status === "available") ? "整理格式化命名的 PDF 副本，并在本地文件夹中显示" : "这篇文献还没有本地 PDF，请先添加 PDF 附件"}
                onClick={() => closeAnd(() => void c.pdfShare.prepare(paper.id))}
              >
                <FolderOpen size={15} aria-hidden="true" />
                在文件夹中显示 PDF
              </TooltipButton>
              <hr />
              {paper.deletedAt ? (
                <TooltipButton
                  disabled={busy}
                  onClick={() =>
                    closeAnd(() => void c.changePaperAvailability(paper, true))
                  }
                >
                  <RotateCcw size={15} />
                  恢复文献
                </TooltipButton>
              ) : (
                <TooltipButton
                  className={styles.trashAction}
                  disabled={busy}
                  onClick={() =>
                    closeAnd(() => {
                      setError("");
                      setDialog({ kind: "paper-trash", paper });
                    })
                  }
                >
                  <Trash2 size={15} />
                  移入回收站
                </TooltipButton>
              )}
            </div>
          )}
          {panel === "search" && (
            <div className={styles.searchInput}>
              <Search size={16} />
              <input
                aria-label="搜索文献、笔记和批注"
                aria-keyshortcuts="Meta+K Control+K"
                onClick={() => setSearchOpen(true)}
                placeholder="搜索文献、笔记、批注…"
                value={query}
                onFocus={() => setSearchOpen(true)}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSearchOpen(true);
                }}
              />
              {query && (
                <TooltipButton
                  className={styles.icon}
                  aria-label="清空搜索"
                  onClick={() => {
                    setQuery("");
                    setSearchOpen(false);
                  }}
                >
                  <X size={14} />
                </TooltipButton>
              )}
              {searching && <small>搜索中…</small>}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
