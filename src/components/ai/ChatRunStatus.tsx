"use client";
import { useEffect, useState } from "react";
import type { ChatProgress } from "../../lib/ai/chat-progress";
import styles from "./ChatRunStatus.module.css";

export interface ChatRunStatusProps {
  progress?: ChatProgress | null;
  startedAt: string;
  active?: boolean;
  finishedAt?: string;
  label?: string;
  compact?: boolean;
}

function timestamp(value: string | number | Date): number | null {
  const parsed = typeof value === "number" ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A duration, in m:ss, without wrapping minutes after an hour. */
export function formatChatRunElapsed(startedAt: string, now: string | number | Date): string {
  const start = timestamp(startedAt), end = timestamp(now);
  const seconds = start === null || end === null ? 0 : Math.max(0, Math.floor((end - start) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const phases: Record<ChatProgress["phase"], { title: string; description: string }> = {
  starting: { title: "准备请求", description: "正在准备本次请求。" },
  connecting: { title: "正在连接", description: "正在建立模型连接。" },
  waiting: { title: "等待回复", description: "请求仍在等待模型回复。" },
  thinking: { title: "模型思考阶段", description: "最近一次已收到模型发出的思考阶段信号。" },
  responding: { title: "正在接收回复", description: "已收到回复正文，正在接收后续输出。" },
  retrying: { title: "正在重试", description: "请求正在重试，等待连接或回复。" },
};

function since(value: string | null | undefined, now: number, missing: string): string {
  const time = value ? timestamp(value) : null;
  if (time === null) return missing;
  return now - time < 1000 ? "刚刚" : `${formatChatRunElapsed(value!, now)} 前`;
}

export default function ChatRunStatus({ progress, startedAt, active = true, finishedAt, label = "AI", compact = false }: ChatRunStatusProps) {
  // The first client render matches the server. Browser time starts after hydration.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);
  const end = !active && finishedAt ? timestamp(finishedAt) : null;
  const currentTime = end ?? now ?? timestamp(startedAt) ?? 0;
  const phase = progress?.phase ?? "waiting";
  const elapsed = formatChatRunElapsed(startedAt, currentTime);
  const elapsedLabel = active ? ["starting", "connecting", "waiting"].includes(phase) ? "已等待" : "已运行" : "用时";
  const description = active ? progress ? phases[phase].description : "等待回复，尚未收到服务端进度信号。"
    : "本次请求已结束，可查看回复或错误提示。";
  const lastActivity = progress?.lastActivityAt ?? null;
  const activityDescription = `最近真实活动：${since(lastActivity, currentTime, "尚未收到模型或连接协议的活动信号")}。`;
  const heartbeatDescription = `最近服务端心跳：${since(progress?.heartbeatAt, currentTime, "尚未收到")}。心跳只说明服务端在该时刻有响应，不代表模型正在推理。`;
  const processDescription = !active ? "本次请求已结束。" : progress?.processRunning === true ? "最近进程状态：存活，不代表模型正在推理。"
    : progress?.processRunning === false ? "最近进程状态：未在运行，结果以回复或错误提示为准。" : "最近进程状态：未提供。";
  const activityTime = lastActivity ? timestamp(lastActivity) : null;
  const waitStart = activityTime ?? timestamp(startedAt) ?? currentTime;
  const stalled = active && currentTime - waitStart > 30000;
  const heartbeatTime = progress?.heartbeatAt ? timestamp(progress.heartbeatAt) : null;
  const statusStale = active && heartbeatTime !== null && currentTime - heartbeatTime > 30000;
  const stage = !active ? "已结束" : statusStale ? "等待状态更新" : stalled && phase === "responding" ? "等待后续回复" : phases[phase].title;
  const waitingDescription = stalled ? `已有 ${formatChatRunElapsed(lastActivity ?? startedAt, currentTime)} 没有新的模型或协议活动，仍在等待。你可以停止本次请求。` : "";
  const title = [`${label} · ${stage} · ${elapsedLabel} ${elapsed}`, description, activityDescription, heartbeatDescription, processDescription, waitingDescription].filter(Boolean).join("\n");
  const headline = <><span className={styles.phase}>{label} · {stage}</span><span className={styles.elapsed}>{elapsedLabel} {elapsed}</span></>;
  if (compact) return <span className={styles.compact} title={title}>{headline}</span>;
  return <div className={styles.status} title={`${label} · ${stage}`}>
    <div className={styles.headline}>{headline}</div>
    {stalled && <p className={styles.waiting}>{waitingDescription}</p>}
    <details className={styles.details}><summary>运行详情</summary>
      <p>{description}</p><p>{activityDescription}</p><p>{heartbeatDescription}</p><p>{processDescription}</p>
    </details>
  </div>;
}
