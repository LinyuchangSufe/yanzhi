"use client";
import type { ResearchItemSource } from "../../lib/research-items/types";
import styles from "./ResearchItems.module.css";
export default function ResearchSourcePreview({ sources, onNavigate, onOpenExternal }: {
  sources: ResearchItemSource[]; onNavigate?: (href: string) => void; onOpenExternal?: (id: string) => void;
}) {
  return <div className={styles.sourcePreviews}>{sources.map(source => <details key={source.id}>
    <summary>{source.title}{source.origin === "ai" ? " · AI 内容，待核验" : source.origin === "external" ? " · 导入讨论，待核验" : ""}</summary>
    <blockquote>{source.text}</blockquote>
    {source.pageIndex !== undefined && <p>物理第 {source.pageIndex + 1} 页{source.pageLabel && source.pageLabel !== String(source.pageIndex + 1) ? ` · 原页码 ${source.pageLabel}` : ""}</p>}
    <small>保存的引用快照{"revision" in source.input ? ` · 引用修订 ${source.input.revision}` : ""} · {new Date(source.capturedAt).toLocaleString("zh-CN")}</small>
    {source.input.kind === "externalDiscussion" ? onOpenExternal && <button type="button" onClick={() => { if (source.input.kind === "externalDiscussion") onOpenExternal(source.input.id); }}>查看导入快照</button>
      : onNavigate && <button type="button" onClick={() => onNavigate(source.sourceHref)}>查看来源</button>}
  </details>)}</div>;
}
