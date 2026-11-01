"use client";

import { ChevronDown, ExternalLink, FileText, X } from "lucide-react";
import type { ChatContext } from "../lib/paper-chat/types";
import Markdown from "./Markdown";
import TooltipButton from "./TooltipButton";
import styles from "./ChatContextReferences.module.css";

export const contextPurposeLabel = { paper: "论文笔记", topic: "研究问题", idea: "想法" } as const;

export function ChatContextReferences({ contexts, onNavigate, onRemove }: {
  contexts: readonly ChatContext[];
  onNavigate?: (href: string) => void;
  onRemove?: (index: number) => void;
}) {
  if (!contexts.length) return null;
  return <details className={styles.references} aria-label={onRemove ? "待发送参考资料" : "已引用参考资料"}>
    <summary className={styles.heading}>参考资料 <span>{contexts.length} 项</span><ChevronDown className={styles.groupChevron} size={14} aria-hidden="true" /></summary>
    <div className={styles.items}>
    {contexts.map((context, index) => <div className={styles.row} key={`${context.noteId}:${context.field || "body"}:${context.start}:${context.end}:${index}`}>
      <details className={styles.reference}>
        <summary>
          <FileText size={13} aria-hidden="true" />
          <span className={styles.title}>{context.title || "未命名"}</span>
          <span className={styles.kind}>{context.field === "description" ? "问题描述" : contextPurposeLabel[context.purpose]} · {context.mode === "full" ? "完整内容" : "片段"}</span>
          <ChevronDown className={styles.chevron} size={13} aria-hidden="true" />
        </summary>
        <div className={styles.detail}>
          <div className={styles.meta}>
            <span>已选文字快照 · 修订 {context.revision} · {context.text.length.toLocaleString()} 字符{context.mode === "excerpt" ? ` · 原文位置 ${context.start}–${context.end}` : ""}</span>
            {onNavigate && <button type="button" onClick={() => onNavigate(context.sourceHref)}><ExternalLink size={12} aria-hidden="true" />打开来源</button>}
          </div>
          <div className={styles.body}><Markdown body={context.text} onNavigate={onNavigate} /></div>
        </div>
      </details>
      {onRemove && <TooltipButton type="button" className={styles.remove} aria-label={`移除参考资料：${context.title || "未命名"}`} onClick={() => onRemove(index)}><X size={15} aria-hidden="true" /></TooltipButton>}
    </div>)}
    </div>
  </details>;
}
