"use client";
import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  Eye,
  EyeOff,
  Link2,
  LoaderCircle,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GuideEvidence, GuideJob, GuideSection } from "../lib/guide/types";
import { cleanGuideText } from "../lib/guide/text";
import { aiErrorRecovery } from "../lib/ai-error-recovery";
import type { AIContent, KBState, Paper } from "../lib/types";
import type { ResearchItemDraft } from "../lib/research-items/types";
import type { IdeaSourceInput } from "../lib/idea-lab/types";
import Markdown from "./Markdown";
import TooltipButton from "./TooltipButton";
import PaperAIHistory from "./PaperAIHistory";
import ReadingTools from "./editor/ReadingTools";
import type { WorkspaceController } from "./Workspace";
import { errorMessage, readResponse } from "./WorkspaceShared";
import styles from "./GuidePanel.module.css";
const categoryNames: Record<GuideEvidence["category"], string> = {
  problem: "研究问题",
  method: "核心方法",
  assumption: "关键假设",
  theorem: "主要结论",
  proof: "证明技巧",
  experiment: "实验验证",
  limitation: "适用边界",
};
const basisNames: Record<GuideSection["basis"], string> = {
  author: "原文陈述",
  analysis: "AI 分析",
  question: "待探索问题",
  "not-stated": "材料未说明",
};
const activeStatus = (job: GuideJob) =>
  job.status === "queued" || job.status === "running";
const availableAttachments = (state: KBState, paperId: string) =>
  state.attachments.filter(
    (a) => a.paperId === paperId && a.status === "available",
  );
