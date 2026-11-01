"use client";

// Papernook's MIT-licensed PDF.js integration is the lifecycle reference.
// PDF.js (Apache-2.0) lays out every canvas and selectable text layer; knowledge
// annotations remain independent records and never rewrite the attachment.
import { useEffect, useRef, useState } from "react";
import type { ReadingPosition } from "../../lib/types";
import type { PdfAnnotationDraft, PdfLocation, PdfReaderProps } from "./types";
import { PdfPage } from "./PdfPage";
import {
  selectDraftSelection,
  draftTextSegments,
  removeLastDraftSegment,
  type PdfDraft,
} from "./annotation-draft";
import { PdfToolbar } from "./PdfToolbar";
import {
  pdfError,
  usePdfDocument,
  type PdfPageDescriptor,
} from "./usePdfDocument";
import { useContinuousReading } from "./useContinuousReading";
import { mergeReadingPositions, stepZoom } from "./continuous";
import { clampPageIndex } from "./geometry";
import { usePaperReferences } from "./usePaperReferences";
import { ReferencePreview } from "./ReferencePreview";
import { ReferenceCandidates } from "./ReferenceCandidates";
import { useProtectedDraft } from "../editor/useProtectedDraft";
import { isPendingAnnotation, matchesDraftAttachment, savedAnnotationForDraft } from "../../lib/editor/annotation-recovery";
import type { ResolvedPdfDestination } from "../../lib/pdf-reference/destinations";
import { PAPER_REFERENCE_EVENT, type PaperReferenceRequest } from "../../lib/pdf-reference/events";
import "pdfjs-dist/web/pdf_viewer.css";
import styles from "./PdfReader.module.css";

export type {
  PdfAnnotationDraft,
  PdfLocation,
  PdfTarget,
  PdfReaderProps,
  PdfSelection,
} from "./types";
const NO_PAGES: PdfPageDescriptor[] = [];

