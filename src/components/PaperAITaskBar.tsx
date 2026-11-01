"use client";

import { Check, CircleAlert, LoaderCircle, Square, X } from "lucide-react";
import type { PaperAITask } from "../lib/paper-ai-task";
import styles from "./styles/SelectionAssistant.module.css";

interface Props {
  task: PaperAITask;
  onCancel: () => void;
  onOpen: () => void;
  onDismiss: () => void;
}

/** Keep an AI task reachable while the reader browses other library pages. */
export default function PaperAITaskBar({ task, onCancel, onOpen, onDismiss }: Props) {
  const running = task.status === "running";
  const title = task.kind === "markdown" ? "Markdown + LaTeX 识别" : task.kind === "translation"
    ? "选段翻译"
    : task.kind === "explanation"
      ? "选段分析"
      : "论文短摘要";
  const status = running
    ? "正在生成，可继续浏览"
    : task.status === "done"
      ? "结果已保存"
      : task.status === "cancelled"
        ? "已停止生成"
        : "生成未完成";
  return (
    <aside className={styles.taskBar} aria-label="AI 任务">
      {running ? (
        <LoaderCircle size={16} className={styles.spin} aria-hidden="true" />
      ) : task.status === "error" ? (
        <CircleAlert size={16} aria-hidden="true" />
      ) : task.status === "done" ? (
        <Check size={16} aria-hidden="true" />
      ) : (
        <Square size={13} aria-hidden="true" />
      )}
      <div className={styles.taskInfo}>
        <strong>{title} · <span role="status" aria-live="polite">{status}</span></strong>
        <span className={styles.paperTitle} title={task.paperTitle}>{task.paperTitle}</span>
      </div>
      {running && (
        <button type="button" className={styles.stop} onClick={onCancel}>停止</button>
      )}
      <button type="button" className={styles.taskOpen} onClick={onOpen}>
        {task.status === "done" ? "查看结果" : "查看任务"}
      </button>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={running ? "隐藏任务提示，继续生成" : "关闭 AI 任务提示"}
        title={running ? "隐藏提示后继续生成" : "关闭提示"}
        onClick={onDismiss}
      ><X size={14} /></button>
    </aside>
  );
}