export function guideResults(state: KBState, paperId: string) {
  return state.aiContents
    .filter(
      (a) =>
        a.guideData &&
        (a.paperId === paperId || a.guideData.paperIds.includes(paperId)),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function relatedPapers(state: KBState, paper: Paper) {
  const groups = new Set(
    state.relations.flatMap((r) => {
      if (
        r.fromType === "paper" &&
        r.fromId === paper.id &&
        ["topic", "tag"].includes(r.toType)
      )
        return [`${r.toType}:${r.toId}`];
      if (
        r.toType === "paper" &&
        r.toId === paper.id &&
        ["topic", "tag"].includes(r.fromType)
      )
        return [`${r.fromType}:${r.fromId}`];
      return [];
    }),
  );
  return state.papers
    .filter(
      (p) =>
        !p.deletedAt &&
        p.id !== paper.id &&
        availableAttachments(state, p.id).length,
    )
    .map((p) => {
      let score = 0;
      let reason = "本地文献库";
      for (const r of state.relations) {
        if (
          (r.fromId === p.id && r.toId === paper.id) ||
          (r.toId === p.id && r.fromId === paper.id)
        ) {
          score += 4;
          reason = "已有手动关联";
        }
        if (
          (r.fromType === "paper" &&
            r.fromId === p.id &&
            groups.has(`${r.toType}:${r.toId}`)) ||
          (r.toType === "paper" &&
            r.toId === p.id &&
            groups.has(`${r.fromType}:${r.fromId}`))
        ) {
          score += 2;
          if (score <= 2) reason = "共享研究问题或标签";
        }
      }
      return { paper: p, score, reason };
    })
    .sort(
      (a, b) =>
        b.score - a.score || b.paper.createdAt.localeCompare(a.paper.createdAt),
    );
}

export default function GuidePanel({
  c,
  activeResult,
  onResultChange,
  marksVisible,
  onMarksVisibleChange,
  selectedEvidenceId,
  onSelectEvidence,
  onResearchItem,
  onDiscuss,
}: {
  c: WorkspaceController;
  activeResult?: AIContent;
  onResultChange: (id: string) => void;
  marksVisible: boolean;
  onMarksVisibleChange: (value: boolean) => void;
  selectedEvidenceId: string;
  onSelectEvidence: (evidence: GuideEvidence) => void | Promise<void>;
  onResearchItem?: (draft: ResearchItemDraft) => void;
  onDiscuss?: (input: { sources: IdeaSourceInput[]; prompt?: string; title?: string }) => void;
}) {
  const {
    paper,
    state,
    selection: workspaceSelection,
    aiBusy,
    aiError,
    setSelection,
    generateAI,
    refresh,
    setDialog,
    chooseSection,
    navigateLink,
  } = c;
  const paperId = paper?.id || "";
  const archived = Boolean(paper?.deletedAt);
  const selection =
    workspaceSelection?.paperId === paperId ? workspaceSelection : null;
  const attachments = useMemo(
    () => availableAttachments(state, paperId),
    [state, paperId],
  );
  const [sourceIds, setSourceIds] = useState<string[]>(() =>
    attachments.map((a) => a.id),
  );
  const [jobs, setJobs] = useState<GuideJob[]>([]);
  const [requestBusy, setRequestBusy] = useState(false);
  const [error, setError] = useState("");
  const failedRequest = useRef<object | null>(null);
  const displayedError = error || aiError;
  const recovery = aiErrorRecovery(displayedError);
  const [relatedOpen, setRelatedOpen] = useState(false);
  const [otherPaperIds, setOtherPaperIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [moreEvidenceOpen, setMoreEvidenceOpen] = useState(false);
  const refreshed = useRef(new Set<string>());
  const observedRunning = useRef(new Set<string>());
  const generation = useRef(0);
  const getSequence = useRef(0);
  const mutationEpoch = useRef(0);
  const evidenceCards = useRef(new Map<string, HTMLElement>());
  const priorAttachmentIds = useRef(new Set(attachments.map((a) => a.id)));
  const selectedResultRef = useRef(activeResult?.id);
  selectedResultRef.current = activeResult?.id;
  const results = guideResults(state, paperId);
  const data = activeResult?.guideData;
  const cleanText = (text: string) =>
    cleanGuideText(text, data?.evidence.map((e) => e.id) || []);
  const currentJob = jobs.find(activeStatus);
  const latestJob = currentJob || jobs[0];
  const running = Boolean(currentJob) || requestBusy;
  const candidates = useMemo(
    () => (paper ? relatedPapers(state, paper) : []),
    [state, paper],
  );
  const visibleCandidates = candidates.filter(({ paper: p }) =>
    `${p.title} ${p.authors.join(" ")} ${p.year || ""}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase()),
  );

  useEffect(() => {
    setSourceIds(attachments.map((a) => a.id));
    setOtherPaperIds([]);
    setRelatedOpen(false);
    setSearch("");
    setError("");
    failedRequest.current = null;
  }, [paperId]); // A new paper starts with all its PDF attachments selected.
  useEffect(() => {
    setSourceIds((previous) => {
      const available = new Set(attachments.map((a) => a.id));
      const newlyAdded = attachments
        .filter((a) => !priorAttachmentIds.current.has(a.id))
        .map((a) => a.id);
      priorAttachmentIds.current = available;
      return [...previous.filter((id) => available.has(id)), ...newlyAdded];
    });
  }, [attachments]);

  const loadJobs = useCallback(async () => {
    if (!paperId) return;
    const currentGeneration = generation.current;
    const requestSequence = ++getSequence.current;
    const currentMutationEpoch = mutationEpoch.current;
    const selectedResultBeforeRefresh = selectedResultRef.current;
    const response = await readResponse(
      await fetch(`/api/kb/guide?paperId=${encodeURIComponent(paperId)}`, {
        cache: "no-store",
      }),
    );
    if (
      currentGeneration !== generation.current ||
      requestSequence !== getSequence.current ||
      currentMutationEpoch !== mutationEpoch.current
    )
      return;
    const next: GuideJob[] = response.jobs || [];
    setJobs(next);
    let completedResult: string | null = null;
    let needsRefresh = false;
    for (const job of next) {
      if (activeStatus(job)) observedRunning.current.add(job.id);
      if (
        job.status === "completed" &&
        job.resultId &&
        !refreshed.current.has(job.resultId)
      ) {
        refreshed.current.add(job.resultId);
        needsRefresh = true;
        if (!completedResult && observedRunning.current.has(job.id))
          completedResult = job.resultId;
      }
    }
    if (needsRefresh) {
      await refresh();
      if (
        completedResult &&
        currentGeneration === generation.current &&
        currentMutationEpoch === mutationEpoch.current &&
        selectedResultBeforeRefresh === selectedResultRef.current
      )
        onResultChange(completedResult);
    }
  }, [paperId, refresh, onResultChange]);
  useEffect(() => {
    generation.current += 1;
    let live = true;
    setJobs([]);
    void loadJobs().catch((e) => {
      if (live) { failedRequest.current = null; setError(errorMessage(e)); }
    });
    return () => {
      live = false;
      generation.current += 1;
    };
  }, [loadJobs]);
  useEffect(() => {
    if (!currentJob) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await loadJobs();
      } catch (e) {
        if (live) { failedRequest.current = null; setError(errorMessage(e)); }
      }
      if (live) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 2500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [currentJob, loadJobs]);
  useEffect(() => {
    setMoreEvidenceOpen(false);
  }, [activeResult?.id]);
  useEffect(() => {
    if (!selectedEvidenceId) return;
    const card = evidenceCards.current.get(selectedEvidenceId);
    if (card?.closest("details[data-more-evidence]") && !moreEvidenceOpen) {
      setMoreEvidenceOpen(true);
    }
    const frame = requestAnimationFrame(() =>
      card?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [selectedEvidenceId, activeResult?.id, c.target]);


  const submit = async (body: object) => {
    const currentGeneration = generation.current;
    mutationEpoch.current += 1;
    getSequence.current += 1;
    setRequestBusy(true);
    setError("");
    try {
      const response = await readResponse(
        await fetch("/api/kb/guide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      const job = response.job as GuideJob;
      if (currentGeneration !== generation.current) return null;
      mutationEpoch.current += 1;
      getSequence.current += 1;
      if (activeStatus(job)) observedRunning.current.add(job.id);
      setJobs((previous) => [job, ...previous.filter((j) => j.id !== job.id)]);
      if (job.status === "completed" && job.resultId) {
        await refresh();
        if (currentGeneration === generation.current)
          onResultChange(job.resultId);
      }
      return job;
    } catch (e) {
      if (currentGeneration === generation.current) { failedRequest.current = body; setError(errorMessage(e)); }
      return null;
    } finally {
      if (currentGeneration === generation.current) setRequestBusy(false);
    }
  };
  const start = async (mode: "guide" | "comparison") => {
    if (archived) return;
    const paperIds = [paperId, ...(mode === "comparison" ? otherPaperIds : [])];
    const attachmentIds = [
      ...sourceIds,
      ...otherPaperIds.flatMap((id) =>
        mode === "comparison"
          ? availableAttachments(state, id).map((a) => a.id)
          : [],
      ),
    ];
    const job = await submit({
      action: "start",
      paperId,
      mode,
      attachmentIds,
      ...(mode === "comparison" ? { paperIds } : {}),
    });
    if (job) setRelatedOpen(false);
  };
  const selectEvidence = (evidence: GuideEvidence) => {
    if (
      evidenceCards.current
        .get(evidence.id)
        ?.closest("details[data-more-evidence]")
    )
      setMoreEvidenceOpen(true);
    if (evidence.matched) onMarksVisibleChange(true);
    void onSelectEvidence(evidence);
  };
  const evidenceById = new Map(data?.evidence.map((e) => [e.id, e]));
  const route = data
    ? [...new Set([...data.readingOrder, ...data.evidence.map((e) => e.id)])]
        .map((id) => evidenceById.get(id))
        .filter((e): e is GuideEvidence => Boolean(e))
    : [];
  const sourceOptions = (
    <details className={styles.sources}>
      <summary>
        阅读材料 · 已选 {sourceIds.length} / {attachments.length} 个 PDF
      </summary>
      <div className={styles.attachmentList}>
        {attachments.map((a) => (
          <label className={styles.checkRow} key={a.id}>
            <input
              type="checkbox"
              checked={sourceIds.includes(a.id)}
              disabled={running}
              onChange={(e) =>
                setSourceIds((values) =>
                  e.target.checked
                    ? [...values, a.id]
                    : values.filter((id) => id !== a.id),
                )
              }
            />
            <span>{a.filename}</span>
          </label>
        ))}
      </div>
      <p className={styles.subtle}>
        正文与 supplement
        可一起选择。仅分析这些附件，图像、公式及扫描页可能需要回看原文。
      </p>
    </details>
  );
  const evidenceLink = (id: string) => {
    const evidence = evidenceById.get(id);
    return evidence ? (
      <button
        className={styles.evidenceLink}
        key={id}
        title={evidence.quote}
        onClick={() => selectEvidence(evidence)}
      >
        第 {evidence.pageIndex + 1} 页 · {evidence.title}
      </button>
    ) : null;
  };

  const renderEvidenceCard = (evidence: GuideEvidence, index: number) => {
    if (!data) return null;
    const source = data.sources.find(
      (s) => s.attachmentId === evidence.attachmentId,
    );
    return (
      <article
        ref={(el) => {
          if (el) evidenceCards.current.set(evidence.id, el);
          else evidenceCards.current.delete(evidence.id);
        }}
        key={evidence.id}
        className={`${styles.evidence} ${selectedEvidenceId === evidence.id ? styles.evidenceActive : ""}`}
      >
        <button
          className={styles.evidenceTitle}
          onClick={() => selectEvidence(evidence)}
          title={`前往 ${source?.filename || "来源 PDF"} 第 ${evidence.pageIndex + 1} 页`}
        >
          <span className={styles.category}>
            {categoryNames[evidence.category]}
          </span>
          <strong>
            {index + 1}. {evidence.title}
          </strong>
          <small>p. {evidence.pageIndex + 1}</small>
          <ArrowUpRight size={12} />
        </button>
        <Markdown
          body={cleanText(evidence.explanation)}
          paperReferenceScope={{ paperId: evidence.paperId, attachmentId: evidence.attachmentId }}
          onNavigate={(href) => void navigateLink(href)}
          onFindPaper={(query) => c.openLiterature(query, { paperIds: [paperId] })}
        />
        <details open={selectedEvidenceId === evidence.id}>
          <summary>原文摘录</summary>
          <blockquote>{evidence.quote}</blockquote>
          <span className={styles.sourceName}>
            {data.mode === "comparison"
              ? `${source?.paperTitle || "关联论文"} · `
              : ""}
            {source?.filename || "来源 PDF"} · 物理页 {evidence.pageIndex + 1}
          </span>
        </details>
        {!evidence.matched && (
          <span className={styles.warning}>定位待确认 · 仅跳转来源页</span>
        )}
        <div className={styles.actions}>
          {onResearchItem && activeResult && <button type="button" className={styles.textButton} onClick={() => onResearchItem({ title: evidence.title,
            body: "这条导读证据是否支持我的研究判断？原文和 AI 解释仍需核对。", sources: [{ kind: "guideEvidence", id: activeResult.id, evidenceId: evidence.id }] })}>加入待核验</button>}
          {onDiscuss && activeResult && <button type="button" className={styles.textButton} disabled={!evidence.matched}
            title={evidence.matched ? "把这条原文证据交给想法工作区，检查后再发送" : "请先核对原文位置；尚未确认匹配的内容不会冒充原句传递"}
            onClick={() => onDiscuss({ title: evidence.title, sources: [{ type: "guideEvidence", id: activeResult.id, revision: 1, field: "quote", evidenceId: evidence.id }], prompt: `请基于我明确选中的导读原文证据，帮我推敲：${evidence.title}。先区分原文结论、假设与需要验证的推测。` })}>基于此证据继续推敲</button>}
        </div>
      </article>
    );
  };

  return (
    <section className={styles.panel} aria-label="AI 导读">
      <div className={styles.header}>
        <div>
          <div className={styles.heading}>
            <Sparkles size={19} />
            <h3>{data ? "导读报告" : "AI 导读"}</h3>
          </div>
        </div>
        {data && activeResult && (
          <div className={styles.actions}>
            <button className={styles.quiet} onClick={() => setDialog({ kind: "insert", text: `\n> ${activeResult.body.replace(/\n/g, "\n> ")}\n> — [AI 导读来源：${activeResult.model}](kb://ai/${activeResult.id})\n\n` })}>添加到笔记</button>
            <button type="button" disabled={archived} onClick={() => c.openLiterature("", { paperIds: [paperId] })}>查找文献</button>
            <ReadingTools label="版本与生成">
            <label>导读版本<select aria-label="选择导读版本" value={activeResult.id} onChange={(event) => onResultChange(event.target.value)}>
              {results.map((result) => <option key={result.id} value={result.id}>{result.kind === "comparison" ? "关联分析" : "论文导读"} · {new Date(result.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</option>)}
            </select></label>
            {sourceOptions}
            <button
              className={styles.quiet}
              disabled={archived || running || aiBusy}
              onClick={() => setRelatedOpen((value) => !value)}
            >
              <Link2 size={13} />
              关联分析
            </button>
            <button
              className={styles.quiet}
              disabled={archived || running || aiBusy || !sourceIds.length}
              onClick={() => void start("guide")}
              title="保留现有导读，生成一个新版本"
            >
              <RotateCcw size={12} />
              重新导读
            </button>
            </ReadingTools>
          </div>
        )}
      </div>

      {selection && (
        <div className={styles.selection}>
          <strong>解释选段 · 第 {selection.pageIndex + 1} 页</strong>
          <blockquote>{selection.selectedText}</blockquote>
          <div className={styles.selectionActions}>
            <button
              className={styles.primary}
              disabled={archived || aiBusy || running}
              onClick={() => void generateAI("explanation", selection)}
            >
              {aiBusy ? (
                <LoaderCircle size={13} className={styles.spin} />
              ) : (
                <Sparkles size={13} />
              )}
              解释这段内容
            </button>
            <button className={styles.textButton} disabled={archived || aiBusy || running}
              onClick={() => void generateAI("translation", selection)}>翻译</button>
            {aiBusy && c.aiTask?.paperId === paperId && <button className={styles.textButton}
              onClick={c.cancelAI}>停止生成</button>}
            <button
              className={styles.textButton}
              disabled={aiBusy}
              onClick={() => setSelection(null)}
            >
              收起
            </button>
          </div>
        </div>
      )}
      {(error || aiError) && (
        <div className={styles.error} role="alert">
          <p>{displayedError}</p>
          <strong>{recovery.title}</strong>
          <p>{recovery.hint}</p>
          {recovery.kind === "configuration" && <button className={styles.textButton} onClick={() => void chooseSection("settings")}>查看 AI 配置</button>}
          <button className={styles.textButton} disabled={archived || running || aiBusy} onClick={() => {
            if (error && failedRequest.current) void submit(failedRequest.current);
            else if (!error && c.aiTask?.status === "error" && c.aiTask.paperId === paperId) void generateAI(c.aiTask.kind, c.aiTask.selection);
            else { setError(""); void loadJobs().catch((e) => setError(errorMessage(e))); }
          }}>{error && !failedRequest.current ? "重新加载任务" : "重试本次请求"}</button>
        </div>
      )}
      {latestJob &&
        (activeStatus(latestJob) ||
          latestJob.status === "failed" ||
          latestJob.status === "cancelled") && (
          <div className={styles.progress} role="status" aria-live="polite">
            <div className={styles.progressTop}>
              {activeStatus(latestJob) ? (
                <LoaderCircle size={14} className={styles.spin} />
              ) : (
                <BookOpen size={14} />
              )}
              <strong>
                {activeStatus(latestJob)
                  ? latestJob.mode === "comparison"
                    ? "正在关联分析"
                    : "正在阅读论文"
                  : latestJob.status === "failed"
                    ? "导读暂未完成"
                    : "导读已停止"}
              </strong>
              {activeStatus(latestJob) ? (
                <button
                  className={styles.textButton}
                  disabled={requestBusy}
                  onClick={() =>
                    void submit({ action: "cancel", jobId: latestJob.id })
                  }
                >
                  停止
                </button>
              ) : (
                <button
                  className={styles.textButton}
                  disabled={archived || requestBusy}
                  onClick={() =>
                    void submit({ action: "resume", jobId: latestJob.id })
                  }
                >
                  <RotateCcw size={12} />
                  继续 / 重试
                </button>
              )}
            </div>
            {activeStatus(latestJob) && (
              <progress
                aria-label="导读进度"
                value={latestJob.completedChunks}
                max={Math.max(1, latestJob.totalChunks)}
              />
            )}
            <p>
              {latestJob.error || latestJob.message || "正在准备原文"}
              {latestJob.totalChunks
                ? ` · ${latestJob.completedChunks} / ${latestJob.totalChunks} 段`
                : ""}
            </p>
            {latestJob.status === "failed" && latestJob.error && <p>{aiErrorRecovery(latestJob.error).hint}
              {aiErrorRecovery(latestJob.error).kind === "configuration" && <button className={styles.textButton} onClick={() => void chooseSection("settings")}>查看 AI 配置</button>}
            </p>}
            <p>可以继续阅读或离开本页；已保存的导读与个人笔记保持独立。</p>
          </div>
        )}

      {!data && (
        <div className={styles.empty}>
          <h4>生成这篇论文的导读</h4>
          <p>选择 PDF，生成报告并回到原页核对证据。</p>
          {sourceOptions}
          {attachments.length ? (
            <button
              className={styles.primary}
              disabled={archived || running || !sourceIds.length || aiBusy}
              onClick={() => void start("guide")}
            >
              {running ? (
                <LoaderCircle size={14} className={styles.spin} />
              ) : (
                <Sparkles size={14} />
              )}
              开始 AI 导读
            </button>
          ) : (
            <p>先为这篇文献添加 PDF，再开始导读。</p>
          )}
          <p className={styles.subtle}>
            主动点击后才调用已配置的模型。结果本地保存，AI 标记可随时隐藏。
          </p>
        </div>
      )}

      {relatedOpen && (
        <div className={styles.related}>
          <div className={styles.sectionTitle}>
            <h4>与哪些文献一起读？</h4>
            <TooltipButton
              className={styles.textButton}
              aria-label="关闭关联选择"
              onClick={() => setRelatedOpen(false)}
            >
              <X size={14} />
            </TooltipButton>
          </div>
          <p>
            当前论文已包含。再选 1–2
            篇，比较问题、假设、方法与证据；候选按已有关系排序。
          </p>
          <input
            type="search"
            aria-label="搜索关联文献"
            placeholder="搜索本地论文…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className={styles.candidates}>
            {visibleCandidates.map(({ paper: p, reason }) => {
              const files = availableAttachments(state, p.id);
              return (
                <label className={styles.candidate} key={p.id}>
                  <input
                    type="checkbox"
                    checked={otherPaperIds.includes(p.id)}
                    disabled={
                      running ||
                      (!otherPaperIds.includes(p.id) &&
                        otherPaperIds.length >= 2)
                    }
                    onChange={(e) =>
                      setOtherPaperIds((values) =>
                        e.target.checked
                          ? [...values, p.id]
                          : values.filter((id) => id !== p.id),
                      )
                    }
                  />
                  <span>
                    <strong>{p.title}</strong>
                    <small>
                      {p.year || "年份未记录"} · {reason} · 将读取{" "}
                      {files.length} 个 PDF：
                      {files.map((a) => a.filename).join("、")}
                    </small>
                  </span>
                </label>
              );
            })}
            {!visibleCandidates.length && (
              <p className={styles.subtle}>
                没有匹配且包含本地 PDF 的其他论文。
              </p>
            )}
          </div>
          <button
            className={styles.primary}
            disabled={
              archived ||
              running ||
              aiBusy ||
              !sourceIds.length ||
              !otherPaperIds.length
            }
            onClick={() => void start("comparison")}
          >
            <Link2 size={13} />
            开始关联分析 · {1 + otherPaperIds.length} 篇
          </button>
        </div>
      )}

      {data && activeResult && (
        <>
          <div className={styles.meta}>
            {data.mode === "comparison" && (
              <span className={styles.comparisonLabel}>
                关联分析 · {data.paperIds.length} 篇
              </span>
            )}
            <button
              className={styles.marksToggle}
              aria-pressed={marksVisible}
              onClick={() => onMarksVisibleChange(!marksVisible)}
            >
              {marksVisible ? <Eye size={12} /> : <EyeOff size={12} />}AI 标记
              {marksVisible ? "已显示" : "已隐藏"}
            </button>
          </div>
          <div className={styles.overview}>
            <h4>
              {data.mode === "comparison"
                ? "这些论文如何放在一起理解"
                : "这篇论文在做什么"}
            </h4>
            <Markdown
              body={cleanText(data.overview)}
              paperReferenceScope={data.mode === "guide" && data.sources.length === 1 ? { paperId, attachmentId: data.sources[0]?.attachmentId } : undefined}
              onNavigate={(href) => void navigateLink(href)}
          onFindPaper={(query) => c.openLiterature(query, { paperIds: [paperId] })}
            />
          </div>
          {route.length > 0 && (
            <>
              <div className={styles.sectionTitle}>
                <h4>沿着重点读原文</h4>
                <span>共 {route.length} 处重点</span>
              </div>
              <div className={styles.evidenceList}>
                {route.slice(0, 12).map(renderEvidenceCard)}
              </div>
              {route.length > 12 && (
                <details
                  className={styles.moreEvidence}
                  data-more-evidence
                  open={moreEvidenceOpen}
                  onToggle={(e) => setMoreEvidenceOpen(e.currentTarget.open)}
                >
                  <summary>
                    <ChevronRight size={13} />
                    更多原文要点 · {route.length - 12} 处
                  </summary>
                  <div className={styles.evidenceList}>
                    {route
                      .slice(12)
                      .map((evidence, index) =>
                        renderEvidenceCard(evidence, index + 12),
                      )}
                  </div>
                </details>
              )}
            </>
          )}
          <div className={styles.sectionTitle}>
            <h4>深入理解</h4>
            <span>按需展开</span>
          </div>
          {data.sections.map((section, index) => (
            <details className={styles.section} key={`${section.key}-${index}`}>
              <summary>
                <ChevronRight size={13} />
                {section.title}
              </summary>
              <div className={styles.sectionBody}>
                <div className={styles.claim}>
                  <span className={styles.origin}>
                    {basisNames[section.basis]}
                  </span>
                  <Markdown
                    body={cleanText(section.body)}
                    paperReferenceScope={data.mode === "guide" && data.sources.length === 1 ? { paperId, attachmentId: data.sources[0]?.attachmentId } : undefined}
                    onNavigate={(href) => void navigateLink(href)}
          onFindPaper={(query) => c.openLiterature(query, { paperIds: [paperId] })}
                  />
                  <div className={styles.evidenceLinks}>
                    {section.evidenceIds.map(evidenceLink)}
                  </div>
                </div>
              </div>
            </details>
          ))}
          {data.questions.length > 0 && (
            <details className={styles.section}>
              <summary>
                <ChevronRight size={13} />
                接下来值得追问什么
              </summary>
              <div className={styles.sectionBody}>
                {data.questions.map((question, index) => (
                  <div className={styles.claim} key={index}>
                    <Markdown
                      body={`${index + 1}. ${cleanText(question)}`}
                      paperReferenceScope={data.mode === "guide" && data.sources.length === 1 ? { paperId, attachmentId: data.sources[0]?.attachmentId } : undefined}
                      onNavigate={(href) => void navigateLink(href)}
          onFindPaper={(query) => c.openLiterature(query, { paperIds: [paperId] })}
                    />
                    <div className={styles.actions}>
                      {onResearchItem && <button type="button" className={styles.textButton} onClick={() => onResearchItem({ title: cleanText(question).slice(0, 1000),
                        body: "这是 AI 导读提出的待探索问题，尚未验证。", sources: [{ kind: "guideQuestion", id: activeResult.id, questionIndex: index }] })}>加入待核验</button>}
                      {onDiscuss && <button type="button" className={styles.textButton} onClick={() => onDiscuss({ sources: [], title: cleanText(question).slice(0, 300),
                        prompt: `待核验的研究问题（来自 AI 导读建议，不是论文原句）：${cleanText(question)}\n\n请帮我澄清假设和最小验证步骤，不把建议当作已证实结论。` })}>继续推敲这个问题</button>}
                    </div>
                  </div>
                ))}
                <p className={styles.subtle}>
                  这些是探索建议，需要进一步论证或实验。
                </p>
              </div>
            </details>
          )}
          <details className={styles.coverage}>
            <summary>阅读范围与生成信息</summary>
            {data.sources.map((source) => (
              <div key={source.attachmentId}>
                <p>
                  <strong>{source.filename}</strong>
                  <br />
                  {source.parsedPages.length} / {source.pageCount} 页提取到文字
                  · {source.characterCount.toLocaleString()} 字符
                  {source.emptyPages.length
                    ? ` · ${source.emptyPages.length} 页未提取到文字`
                    : ""}
                </p>
                {source.emptyPages.length > 0 && (
                  <p>
                    未提取页：{source.emptyPages.map((p) => p + 1).join("、")}
                  </p>
                )}
              </div>
            ))}
            {data.warnings.length > 0 && (
              <ul>
                {data.warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            )}
            <p>
              {activeResult.provider} · {activeResult.model}
              <br />
              {new Date(activeResult.createdAt).toLocaleString("zh-CN")}
              <br />
              原文匹配仅核对文本位置，不代表 AI 的解释已通过学术核验。
            </p>
          </details>
        </>
      )}

      <PaperAIHistory c={c} running={running} hasGuide={Boolean(data)} onRelated={() => setRelatedOpen((v) => !v)} />
    </section>
  );
}