/** Continuous immutable-PDF reader with exact placeholders and lazy canvases. */
export function PdfReader({
  paperId,
  attachments,
  annotations,
  initialPosition,
  readingPositions = [],
  target,
  onCreateAnnotation,
  onSelectAnnotation,
  onExplainSelection,
  onTranslateSelection,
  onConvertMarkdown,
  aiBusy = false,
  onOpenAnnotation,
  onPositionChange,
  onRequestAttachment,
  focusMode = false,
  guideMarks = [],
  activeGuideMarkId = "",
  showGuideMarks = true,
  onSelectGuideMark,
  onActiveAttachmentChange,
  onFindPaper,
}: PdfReaderProps) {
  const attachmentVersions = [...attachments].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
  const defaultAttachmentId = attachmentVersions[0]?.id ?? "";
  const newestPosition =
    initialPosition ??
    [...readingPositions]
      .filter((position) => position.paperId === paperId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const initialPositions = [
    ...readingPositions,
    ...(initialPosition ? [initialPosition] : []),
  ];
  const initialCache = new Map<string, ReadingPosition>();
  mergeReadingPositions(initialCache, initialPositions, paperId);
  const firstId =
    target?.attachmentId ?? newestPosition?.attachmentId ?? defaultAttachmentId;
  const firstPosition = initialCache.get(firstId);
  const [attachmentId, setAttachmentId] = useState(firstId);
  const [scale, setScale] = useState<number | "page-width">(
    firstPosition?.scale ?? "page-width",
  );
  const [rotation, setRotation] = useState(firstPosition?.rotation ?? 0);
  const [navigation, setNavigation] = useState<PdfLocation>(
    target ?? {
      attachmentId: firstId,
      pageIndex: firstPosition?.pageIndex ?? 0,
    },
  );
  const [highlightLocation, setHighlightLocation] =
    useState<PdfLocation | null>(target ?? null);
  const [width, setWidth] = useState(600);
  const [mode, setMode] = useState<"select" | "region">("select");
  const [draft, setDraft] = useState<PdfDraft | null>(null);
  const [draftExpanded, setDraftExpanded] = useState(false);
  const [copiedOriginal, setCopiedOriginal] = useState(false);
  const nativeDraft = useRef<PdfDraft | null>(null);
  const [comment, setComment] = useState("");
  const [color, setColor] = useState("#f5cf58");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [activeId, setActiveId] = useState(target?.annotationId ?? "");
  const [actionError, setActionError] = useState("");
  const [pendingReference, setPendingReference] = useState<PaperReferenceRequest | null>(null);
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const previousFocus = useRef(false);
  const readerRef = useRef<HTMLElement>(null);
  const activeAttachmentCallback = useRef(onActiveAttachmentChange);
  activeAttachmentCallback.current = onActiveAttachmentChange;
  const beforeFocus = useRef(false);
  const positionCache = useRef(initialCache);
  const locallyObserved = useRef(new Set<string>());
  const callbacks = useRef({ onPositionChange, onSelectAnnotation });
  callbacks.current = { onPositionChange, onSelectAnnotation };
  const attachment = attachments.find((item) => item.id === attachmentId);
  const recovery = useProtectedDraft({
    key: `research-new-annotation:${paperId}`,
    value: { draft, comment, color, expanded: draftExpanded,
      sha256: attachments.find((item) => item.id === draft?.attachmentId)?.sha256 ?? "" },
    dirty: Boolean(draft), blocked: saving,
    validate: (value): value is Parameters<typeof matchesDraftAttachment>[0] =>
      isPendingAnnotation(value) && matchesDraftAttachment(value, paperId, attachments),
    restore: (value) => {
      const saved = savedAnnotationForDraft(value, annotations);
      if (saved) {
        setNavigation({ attachmentId: saved.attachmentId, pageIndex: saved.pageIndex, rects: saved.rects });
        setHighlightLocation({ attachmentId: saved.attachmentId, pageIndex: saved.pageIndex, rects: saved.rects });
        setAttachmentId(saved.attachmentId); setActiveId(saved.id);
        setActionError("上次批注已保存，已定位到原记录；未重复创建批注。");
        return;
      }
      setDraft(value.draft); setComment(value.comment); setColor(value.color); setDraftExpanded(value.expanded);
    },
  });
  const documentState = usePdfDocument(
    attachmentId,
    attachment?.status === "available",
  );
  const pages = documentState.loaded?.pages ?? NO_PAGES;
  const reading = useContinuousReading({
    paperId,
    attachmentId,
    pages,
    scale,
    rotation,
    width,
    navigation,
    onPositionObserved: (position) => {
      positionCache.current.set(position.attachmentId, position);
      locallyObserved.current.add(position.attachmentId);
    },
    onPositionChange: (position) =>
      callbacks.current.onPositionChange?.(position),
  });
  const pageIndex = pages.length ? reading.pageIndex : navigation.pageIndex;
  const effectiveScale =
    reading.layouts[pageIndex]?.scale ??
    (typeof scale === "number" ? scale : 1);
  const references = usePaperReferences({
    document: documentState.loaded?.document ?? null,
    paperId, attachmentId, attachments,
    enabled: mode === "select" && !saving,
    readerRef,
    onNavigate: navigateReference,
    onMessage: setActionError,
    onAttachmentReference: (request) => {
      // A citation in an older conversation retains its original PDF version.
      // Switch only on an explicit click and replay after that document loads.
      switchAttachment(request.attachmentId!);
      setPendingReference(request);
      setActionError("正在打开引用的来源附件…");
    },
  });

  useEffect(() => {
    activeAttachmentCallback.current?.(attachmentId);
  }, [attachmentId]);

  useEffect(() => {
    if (!pendingReference || pendingReference.paperId !== paperId ||
        pendingReference.attachmentId !== documentState.loaded?.attachmentId) return;
    const view = readerRef.current?.ownerDocument.defaultView;
    setPendingReference(null);
    view?.dispatchEvent(new CustomEvent(PAPER_REFERENCE_EVENT, { detail: pendingReference }));
  }, [pendingReference, documentState.loaded, paperId]);

  useEffect(() => {
    if (!attachmentId && defaultAttachmentId) {
      setAttachmentId(defaultAttachmentId);
      setNavigation({ attachmentId: defaultAttachmentId, pageIndex: 0 });
    }
  }, [attachmentId, defaultAttachmentId]);

  useEffect(() => {
    mergeReadingPositions(
      positionCache.current,
      [...readingPositions, ...(initialPosition ? [initialPosition] : [])],
      paperId,
      locallyObserved.current,
    );
  }, [initialPosition, readingPositions, paperId]);

  useEffect(() => {
    if (!target) return;
    references.closePreview();
    setPendingReference(null);
    reading.flushPosition();
    if (target.attachmentId !== attachmentId) {
      const previous = positionCache.current.get(target.attachmentId);
      setScale(previous?.scale ?? "page-width");
      setRotation(previous?.rotation ?? 0);
      setAttachmentId(target.attachmentId);
    }
    setNavigation(target);
    setHighlightLocation(target);
    setActiveId(target.annotationId ?? "");
    setActionError("");
    if (target.annotationId)
      callbacks.current.onSelectAnnotation?.(target.annotationId);
    // Only an explicit source request navigates, never a reading.set refresh.
    // An existing draft retains its original attachment/page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  useEffect(() => {
    const loaded = documentState.loaded;
    if (
      loaded &&
      highlightLocation?.attachmentId === attachmentId &&
      highlightLocation.pageIndex >= loaded.pages.length
    ) {
      setActionError(
        `来源物理页 ${highlightLocation.pageIndex + 1} 超出此附件的 ${loaded.pages.length} 页，无法定位；批注和引用仍保留。`,
      );
      setHighlightLocation(null);
      setActiveId("");
    }
  }, [highlightLocation, documentState.loaded, attachmentId]);

  useEffect(() => {
    const stage = reading.stageRef.current;
    if (!stage) return;
    let measured = width;
    const resize = new ResizeObserver(() => {
      const value = Math.max(180, stage.clientWidth - 32);
      if (value === measured) return;
      reading.holdScrollAnchor();
      measured = value;
      setWidth(value);
    });
    resize.observe(stage);
    return () => resize.disconnect();
    // The observer uses stable reader refs and records its own last width.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (focusMode && !previousFocus.current) {
      beforeFocus.current = expandedRef.current;
      setExpanded(false);
    } else if (!focusMode && previousFocus.current)
      setExpanded(beforeFocus.current);
    previousFocus.current = focusMode;
  }, [focusMode]);

  function switchAttachment(id: string) {
    references.closePreview();
    setPendingReference(null);
    reading.flushPosition();
    const position = positionCache.current.get(id);
    setAttachmentId(id);
    setScale(position?.scale ?? "page-width");
    setRotation(position?.rotation ?? 0);
    setNavigation({ attachmentId: id, pageIndex: position?.pageIndex ?? 0 });
    setHighlightLocation(null);
    setActiveId("");
    setActionError("");
  }
  function goToPage(index: number) {
    references.closePreview();
    setPendingReference(null);
    if (!pages.length) return;
    setNavigation({
      attachmentId,
      pageIndex: clampPageIndex(index, pages.length),
    });
    setHighlightLocation(null);
    setActiveId("");
    setActionError("");
  }
  function navigateReference(destination: ResolvedPdfDestination) {
    const pageIndex = destination.pageNumber - 1;
    const descriptor = pages[pageIndex];
    if (!descriptor) return;
    reading.flushPosition();
    const [left, bottom, right, top] = descriptor.page.view;
    const hasPoint = destination.left !== null || destination.top !== null;
    setNavigation({
      attachmentId, pageIndex,
      ...(hasPoint ? { rects: [{
        x: Math.max(0, Math.min(1, ((destination.left ?? left) - left) / (right - left))),
        y: Math.max(0, Math.min(1, ((destination.top ?? top) - bottom) / (top - bottom))),
        width: 0, height: 0,
      }] } : {}),
    });
    // Destination coordinates locate a heading, not an exact quotation mark.
    setHighlightLocation(null);
    setActiveId("");
    setActionError("");
  }
  function changeScale(value: number | "page-width") {
    reading.holdScrollAnchor();
    setScale(value);
  }
  function changeRotation() {
    reading.holdScrollAnchor();
    setRotation((value) => (value + 90) % 360);
  }
  function createDraft(value: PdfDraft, append = false): boolean {
    nativeDraft.current = null;
    const result = selectDraftSelection(draft, value, {
      append,
      saving: savingRef.current,
      hasComment: !!comment.trim(),
    });
    if (result.status === "rejected") {
      setActionError(result.message ?? "无法追加选段，已有批注已保留。");
      return false;
    }
    nativeDraft.current = value.kind === "highlight" ? value : null;
    if (result.status === "duplicate") {
      setActionError("");
      return true;
    }
    setDraft(result.draft);
    setCopiedOriginal(false);
    if (result.status === "created") setDraftExpanded(value.kind === "region");
    if (result.status === "created") setComment("");
    setActionError("");
    setMode("select");
    setExpanded(false);
    return true;
  }
  function undoDraftSegment() {
    if (!draft || savingRef.current) return;
    const next = removeLastDraftSegment(draft);
    setDraft(next);
    if (!next) setComment("");
    setActionError("");
    window.getSelection()?.removeAllRanges();
  }
  async function saveDraft() {
    if (!draft || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setActionError("");
    try {
      const value: PdfAnnotationDraft = {
        paperId: draft.paperId,
        attachmentId: draft.attachmentId,
        kind: draft.kind,
        pageIndex: draft.pageIndex,
        pageLabel: draft.pageLabel,
        rects: draft.rects,
        selectedText: draft.selectedText,
        ...(draft.kind === "highlight"
          ? { textSegments: draftTextSegments(draft) }
          : {}),
        comment,
        color,
      };
      await onCreateAnnotation(value);
      try { sessionStorage.removeItem(`research-new-annotation:${paperId}`); } catch {}
      setDraft(null);
      setComment("");
      window.getSelection()?.removeAllRanges();
    } catch (error: unknown) {
      setActionError(pdfError(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  async function jumpOutline(value: string) {
    const loaded = documentState.loaded;
    if (!loaded || value === "") return;
    try {
      const item = documentState.outline[Number(value)];
      const destination =
        typeof item.dest === "string"
          ? await loaded.document.getDestination(item.dest)
          : item.dest;
      const ref: unknown = destination?.[0];
      if (typeof ref === "number") goToPage(ref);
      else if (
        ref &&
        typeof ref === "object" &&
        "num" in ref &&
        "gen" in ref &&
        typeof ref.num === "number" &&
        typeof ref.gen === "number"
      )
        goToPage(
          await loaded.document.getPageIndex({ num: ref.num, gen: ref.gen }),
        );
      else setActionError("该目录项没有可定位的页面。");
    } catch (error: unknown) {
      setActionError(`目录定位失败：${pdfError(error)}`);
    }
  }

  return (
    <section
      ref={readerRef}
      className={styles.reader}
      aria-label="PDF 阅读器"
      data-focus-mode={focusMode}
      onKeyDown={(event) => {
        if (event.key === "Escape" && (references.preview || references.candidatesPreview || references.isLocating)) {
          event.stopPropagation();
          references.closePreview();
        }
      }}
      onCopy={(event) => {
        // Keep normal browser copying for a single native selection. Cmd/Ctrl
        // multi-selection additionally copies its earlier managed excerpts.
        const element = event.target instanceof Element ? event.target : null;
        if (!draft?.selectedText || element?.closest("input, textarea, [contenteditable='true']")) return;
        const selected = window.getSelection();
        if (selected?.toString()) {
          const source = nativeDraft.current;
          const startElement = selected.anchorNode instanceof Element ? selected.anchorNode : selected.anchorNode?.parentElement;
          const endElement = selected.focusNode instanceof Element ? selected.focusNode : selected.focusNode?.parentElement;
          const startPage = startElement?.closest<HTMLElement>("[data-pdf-page-index]");
          const endPage = endElement?.closest<HTMLElement>("[data-pdf-page-index]");
          if (!source || source.paperId !== draft.paperId || source.attachmentId !== draft.attachmentId ||
            source.pageIndex !== draft.pageIndex || startPage !== endPage ||
            startPage?.dataset.pdfAttachmentId !== source.attachmentId ||
            Number(startPage?.dataset.pdfPageIndex) !== source.pageIndex ||
            selected.toString().replace(/\s+/g, " ").trim() !== source.selectedText ||
            draftTextSegments(draft).length === 1) return;
        }
        event.clipboardData.setData("text/plain", draft.selectedText);
        event.preventDefault();
      }}
    >
      <PdfToolbar
        attachments={attachmentVersions}
        attachmentId={attachmentId}
        pageIndex={pageIndex}
        pageCount={pages.length}
        pageLabel={documentState.labels[pageIndex] ?? String(pageIndex + 1)}
        scale={scale}
        effectiveScale={effectiveScale}
        expanded={expanded}
        mode={mode}
        outline={documentState.outline}
        onToggle={() => setExpanded((value) => !value)}
        onAttachment={switchAttachment}
        onPage={goToPage}
        onScale={changeScale}
        onStepZoom={(direction) =>
          changeScale(stepZoom(scale, effectiveScale, direction))
        }
        onRotate={changeRotation}
        onMode={(value) => {
          references.closePreview();
          setMode(value);
          window.getSelection()?.removeAllRanges();
        }}
        onOutline={(value) => {
          void jumpOutline(value);
        }}
        onRequestAttachment={onRequestAttachment}
        aiBusy={aiBusy}
        onConvertPage={onConvertMarkdown ? () => onConvertMarkdown({
          paperId, attachmentId, pageIndex,
          pageLabel: documentState.labels[pageIndex] ?? String(pageIndex + 1),
          rects: [], selectedText: "", extractionScope: "page",
        }) : undefined}
      />
      {draft && <div className={styles.hint} role="status">
        <span>{recovery.storageError || (recovery.restored ? "已恢复未保存批注。" : "批注草稿保留在本窗口。")}
          来源：{attachments.find((item) => item.id === draft.attachmentId)?.filename} · 物理第 {draft.pageIndex + 1} 页。</span>
        <button type="button" onClick={() => {
          if (draft.attachmentId !== attachmentId) switchAttachment(draft.attachmentId);
          setNavigation(draft); setHighlightLocation(draft);
        }}>定位草稿来源</button>
      </div>}
      {(actionError || reading.positionError) && (
        <p className={styles.error} role="alert">
          {actionError || reading.positionError}
          {actionError && (
            <button
              type="button"
              aria-label="关闭 PDF 提示"
              onClick={references.closePreview}
            >
              ×
            </button>
          )}
        </p>
      )}
      <div
        className={styles.stage}
        ref={reading.stageRef}
        aria-label="连续 PDF 页面"
        tabIndex={0}
      >
        {!attachment ? (
          <div className={styles.empty}>
            <strong>
              {attachmentId ? "来源附件记录不存在" : "这篇文献还没有 PDF"}
            </strong>
            <p>你仍然可以写个人笔记。添加 PDF 附件后即可阅读与批注。</p>
            {onRequestAttachment && (
              <button type="button" onClick={onRequestAttachment}>
                选择本地 PDF
              </button>
            )}
          </div>
        ) : attachment.status === "missing" ? (
          <div className={styles.empty} role="alert">
            <strong>PDF 文件缺失或不可用</strong>
            <p>
              已有笔记和批注仍会保留。可以添加新附件，旧批注不会自动迁移到新版本。
            </p>
            {onRequestAttachment && (
              <button type="button" onClick={onRequestAttachment}>
                添加 PDF 附件
              </button>
            )}
          </div>
        ) : (
          <>
            {documentState.status && (
              <div className={styles.status} role="status">
                {documentState.status}
              </div>
            )}
            {documentState.error && (
              <div className={styles.empty} role="alert">
                <strong>PDF 加载失败</strong>
                <p>{documentState.error}</p>
                {onRequestAttachment && (
                  <button type="button" onClick={onRequestAttachment}>
                    添加其他附件
                  </button>
                )}
              </div>
            )}
            {pages.length > 0 && (
              <div
                className={styles.pages}
                ref={(element) => {
                  if (element)
                    element.style.width = `${Math.max(width, ...reading.layouts.map((item) => item.width))}px`;
                }}
              >
                {pages.map((descriptor, index) => (
                  <PdfPage
                    key={`${attachmentId}:${index}`}
                    paperId={paperId}
                    attachmentId={attachmentId}
                    descriptor={descriptor}
                    layout={reading.layouts[index]}
                    pageLabel={documentState.labels[index] ?? String(index + 1)}
                    rotation={rotation}
                    scrollRoot={reading.stageRef}
                    priority={index === reading.pageIndex}
                    mode={mode}
                    annotations={annotations.filter(
                      (item) =>
                        item.attachmentId === attachmentId &&
                        item.pageIndex === index,
                    )}
                    activeId={activeId}
                    draft={draft}
                    targetRects={
                      highlightLocation?.attachmentId === attachmentId &&
                      highlightLocation.pageIndex === index
                        ? highlightLocation.rects
                        : undefined
                    }
                    onDraft={createDraft}
                    onSelectAnnotation={(id) => {
                      setActiveId(id);
                      setHighlightLocation(null);
                      onSelectAnnotation?.(id);
                    }}
                    onMessage={setActionError}
                    guideMarks={
                      showGuideMarks
                        ? guideMarks.filter(
                            (item) =>
                              item.matched &&
                              item.paperId === paperId &&
                              item.attachmentId === attachmentId &&
                              item.attachmentSha256 === attachment?.sha256 &&
                              item.pageIndex === index,
                          )
                        : []
                    }
                    activeGuideMarkId={activeGuideMarkId}
                    guideTarget={
                      highlightLocation?.attachmentId === attachmentId &&
                      highlightLocation.pageIndex === index &&
                      showGuideMarks
                        ? highlightLocation
                        : undefined
                    }
                    onSelectGuideMark={onSelectGuideMark}
                    bibliography={references.bibliography}
                    onCitation={references.showCitation}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {references.preview && documentState.loaded && (
        <ReferencePreview
          preview={references.preview}
          document={documentState.loaded.document}
          pageLabel={documentState.labels[references.preview.entry.pageNumber - 1] ?? String(references.preview.entry.pageNumber)}
          onClose={references.closePreview}
          onJump={references.jumpToCitation}
          onFindPaper={onFindPaper}
        />
      )}
      {references.candidatesPreview && (
        <ReferenceCandidates
          key={references.candidatesPreview.generation}
          preview={references.candidatesPreview}
          pageLabels={documentState.labels}
          onClose={references.closePreview}
          onJump={references.jumpToCandidate}
        />
      )}
      {draft && !draftExpanded && (
        <div className={styles.selectionTools} role="toolbar" aria-label="选文工具">
          <span title={draft.selectedText}>{draft.kind === "region" ? "已框选区域" : `已选 ${draftTextSegments(draft).length} 处`} · 第 {draft.pageIndex + 1} 页</span>
          {draft.selectedText && <button type="button" aria-label={copiedOriginal ? "已复制原文" : "复制原文"} onClick={() => {
            void navigator.clipboard.writeText(draft.selectedText).then(() => setCopiedOriginal(true))
              .catch(() => setActionError("剪贴板不可用，请聚焦 PDF 后按 ⌘ / Ctrl + C 复制原文。"));
          }}>{copiedOriginal ? "已复制" : "复制"}</button>}
          {onTranslateSelection && draft.selectedText && <button type="button" disabled={saving || aiBusy}
            onClick={() => onTranslateSelection(draft)}>翻译</button>}
          {onExplainSelection && draft.selectedText && <button type="button" disabled={saving || aiBusy}
            aria-label="结合论文分析" title="结合论文上下文分析所选文字"
            onClick={() => onExplainSelection(draft)}>分析</button>}
          {onConvertMarkdown && <button type="button" disabled={saving || aiBusy}
            title="根据 PDF 选区图像识别文字与公式；生成后可检查并复制源码"
            onClick={() => onConvertMarkdown({ ...draft, extractionScope: "selection" })}>转 Markdown</button>}
          {draft.kind === "highlight" && !comment.trim() && <button type="button" disabled={saving}
            title="只保存文字高亮，不加入批注列表" onClick={() => { void saveDraft(); }}>
            {saving ? "保存中…" : "保存高亮"}</button>}
          <button type="button" disabled={saving} aria-label={comment ? "继续批注" : "添加批注"} onClick={() => {
            setDraftExpanded(true); onOpenAnnotation?.();
          }}>{comment ? "继续批注" : "评论"}</button>
          <button type="button" aria-label="取消选文" disabled={saving} onClick={() => {
            if (comment.trim()) { setDraftExpanded(true); onOpenAnnotation?.(); return; }
            setDraft(null); setActionError(""); window.getSelection()?.removeAllRanges();
          }}>收起</button>
        </div>
      )}
      {draft && draftExpanded && (
        <form
          className={styles.draft}
          onSubmit={(event) => {
            event.preventDefault();
            void saveDraft();
          }}
        >
          <p className={styles.hint}>
            {draft.kind === "highlight"
              ? `按住 ⌘（Windows / Linux 为 Ctrl）追加本页选文；直接划选会替换选文。有未保存评论时会保留原草稿。物理第 ${draft.pageIndex + 1} 页。`
              : `草稿绑定此附件的物理第 ${draft.pageIndex + 1} 页；滚动、缩放和切换附件不会改变其来源。`}
          </p>
          <div>
            <strong>
              {draft.kind === "region"
                ? "区域批注"
                : `文字高亮 · 已选 ${draftTextSegments(draft).length} 处`}{" "}
              · 物理第 {draft.pageIndex + 1} 页
              {draft.pageLabel !== String(draft.pageIndex + 1)
                ? `（${draft.pageLabel}）`
                : ""}
            </strong>
            {draft.kind === "highlight" && (
              <button
                type="button"
                disabled={saving}
                onClick={undoDraftSegment}
                aria-label="撤销上一处选文"
                title="移除最后选择的文字；撤销全部选文后取消此草稿"
              >
                撤销上一处
              </button>
            )}
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                if (comment.trim() && !window.confirm("确定放弃这条未保存的批注评论？")) return;
                setDraft(null);
                setComment("");
                setActionError("");
                window.getSelection()?.removeAllRanges();
              }}
              aria-label="取消新批注"
            >
              取消
            </button>
          </div>
          {draft.kind === "highlight" && draftTextSegments(draft).length > 1 ? (
            <details className={styles.draftSegments}>
              <summary>查看 {draftTextSegments(draft).length} 处原文</summary>
              <ol>
                {draftTextSegments(draft).map((segment, index) => (
                  <li key={index}>
                    <blockquote>{segment.selectedText}</blockquote>
                  </li>
                ))}
              </ol>
            </details>
          ) : draft.selectedText ? (
            <blockquote>{draft.selectedText}</blockquote>
          ) : (
            <p>已标记页内区域；此处没有识别或伪造文字。</p>
          )}
          <label>
            我的评论
            <textarea
              aria-label="新批注评论"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="写下疑问或自己的理解（可选）"
              disabled={saving}
            />
          </label>
          <div>
            <label>
              颜色{" "}
              <select
                aria-label="批注颜色"
                value={color}
                disabled={saving}
                onChange={(event) => setColor(event.target.value)}
              >
                <option value="#f5cf58">黄色</option>
                <option value="#88c9a1">绿色</option>
                <option value="#8db7e9">蓝色</option>
                <option value="#e3a0be">粉色</option>
              </select>
            </label>
            <button type="submit" disabled={saving}>
              {saving ? "保存中…" : comment.trim() ? "保存批注" : draft.kind === "highlight" ? "保存高亮" : "保存区域标记"}
            </button>
            {onExplainSelection && draft.selectedText && (
              <button
                type="button"
                disabled={saving || aiBusy}
                onClick={() => { setDraftExpanded(false); onExplainSelection(draft); }}
              >
                结合论文分析
              </button>
            )}
            {onTranslateSelection && draft.selectedText && <button type="button" disabled={saving || aiBusy}
              onClick={() => { setDraftExpanded(false); onTranslateSelection(draft); }}>翻译</button>}
            {onConvertMarkdown && <button type="button" disabled={saving || aiBusy}
              onClick={() => { setDraftExpanded(false);
                onConvertMarkdown({ ...draft, extractionScope: "selection" }); }}>
              {draft.kind === "region" ? "识别公式 / 转 Markdown" : "转 Markdown + LaTeX"}</button>}
          </div>
        </form>
      )}
    </section>
  );
}

export default PdfReader;
