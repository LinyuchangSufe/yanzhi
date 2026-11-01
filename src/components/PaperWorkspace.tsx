"use client";
import { FileText, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Annotation } from "../lib/types";
import { hasAnnotationComment } from "../lib/annotation-display";
import { annotationOverview, confirmAnnotationDeletion, type AnnotationFilter } from "./editor/annotation-overview";
import AnnotationMore from "./editor/AnnotationMore";
import annotationStyles from "./editor/AnnotationOverview.module.css";
import type { GuideEvidence } from "../lib/guide/types";
import GuidePanel, { guideResults } from "./GuidePanel";
import SelectionAssistant from "./SelectionAssistant";
import PaperChatPanel from "./PaperChatPanel";
import type { WorkspaceController } from "./Workspace";
import baseStyles from "./Workspace.module.css";
import {
  citeAnnotation,
  errorMessage,
  formatDate,
  linked,
} from "./WorkspaceShared";
import PdfReader from "./pdf/PdfReader";
import { useProtectedDraft } from "./editor/useProtectedDraft";
import TooltipButton from "./TooltipButton";
import contentStyles from "./styles/WorkspaceContent.module.css";
const styles = { ...baseStyles, ...contentStyles };

export function PaperWorkspace({ c }: { c: WorkspaceController }) {
  const [activeGuideId, setActiveGuideId] = useState("");
  const [showGuideMarks, setShowGuideMarks] = useState(true);
  const [activeGuideMarkId, setActiveGuideMarkId] = useState("");
  const [highlightInspector, setHighlightInspector] = useState<{ paperId: string; id: string } | null>(null);
  const [readerAttachment, setReaderAttachment] = useState<{ paperId: string; attachmentId: string } | null>(null);
  const [annotationFilter, setAnnotationFilter] = useState<AnnotationFilter>("all");
  useEffect(() => setAnnotationFilter("all"), [c.paper?.id]);
  const evidenceNavigation = useRef(0);
  const currentPaperId = useRef(c.paper?.id);
  currentPaperId.current = c.paper?.id;
  const {
    readingLayout,
    backlinks,
    state,
    tab,
    target,
    selectedAnnotation,
    attachInput,
    attachmentTarget,
    requestAttachment,
    split,
    splitRef,
    splitContainer,
    paper,
    activeNote,
    ideas,
    sourceLists,
    editorFor,
    setTab,
    setError,
    setDialog,
    setTarget,
    setSelectedAnnotation,
    setSplit,
    mutate,
    safeMutate,
    leaveEditor,
    navigate,
    createIdea,
    uploadAttachment,
  } = c;
  const guideVersions = paper ? guideResults(state, paper.id) : [];
  const activeGuide =
    guideVersions.find((a) => a.id === activeGuideId) || guideVersions[0];
  const marks = annotationOverview(state.annotations, paper?.id ?? "");
  const visibleMarks = marks[annotationFilter];
  const deleteMark = async (annotation: Annotation) => {
    try {
      await confirmAnnotationDeletion(annotation, { referenced: backlinks("annotation", annotation.id).length > 0,
        confirm: (message) => window.confirm(message), remove: async () => { await mutate("annotation.delete", { id: annotation.id }); } });
    } catch (error) { setError(errorMessage(error)); }
  };
  const inspectedHighlight = highlightInspector?.paperId === paper?.id
    ? state.annotations.find((item) => item.id === highlightInspector?.id && item.paperId === paper?.id)
    : undefined;
  const selectionTask = c.aiTask?.paperId === paper?.id ? c.aiTask : null;
  const selectionResult = selectionTask?.resultId
    ? state.aiContents.find((item) => item.id === selectionTask.resultId) ||
      (c.aiResult?.id === selectionTask.resultId ? c.aiResult : undefined) : undefined;
  const chatAttachmentId = readerAttachment?.paperId === paper?.id
    ? readerAttachment?.attachmentId
    : state.readingPositions.filter((item) => item.paperId === paper?.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.attachmentId
      ?? state.attachments.filter((item) => item.paperId === paper?.id && item.status === "available")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]?.id;
  const chatAttachment = state.attachments.find((item) => item.id === chatAttachmentId);
  const selectGuideResult = useCallback(
    (id: string) => {
      evidenceNavigation.current += 1;
      setActiveGuideId(id);
      setActiveGuideMarkId("");
      setTarget(undefined);
    },
    [setTarget],
  );
  const selectGuideEvidence = async (evidence: GuideEvidence) => {
    const request = ++evidenceNavigation.current;
    const originPaperId = paper?.id;
    if (
      !(await leaveEditor()) ||
      request !== evidenceNavigation.current ||
      currentPaperId.current !== originPaperId
    )
      return;
    setActiveGuideId(activeGuide?.id || "");
    if (originPaperId !== evidence.paperId) {
      if (!(await navigate({ kind: "paper", id: evidence.paperId }, "ai")))
        return;
      if (
        request !== evidenceNavigation.current ||
        ![originPaperId, evidence.paperId].includes(currentPaperId.current)
      )
        return;
    }
    setActiveGuideMarkId(evidence.id);
    readingLayout.revealNotes();
    setTab("ai");
    setTarget({
      attachmentId: evidence.attachmentId,
      pageIndex: evidence.pageIndex,
      guideMarkId: evidence.matched ? evidence.id : undefined,
    });
  };
  return (
    <>
      {paper && (
        <div
          className={`${styles.paperWorkspace} ${readingLayout.notesHidden ? styles.paperWorkspaceWide : ""} ${readingLayout.focus ? styles.paperWorkspaceFocus : ""}`}
        >
          {paper.deletedAt && (
            <div className={styles.trashNotice} role="status">
              <span>此文献已在回收站中，原有 PDF、笔记和引用仍保留。</span>
              <button
                disabled={c.busy}
                onClick={() => void c.changePaperAvailability(paper, true)}
              >
                恢复文献
              </button>
            </div>
          )}
          <div className={styles.splitWorkspace} ref={splitContainer}>
            <section
              className={styles.pdfPane}
              style={{
                flexBasis: readingLayout.notesHidden ? "100%" : `${split}%`,
              }}
            >
              <PdfReader
                key={paper.id}
                focusMode={readingLayout.focus}
                paperId={paper.id}
                onFindPaper={(query) => c.openLiterature(query, { paperIds: [paper.id] })}
                onActiveAttachmentChange={(attachmentId) => setReaderAttachment((current) =>
                  current?.paperId === paper.id && current.attachmentId === attachmentId
                    ? current : { paperId: paper.id, attachmentId })}
                attachments={state.attachments.filter(
                  (a) => a.paperId === paper.id,
                )}
                annotations={state.annotations.filter(
                  (a) => a.paperId === paper.id,
                )}
                initialPosition={
                  state.readingPositions
                    .filter((p) => p.paperId === paper.id)
                    .sort((left, right) =>
                      right.updatedAt.localeCompare(left.updatedAt),
                    )[0]
                }
                readingPositions={state.readingPositions.filter(
                  (position) => position.paperId === paper.id,
                )}
                target={target}
                guideMarks={activeGuide?.guideData?.evidence}
                showGuideMarks={showGuideMarks}
                activeGuideMarkId={activeGuideMarkId}
                onSelectGuideMark={(id) => {
                  const evidence = activeGuide?.guideData?.evidence.find(
                    (e) => e.id === id,
                  );
                  if (evidence) void selectGuideEvidence(evidence);
                }}
                onCreateAnnotation={async (draft) => {
                  await mutate("annotation.create", draft);
                  if (!hasAnnotationComment(draft)) return;
                  try {
                    // This is the just-saved draft's own completion, not navigation away.
                    // Its saving guard stays active until PdfReader clears the draft.
                    await c.editor.current?.flush();
                    setHighlightInspector(null);
                    setAnnotationFilter("all");
                    readingLayout.revealNotes();
                    setTab("annotations");
                  } catch (error) {
                    setError(errorMessage(error));
                  }
                }}
                onSelectAnnotation={async (id) => {
                  setAnnotationFilter("all");
                  const mark = state.annotations.find((item) => item.id === id && item.paperId === paper.id);
                  if (mark && !hasAnnotationComment(mark)) {
                    setHighlightInspector({ paperId: paper.id, id });
                    setSelectedAnnotation(id);
                    c.setAiCollapsed(true);
                    return;
                  }
                  if (!(await leaveEditor())) return;
                  setHighlightInspector(null);
                  readingLayout.revealNotes();
                  setSelectedAnnotation(id);
                  setTab("annotations");
                }}
                onExplainSelection={
                  paper.deletedAt
                    ? undefined
                    : (value) => { setHighlightInspector(null); void c.generateAI("explanation", value); }
                }
                onTranslateSelection={paper.deletedAt ? undefined : (value) => { setHighlightInspector(null); void c.generateAI("translation", value); }}
                onConvertMarkdown={paper.deletedAt ? undefined : (value) => { setHighlightInspector(null); void c.generateAI("markdown", value); }}
                aiBusy={c.aiBusy}
                onOpenAnnotation={() => { setHighlightInspector(null); c.setAiCollapsed(true); }}
                onPositionChange={async (position) => {
                  await mutate("reading.set", {
                    paperId: paper.id,
                    attachmentId: position.attachmentId,
                    pageIndex: position.pageIndex,
                    scale: position.scale,
                    rotation: position.rotation,
                  });
                }}
                onRequestAttachment={
                  paper.deletedAt
                    ? undefined
                    : () => requestAttachment(paper)
                }
              />
              {inspectedHighlight && (
                <section className={styles.highlightInspector} role="dialog" aria-label="高亮标记" aria-modal="false">
                  <header>
                    <strong>高亮标记 · 第 {inspectedHighlight.pageIndex + 1} 页</strong>
                    <TooltipButton type="button" aria-label="关闭高亮标记" onClick={() => setHighlightInspector(null)}><X size={15} /></TooltipButton>
                  </header>
                  <div className={styles.highlightInspectorBody}>
                    <blockquote>{inspectedHighlight.selectedText || "已保存的页内区域标记。"}</blockquote>
                    <p>{hasAnnotationComment(inspectedHighlight) ? "已添加评论，可在标注栏查看。" : "已保存高亮，可在标注栏中找到。"}</p>
                    <AnnotationComment key={inspectedHighlight.id} annotation={inspectedHighlight}
                      onSave={async (comment, revision) => {
                        const result = await mutate("annotation.update", { id: inspectedHighlight.id, revision, comment });
                        const saved = result.state.annotations.find((item) => item.id === inspectedHighlight.id);
                        if (saved && hasAnnotationComment(saved)) {
                          try { sessionStorage.removeItem(`research-annotation-comment:${saved.id}`); } catch {}
                          setHighlightInspector(null);
                          setSelectedAnnotation(saved.id);
                          try {
                            await c.editor.current?.flush();
                            readingLayout.revealNotes(); setTab("annotations");
                          } catch (error) { setError(errorMessage(error)); }
                        }
                        return saved;
                      }} />
                    <div className={styles.annotationActions}>
                      <button type="button" onClick={() => setTarget({ attachmentId: inspectedHighlight.attachmentId,
                        pageIndex: inspectedHighlight.pageIndex, rects: inspectedHighlight.rects, annotationId: inspectedHighlight.id })}>定位高亮</button>
                      <button type="button" onClick={async () => {
                        if (!(await leaveEditor())) return;
                        readingLayout.revealNotes();
                        setSelectedAnnotation(inspectedHighlight.id);
                        setAnnotationFilter("all");
                        setTab("annotations");
                        setHighlightInspector(null);
                      }}>查看标注</button>
                    </div>
                    <AnnotationMore><button type="button" className={annotationStyles.danger} onClick={() => void deleteMark(inspectedHighlight)}>删除高亮</button></AnnotationMore>
                  </div>
                </section>
              )}
              {selectionTask && <SelectionAssistant task={selectionTask} result={selectionResult}
                collapsed={c.aiCollapsed} onCollapse={c.setAiCollapsed} onClose={c.dismissAI}
                onCancel={c.cancelAI} onRetry={() => { void c.generateAI(selectionTask.kind, selectionTask.selection, true); }}
                onNavigate={(href) => { void c.navigateLink(href); }}
                onLocate={() => { if (selectionTask.selection) setTarget(selectionTask.selection); }}
                onInsert={(body) => { if (selectionResult) setDialog({ kind: "insert",
                  text: `\n> ${(body ?? selectionResult.body).replace(/\n/g, "\n> ")}\n> — [${selectionResult.kind === "markdown" ? "PDF 识别来源" : "AI 来源"}：${selectionResult.model}](kb://ai/${selectionResult.id})\n\n` }); }} />}
            </section>
            {!readingLayout.notesHidden && (
              <div
                className={styles.splitter}
                role="separator"
                aria-label="调整 PDF 与笔记宽度"
                aria-orientation="vertical"
                aria-valuemin={35}
                aria-valuemax={75}
                aria-valuenow={split}
                aria-valuetext={`PDF ${Math.round(split)}%，笔记 ${100 - Math.round(split)}%`}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    e.preventDefault();
                    const value = Math.max(
                      35,
                      Math.min(75, splitRef.current + (e.key === "ArrowRight" ? 2 : -2)),
                    );
                    splitRef.current = value;
                    setSplit(value);
                    void safeMutate("settings.update", {
                      splitRatio: value / 100,
                    });
                  }
                }}
                onPointerDown={(e) => {
                  const el = e.currentTarget;
                  el.setPointerCapture(e.pointerId);
                  const move = (event: PointerEvent) => {
                    const rect =
                      splitContainer.current?.getBoundingClientRect();
                    if (rect) {
                      const value = Math.max(35, Math.min(75, ((event.clientX - rect.left) / rect.width) * 100));
                      splitRef.current = value;
                      setSplit(value);
                    }
                  };
                  const stop = () => {
                    el.removeEventListener("pointermove", move);
                    el.removeEventListener("pointerup", stop);
                    void safeMutate("settings.update", {
                      splitRatio: splitRef.current / 100,
                    });
                  };
                  el.addEventListener("pointermove", move);
                  el.addEventListener("pointerup", stop, { once: true });
                }}
              />
            )}
            <aside
              className={styles.notePane}
              hidden={readingLayout.notesHidden}
              aria-hidden={readingLayout.notesHidden}
              inert={readingLayout.notesHidden}
            >
              <div className={styles.tabs} role="tablist" aria-label="论文工作区">
                {(
                  [
                    ["notes", "我的笔记"],
                    [
                      "annotations",
                      `标注 ${marks.all.length}`,
                    ],
                    ["ai", "AI 导读"],
                    ["chat", "论文对话"],
                  ] as const
                ).map(([id, text]) => (
                  <button
                    key={id}
                    id={`paper-tab-${id}`}
                    role="tab"
                    aria-controls="paper-tab-panel"
                    tabIndex={tab === id ? 0 : -1}
                    aria-selected={tab === id}
                    onKeyDown={(event) => {
                      const tabs = ["notes", "annotations", "ai", "chat"] as const;
                      const index = tabs.indexOf(id);
                      const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] :
                        event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] :
                        event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : null;
                      if (!next) return;
                      event.preventDefault();
                      void leaveEditor().then((allowed) => {
                        if (!allowed) return;
                        setTab(next); document.getElementById(`paper-tab-${next}`)?.focus();
                      });
                    }}
                    onClick={async () => {
                      if (await leaveEditor()) setTab(id);
                    }}
                  >
                    {text}
                  </button>
                ))}
              </div>
              <div className={styles.tabContent} id="paper-tab-panel" role="tabpanel" aria-labelledby={`paper-tab-${tab}`}>
                {tab === "chat" && (
                  <PaperChatPanel
                    key={paper.id}
                    paperId={paper.id}
                    paperTitle={paper.title}
                    attachmentId={chatAttachment?.id}
                    attachmentName={chatAttachment?.filename}
                    attachments={state.attachments.filter((item) => item.paperId === paper.id)}
                    disabled={Boolean(paper.deletedAt)}
                    onNavigate={(href) => void c.navigateLink(href)}
                    onSettings={() => void c.chooseSection("settings")}
                    onFindPaper={(query) => c.openLiterature(query, { paperIds: [paper.id] })}
                    onInsert={(text) => setDialog({ kind: "insert", text })}
                  />
                )}
                {tab === "notes" && (
                  <>
                    {activeNote ? (
                      editorFor(activeNote)
                    ) : (
                      <div className={styles.emptySmall}>
                        <p>尚无主研究笔记。</p>
                        <button
                          onClick={() =>
                            void safeMutate("note.create", {
                              purpose: "paper",
                              title: `${paper.title} · 研究笔记`,
                              paperIds: [paper.id],
                            })
                          }
                        >
                          创建笔记
                        </button>
                      </div>
                    )}
                    <details className={styles.secondary}>
                      <summary>相关想法与引用</summary>
                      <button
                        onClick={async () => {
                          const n = await createIdea("新的研究想法", "", [
                            paper.id,
                          ]);
                          if (n) await navigate({ kind: "note", id: n.id });
                        }}
                      >
                        新建关联想法
                      </button>
                      {ideas
                        .filter((n) =>
                          linked(state, "note", n.id, "paper", paper.id),
                        )
                        .map((n) => (
                          <button
                            key={n.id}
                            onClick={() =>
                              void navigate({ kind: "note", id: n.id })
                            }
                          >
                            {n.title}
                          </button>
                        ))}
                      {sourceLists("paper", paper.id)}
                    </details>
                  </>
                )}
                {tab === "annotations" && (
                  <div className={styles.annotationList}>
                    <div className={annotationStyles.filters} role="group" aria-label="筛选标注">
                      {([["all", "全部"], ["highlights", "高亮"], ["comments", "批注"]] as const).map(([filter, label]) =>
                        <button key={filter} type="button" aria-pressed={annotationFilter === filter} onClick={() => setAnnotationFilter(filter)}>{label} {marks[filter].length}</button>)}
                    </div>
                    {visibleMarks.map((a) => (
                        <div
                          key={a.id}
                          id={`annotation-${a.id}`}
                          className={`${styles.annotationCard} ${selectedAnnotation === a.id ? styles.annotationSelected : ""}`}
                        >
                          <button
                            className={styles.annotationSource}
                            onClick={() => {
                              setTarget({
                                attachmentId: a.attachmentId,
                                pageIndex: a.pageIndex,
                                rects: a.rects,
                                annotationId: a.id,
                              });
                              setSelectedAnnotation(a.id);
                            }}
                          >
                            <span
                              className={styles.colorDot}
                              style={{ backgroundColor: a.color }}
                            />
                            <strong>物理第 {a.pageIndex + 1} 页</strong>
                            <span>
                              {a.kind === "region" ? "区域标注" : hasAnnotationComment(a) ? "文字批注" : "文本高亮"}
                            </span>
                            {a.pageLabel.trim() && a.pageLabel.trim() !== String(a.pageIndex + 1) && <span>原页码 {a.pageLabel.trim()}</span>}
                          </button>
                          <blockquote>
                            {a.selectedText ||
                              "此批注标记页内区域，没有可提取文字。"}
                          </blockquote>
                          {hasAnnotationComment(a) && <p className={annotationStyles.comment}>{a.comment}</p>}
                          <AnnotationMore actions={<>
                            <button type="button" onClick={() => setDialog({ kind: "insert", text: citeAnnotation(a, state) })}>添加到笔记</button>
                            <small>{formatDate(a.updatedAt)}</small>
                          </>}>
                          <AnnotationComment
                            annotation={a}
                            onSave={async (comment, revision) => {
                              const result = await mutate("annotation.update", {
                                id: a.id,
                                revision,
                                comment,
                              });
                              return result.state.annotations.find((item) => item.id === a.id);
                            }}
                          />
                          <div className={styles.annotationActions}>
                            {a.selectedText && (
                              <button disabled={Boolean(paper.deletedAt) || c.aiBusy}
                                onClick={() => { void c.generateAI("translation", { paperId: a.paperId,
                                  pageLabel: a.pageLabel, selectedText: a.selectedText, attachmentId: a.attachmentId,
                                  pageIndex: a.pageIndex, rects: a.rects }); }}>翻译</button>
                            )}
                            {a.selectedText && (
                              <button
                                disabled={Boolean(paper.deletedAt) || c.aiBusy}
                                onClick={() => {
                                  void c.generateAI("explanation", {
                                    paperId: a.paperId,
                                    pageLabel: a.pageLabel,
                                    selectedText: a.selectedText,
                                    attachmentId: a.attachmentId,
                                    pageIndex: a.pageIndex,
                                    rects: a.rects,
                                  });
                                }}
                              >
                                结合论文分析
                              </button>
                            )}
                            <button type="button" className={annotationStyles.danger} onClick={() => void deleteMark(a)}>删除标注</button>
                          </div>
                          </AnnotationMore>
                          {backlinks("annotation", a.id).length > 0 &&
                            sourceLists("annotation", a.id)}
                        </div>
                      ))}
                    {!visibleMarks.length && (
                      <div className={styles.emptySmall}>
                        <FileText size={24} />
                        <p>
                          {marks.all.length ? "当前筛选下没有标注。" : "选择 PDF 文本或框选区域，保存的高亮与批注都会显示在这里。"}
                        </p>
                      </div>
                    )}
                  </div>
                )}
                {tab === "ai" && (
                  <GuidePanel
                    key={paper.id}
                    c={c}
                    activeResult={activeGuide}
                    onResultChange={selectGuideResult}
                    marksVisible={showGuideMarks}
                    onMarksVisibleChange={setShowGuideMarks}
                    selectedEvidenceId={activeGuideMarkId}
                    onSelectEvidence={selectGuideEvidence}
                    onResearchItem={(draft) => c.openResearchItem(draft, { paperIds: [paper.id] })}
                    onDiscuss={(draft) => void c.discussSources(draft, { paperIds: [paper.id] })}
                  />
                )}
              </div>
            </aside>
          </div>
          <input
            ref={attachInput}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              const paperId = attachmentTarget.current;
              attachmentTarget.current = null;
              e.target.value = "";
              if (file && paperId) void uploadAttachment(file, paperId);
            }}
          />
        </div>
      )}
    </>
  );
}
function AnnotationComment({
  annotation,
  onSave,
}: {
  annotation: Annotation;
  onSave: (value: string, revision: number) => Promise<Annotation | undefined>;
}) {
  const [value, setValue] = useState({ comment: annotation.comment, revision: annotation.revision });
  const previous = useRef(annotation);
  const commentRoot = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const changed = value.comment !== annotation.comment;
  useEffect(() => { if (changed) { const disclosure = commentRoot.current?.closest("details"); if (disclosure) disclosure.open = true; } }, [changed]);
  const draft = useProtectedDraft({
    key: `research-annotation-comment:${annotation.id}`, value, dirty: changed, blocked: saving,
    validate: (item: unknown): item is typeof value => Boolean(item && typeof item === "object" &&
      "comment" in item && typeof item.comment === "string" && "revision" in item &&
      typeof item.revision === "number" && Number.isSafeInteger(item.revision) && item.revision > 0),
    restore: setValue,
  });
  useEffect(() => {
    const old = previous.current;
    setValue((current) => current.comment === old.comment && current.revision === old.revision
      ? { comment: annotation.comment, revision: annotation.revision } : current);
    previous.current = annotation;
  }, [annotation.comment, annotation.revision]);
  return (
    <div ref={commentRoot} className={styles.annotationComment}>
      {changed && value.revision !== annotation.revision && <details>
        <summary>评论已在其他位置更新，核对当前已保存内容</summary>
        <blockquote>{annotation.comment || "当前没有评论。"}</blockquote>
      </details>}
      <textarea
        aria-label="批注评论"
        value={value.comment}
        disabled={saving}
        onChange={(e) => { setValue({ ...value, comment: e.target.value }); setStatus(""); }}
        placeholder="写下你的评论…"
        rows={2}
      />
      <div>
        {changed && (
          <>
          <button
            disabled={saving}
            onClick={async () => {
              const conflicted = value.revision !== annotation.revision;
              if (conflicted && !window.confirm("当前评论已更新。确定已核对，并用你的草稿替换当前已保存评论？")) return;
              setSaving(true);
              setStatus("保存中…");
              try {
                const saved = await onSave(value.comment, conflicted ? annotation.revision : value.revision);
                if (!saved) throw new Error("保存后未找到批注，请刷新核对；当前草稿仍保留。");
                setValue({ comment: saved.comment, revision: saved.revision });
                try { sessionStorage.removeItem(`research-annotation-comment:${annotation.id}`); } catch {}
                setStatus("已保存");
              } catch (e) {
                setStatus(errorMessage(e));
              } finally {
                setSaving(false);
              }
            }}
          >
            {value.revision !== annotation.revision ? "核对后保存草稿" : "保存评论"}
          </button>
          <button disabled={saving} onClick={() => {
            setValue({ comment: annotation.comment, revision: annotation.revision }); setStatus("");
          }}>放弃修改</button>
          </>
        )}
        <small role="status">{status || draft.storageError || (changed ?
          value.revision !== annotation.revision ? "原评论已更新，草稿保留；请展开核对后保存，或放弃修改。" :
          draft.restored ? "已恢复本窗口未保存评论。" : "未保存评论已保留在本窗口。" : "")}</small>
      </div>
    </div>
  );
}
