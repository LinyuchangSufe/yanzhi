"use client";
import { useState } from "react";
import type { KBState } from "../../lib/types";
import type { ExternalDiscussion, ExternalDiscussionContext } from "../../lib/codex-import/types";
import { errorMessage, readResponse } from "../WorkspaceShared";
import CodexImportPicker from "./CodexImportPicker";
import ExternalDiscussionView from "./ExternalDiscussionView";
import styles from "./CodexImport.module.css";
export { default as CodexImportPicker } from "./CodexImportPicker";
export { default as ExternalDiscussionView } from "./ExternalDiscussionView";
export default function CodexImportPanel({ context = {}, discussions, onChanged, onDiscuss, onFindPaper, title = "外部讨论资料" }: { context?: Partial<ExternalDiscussionContext>; discussions: ExternalDiscussion[]; onChanged: (state: KBState) => void | Promise<void>; onDiscuss?: (discussion: ExternalDiscussion) => void; onFindPaper?: (query: string | undefined, discussion: ExternalDiscussion) => void; title?: string }) {
  const [open, setOpen] = useState(false), [activeId, setActiveId] = useState<string | null>(null), [unlinking, setUnlinking] = useState(false), [error, setError] = useState("");
  const scoped = discussions.filter((discussion) => !(context.paperIds?.length || context.topicIds?.length || context.noteIds?.length) || context.paperIds?.some((id) => discussion.paperIds.includes(id)) || context.topicIds?.some((id) => discussion.topicIds.includes(id)) || context.noteIds?.some((id) => discussion.noteIds.includes(id)));
  const active = scoped.find((discussion) => discussion.id === activeId);
  const hasContext = Boolean(context.paperIds?.length || context.topicIds?.length || context.noteIds?.length);
  const unlink = async () => {
    if (!active || unlinking) return; setUnlinking(true); setError("");
    try { const result = await readResponse(await fetch("/api/kb/codex-history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "link", id: active.id, revision: active.revision,
      context: { paperIds: active.paperIds.filter((id) => !context.paperIds?.includes(id)), topicIds: active.topicIds.filter((id) => !context.topicIds?.includes(id)), noteIds: active.noteIds.filter((id) => !context.noteIds?.includes(id)) } }) })) as { state: KBState };
      await onChanged(result.state); setActiveId(null);
    } catch (failure) { setError(errorMessage(failure)); } finally { setUnlinking(false); }
  };
  return <section className={styles.panel} aria-label={title}><div className={styles.panelHeading}><h3>{title}{scoped.length > 0 && <span>{scoped.length}</span>}</h3><button type="button" onClick={() => setOpen(true)}>从 Codex 导入</button></div>
    {active ? <ExternalDiscussionView key={active.id} discussion={active} onChanged={onChanged} onDiscuss={onDiscuss} onFindPaper={onFindPaper ? (query) => onFindPaper(query, active) : undefined} onClose={() => setActiveId(null)} /> : <>{scoped.length ? <div className={styles.savedList}>{scoped.map((discussion) => <button type="button" key={discussion.id} onClick={() => setActiveId(discussion.id)}><strong>{discussion.title}</strong><span>所选 {discussion.selectedTurnIds.length} 轮 · {discussion.messages.length} 条消息 · 只读资料</span></button>)}</div> : <p className={styles.muted}>可将已有 Codex 讨论中的轮次带入研究，保留原始来源。</p>}</>}
    {active && hasContext && <details className={styles.diagnostics}><summary>资料关联</summary><p>解除后只从当前材料中移出，已导入的讨论与历史版本仍保留，可从搜索打开。</p><button type="button" disabled={unlinking} onClick={() => void unlink()}>{unlinking ? "正在解除…" : "解除当前材料关联"}</button></details>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {open && <CodexImportPicker context={context} onImported={async (discussion, state) => { await onChanged(state); setActiveId(discussion.id); }} onClose={() => setOpen(false)} />}
  </section>;
}
