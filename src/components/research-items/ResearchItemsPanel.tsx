"use client";
import { useEffect, useState } from "react";
import type { KBState } from "../../lib/types";
import type { ResearchItem } from "../../lib/research-items/types";
import { researchStatusLabels, saveResearchItem } from "../../lib/research-items/client";
import Markdown from "../Markdown";
import ResearchItemDialog from "./ResearchItemDialog";
import ResearchSourcePreview from "./ResearchSourcePreview";
import styles from "./ResearchItems.module.css";

export default function ResearchItemsPanel({ state, topicId, onChanged, onNavigate, onDiscuss, onWriteToNote, onOpenExternal, focusItemId }: {
  state: KBState; topicId: string; onChanged: () => void | Promise<void>; onNavigate: (href: string) => void;
  onDiscuss: (item: ResearchItem) => void; onWriteToNote: (item: ResearchItem) => void; onOpenExternal?: (id: string) => void; focusItemId?: string;
}) {
  const [editing, setEditing] = useState<ResearchItem | "new" | null>(null), [filter, setFilter] = useState("active"), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const items = ((state as KBState & { researchItems?: ResearchItem[] }).researchItems ?? []).filter(item => item.topicId === topicId);
  const [highlight, setHighlight] = useState("");
  const focused = items.find(item => item.id === focusItemId);
  useEffect(() => {
    if (!focusItemId || !focused) return;
    setFilter(focused.archivedAt ? "archived" : "active"); setHighlight(focusItemId);
    const frame = requestAnimationFrame(() => { const element = document.getElementById(`research-item-${focusItemId}`); element?.scrollIntoView({ block: "nearest" }); element?.focus({ preventScroll: true }); });
    const timer = window.setTimeout(() => setHighlight(""), 3500);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [focusItemId, topicId, focused?.archivedAt]);
  const visible = items.filter(item => filter === "archived" ? Boolean(item.archivedAt) : !item.archivedAt && (filter === "active" || item.status === filter));
  const archive = async (item: ResearchItem) => { setBusy(item.id); setError(""); try { await saveResearchItem({ action: item.archivedAt ? "restore" : "archive", id: item.id, revision: item.revision }); await onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : "更新失败，请刷新后重试。"); } finally { setBusy(""); } };
  return <section className={styles.panel} aria-label="待核验清单">
    <header><h3>待核验清单 <span>{items.filter(item => !item.archivedAt).length}</span></h3><button type="button" onClick={() => setEditing("new")}>新建待核验</button></header>
    <div className={styles.filters}><select aria-label="筛选待核验条目" value={filter} onChange={event => setFilter(event.target.value)}><option value="active">全部未归档</option>{Object.entries(researchStatusLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}<option value="archived">已归档</option></select></div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {!visible.length && <p className={styles.hint}>{filter === "archived" ? "没有已归档条目。" : "把尚未确认的问题记在这里，连同依据和下一步一起保留。"}</p>}
    {visible.map(item => <article key={item.id} id={`research-item-${item.id}`} tabIndex={-1} className={`${styles.item} ${highlight === item.id ? styles.highlight : ""}`}>
      <div className={styles.itemHeading}><h4>{item.title}</h4><span>{researchStatusLabels[item.status]}{item.archivedAt ? " · 已归档" : ""}</span></div>
      {item.body && <Markdown body={item.body} onNavigate={onNavigate} />}
      {item.nextAction && <p><strong>下一步：</strong>{item.nextAction}</p>}
      {item.resolution && <p><strong>我的判断：</strong>{item.resolution}</p>}
      <ResearchSourcePreview sources={item.sourceRefs} onNavigate={onNavigate} onOpenExternal={onOpenExternal} />
      {item.resultRefs.length > 0 && <details><summary>用户选择的结果来源 · {item.resultRefs.length}</summary><ResearchSourcePreview sources={item.resultRefs} onNavigate={onNavigate} onOpenExternal={onOpenExternal} /></details>}
      <div className={styles.itemActions}>{item.archivedAt ? <button type="button" disabled={Boolean(busy)} onClick={() => void archive(item)}>恢复条目</button> : <>
        <button type="button" onClick={() => onDiscuss(item)}>继续推敲</button><button type="button" onClick={() => onWriteToNote(item)}>写回综合笔记</button><button type="button" onClick={() => setEditing(item)}>编辑 / 核验</button>
        <button type="button" disabled={Boolean(busy)} onClick={() => void archive(item)}>{busy === item.id ? "处理中…" : "归档"}</button></>}</div>
    </article>)}
    {editing && <ResearchItemDialog key={editing === "new" ? "new" : editing.id} state={state} initial={{ topicId }} item={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={onChanged} />}
  </section>;
}
