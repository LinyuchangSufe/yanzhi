"use client";

import {
  ChevronDown,
  ChevronUp,
  Languages,
  LoaderCircle,
  MapPin,
  NotebookPen,
  RotateCcw,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { PaperAITask } from "../lib/paper-ai-task";
import type { AIContent } from "../lib/types";
import Markdown from "./Markdown";
import MarkdownTransfer from "./MarkdownTransfer";
import TooltipButton from "./TooltipButton";
import ReadingTools from "./editor/ReadingTools";
import styles from "./styles/SelectionAssistant.module.css";

interface Props {
  task: PaperAITask;
  result?: AIContent;
  collapsed: boolean;
  onCollapse: (value: boolean) => void;
  onClose: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onNavigate: (href: string) => void;
  onInsert: (body?: string) => void;
  onLocate: () => void;
}

function scopeLabel(result: AIContent) {
  const pages = [...new Set(result.sourcePageIndices)]
    .sort((left, right) => left - right)
    .map((page) => page + 1);
  const pageLabel = pages.length ? ` · 物理页 ${pages.join("、")}` : "";
  switch (result.sourceScope) {
    case "page_image":
      return `当前页图像识别${pageLabel}`;
    case "selection_image":
      return `选区图像识别${pageLabel}`;
    case "selection_context":
      return pages.length ? `选段、论文背景${pageLabel}` : "选段与论文标题/摘要（未读 PDF 正文）";
    case "selection":
      return `所选原文${pageLabel}`;
    case "abstract":
      return "论文摘要";
    case "partial_text":
      return `部分论文文本${pageLabel}`;
    case "full_text":
      return `论文文本${pageLabel}`;
  }
}

/** A nonmodal reading aid: its scroll and focus stay independent of the PDF. */
export default function SelectionAssistant({
  task,
  result,
  collapsed,
  onCollapse,
  onClose,
  onCancel,
  onRetry,
  onNavigate,
  onInsert,
  onLocate,
}: Props) {
  const running = task.status === "running";
  const title = task.kind === "markdown" ? "Markdown + LaTeX" : task.kind === "translation" ? "选段翻译" : task.kind === "summary" ? "论文短摘要" : "结合论文分析";
  const stateLabel = running
    ? "正在生成"
    : task.status === "error"
      ? "生成未完成"
      : task.status === "cancelled"
        ? "已停止生成"
        : "结果已保存";

  return (
    <section
      className={`${styles.panel} ${collapsed ? styles.collapsed : ""}`}
      aria-label={title}
      data-selection-assistant
    >
      <header className={styles.header}>
        {running ? (
          <LoaderCircle size={15} className={styles.spin} aria-hidden="true" />
        ) : task.kind === "translation" ? (
          <Languages size={15} aria-hidden="true" />
        ) : (
          <Sparkles size={15} aria-hidden="true" />
        )}
        <div
          className={styles.headingButton}
        >
          <strong>{title}</strong>
          <span>{stateLabel}</span>
        </div>
        {running && (
          <button type="button" className={styles.stop} onClick={onCancel}>
            <Square size={10} aria-hidden="true" />停止
          </button>
        )}
        <TooltipButton
          type="button"
          className={styles.iconButton}
          aria-label={collapsed ? "展开选段结果" : "收起选段结果"}
          aria-expanded={!collapsed}
          title={collapsed ? "展开选段结果" : "收起选段结果，继续阅读"}
          onClick={() => onCollapse(!collapsed)}
        >
          {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </TooltipButton>
        {!running && (
          <TooltipButton
            type="button"
            className={styles.iconButton}
            aria-label="关闭选段结果"
            title="关闭选段结果"
            onClick={onClose}
          >
            <X size={15} />
          </TooltipButton>
        )}
      </header>

        <div className={styles.content} hidden={collapsed}>
          {task.selection?.selectedText && (
            <details className={styles.original}>
              <summary>所选原文 · 物理页 {task.selection.pageIndex + 1}</summary>
              <blockquote>{task.selection.selectedText}</blockquote>
            </details>
          )}
          {task.status !== "done" && <div className={styles.status} role="status" aria-live="polite">
            {running
              ? "正在生成，可以继续阅读或切换页面；收起面板不会终止。"
              : task.status === "cancelled"
                ? "本次生成已停止。已有结果与个人笔记均保留。"
                : "本次生成未完成，可以重试。"}
          </div>}
          {task.status === "error" && task.error && (
            <p className={styles.error} role="alert">{task.error}</p>
          )}
          {task.kind === "markdown" && !result && <p className={styles.recognitionHint}>
            正在按 PDF 图像重建 Markdown 与 LaTeX，需要所选模型支持图像输入。完成后可核对、修改和复制源码。
          </p>}
          {result && (
            <>
              {task.status !== "done" && (
                <p className={styles.savedLabel}>已有结果</p>
              )}
              {result.kind === "markdown" ? <MarkdownTransfer key={result.id} body={result.body}
                onNavigate={onNavigate} onInsert={onInsert} /> : <div className={styles.answer}>
                <Markdown body={result.body} onNavigate={onNavigate}
                  paperReferenceScope={{ paperId: task.paperId, attachmentId: result.sourceAttachmentId || task.selection?.attachmentId }} />
              </div>}
              <details className={styles.sources}>
                <summary>实际读取范围：{scopeLabel(result)}</summary>
                <p className={styles.sourceMeta}>
                  {result.provider} · {result.model}
                  <br />
                  {new Date(result.createdAt).toLocaleString("zh-CN")}
                </p>
                {result.sourceText && <pre>{result.sourceText}</pre>}
              </details>
            </>
          )}
          <footer className={styles.actions}>
            {result && result.kind !== "markdown" && (
              <button type="button" className={styles.primary} onClick={() => onInsert()}>
                <NotebookPen size={15} aria-hidden="true" />添加到笔记
              </button>
            )}
            {task.selection && (
              <button type="button" onClick={onLocate}>
                <MapPin size={13} aria-hidden="true" />定位选段
              </button>
            )}
            {!running && task.status !== "done" && (task.kind === "summary" || task.selection) && (
              <button type="button" onClick={onRetry}>
                <RotateCcw size={12} aria-hidden="true" />
                重试
              </button>
            )}
            {task.status === "done" && (task.kind === "summary" || task.selection) && <ReadingTools label="更多" upward>
              <button type="button" onClick={onRetry}><RotateCcw size={14} />重新生成</button>
            </ReadingTools>}
          </footer>
        </div>
    </section>
  );
}
