"use client";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { IdeaSummary as Summary } from "../../lib/idea-lab/types";
import { ideaSourceScope } from "../../lib/idea-lab/source-details";
import type { Note } from "../../lib/types";
import type { WorkspaceController } from "../Workspace";
import { linked } from "../WorkspaceShared";
import Markdown from "../Markdown";
import TooltipButton from "../TooltipButton";
import styles from "./IdeaWorkspace.module.css";

export default function IdeaSummary({ summary, note, c, onClose, onApplied }: {
  summary: Summary; note: Note; c: WorkspaceController; onClose: () => void; onApplied: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropDown = useRef(false);
  const [selected, setSelected] = useState(summary.sections.map((section) => section.id));
  const [selectingSections, setSelectingSections] = useState(false);
  const [kind, setKind] = useState<"current" | "new" | "topic">("current");
  const topics = c.state.topics.filter((topic) => linked(c.state, "note", note.id, "topic", topic.id));
  const [topicId, setTopicId] = useState(topics[0]?.id ?? "");
  const [title, setTitle] = useState(`${note.title} · 阶段笔记`);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [resultId, setResultId] = useState("");
  const request = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const target = kind === "current" ? note : kind === "topic"
    ? c.state.notes.find((item) => item.id === topics.find((topic) => topic.id === topicId)?.noteId) : undefined;
  const already = new Set(summary.applications.filter((item) => item.targetNoteId === target?.id).flatMap((item) => item.sectionIds));
  const sectionIds = selected.filter((id) => !already.has(id));
  const navigateSource = (href: string) => {
    if (applying) return;
    onClose(); void c.navigateLink(href);
  };
  const apply = async () => {
    if (applying || !sectionIds.length || (kind === "topic" && !target) || (kind === "new" && !title.trim())) return;
    const intent = { noteId: note.id, summaryId: summary.id, sectionIds,
      destination: { kind, ...(kind === "topic" ? { topicId } : {}), ...(kind === "new" ? { title: title.trim() } : {}) } };
    const key = JSON.stringify(intent);
    if (!request.current || request.current.key !== key) request.current = { key, id: crypto.randomUUID() };
    setApplying(true); setError("");
    try {
      if (kind === "current") {
        if (!c.editor.current) throw new Error("工作笔记编辑器尚未就绪，请关闭预览后重试。");
        await c.editor.current.applyAction("idea.summary.apply", { ...intent, requestId: request.current.id });
        setResultId(note.id);
      } else {
        await c.editor.current?.flush();
        const response = await c.mutate("idea.summary.apply", { ...intent, requestId: request.current.id,
          ...(target ? { revision: target.revision } : {}) });
        const result = response.result as Note;
        setResultId(result.id);
      }
      onApplied();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "写入失败，请重试；原稿保留。"); }
    finally { setApplying(false); }
  };
  return <dialog ref={dialog} className={styles.summaryDialog} aria-labelledby="idea-summary-title"
    onCancel={(event) => { event.preventDefault(); if (!applying) onClose(); }}
    onPointerDown={(event) => { backdropDown.current = event.target === event.currentTarget; }}
    onClick={(event) => { if (!applying && backdropDown.current && event.target === event.currentTarget) onClose(); backdropDown.current = false; }}>
    <header className={styles.dialogHeader}><div><h2 id="idea-summary-title">整理预览</h2>
      <p>{summary.title} · 基于 {summary.messageIds.length} 条对话消息 · {summary.model}</p></div>
      <TooltipButton type="button" aria-label="关闭整理预览" disabled={applying} onClick={onClose}><X size={18} /></TooltipButton></header>
    <div className={styles.summaryBody}>
      <p className={styles.notice}>核对这份阶段整理稿后，即可追加到工作笔记。写入前会保留原稿；需要时也可以只选择部分段落。</p>
      <div className={styles.inlineActions}><button type="button" disabled={applying} aria-pressed={selectingSections}
        onClick={() => {
          setResultId("");
          if (selectingSections) setSelected(summary.sections.map((section) => section.id));
          setSelectingSections((current) => !current);
        }}>{selectingSections ? "采用完整整理稿" : "选择段落"}</button>
        {selectingSections && <span className={styles.muted}>勾选需要写入的段落。</span>}
      </div>
      <div className={styles.summarySections}>
        {summary.sections.map((section) => <section key={section.id} className={styles.summarySection}>
          <label>{selectingSections && <input type="checkbox" checked={selected.includes(section.id) && !already.has(section.id)} disabled={applying || already.has(section.id)}
            onChange={(event) => { setResultId(""); setSelected((current) => event.target.checked ? [...current, section.id] : current.filter((id) => id !== section.id)); }} />}
            <strong>{section.title}</strong>{already.has(section.id) && <small>已写入此目标</small>}</label>
          <Markdown body={section.body} onNavigate={navigateSource} literatureLinks={summary.messages.flatMap(message => message.literatureSources ?? [])}
            onFindPaper={(query) => c.openLiterature(query, { noteId: note.id })} />
          {section.sourceIds.length > 0 && <details><summary>来源 {section.sourceIds.length} 项</summary>
            {section.sourceIds.map((id) => summary.sources.find((item) => item.id === id)).filter((source) => Boolean(source)).map((source) => source &&
              <div className={styles.sourceSnapshot} key={source.id}><button type="button" disabled={applying} onClick={() => navigateSource(source.sourceHref)}>{source.title}</button>
                <small>{ideaSourceScope(source)} · 修订 {source.revision}</small><blockquote>{source.text}</blockquote></div>)}
          </details>}
        </section>)}
      </div>
      <details className={styles.provenance}><summary>查看整理依据与原讨论</summary>
        <p>以下为生成时选中的消息快照，后续讨论不会改变这份依据。</p>
        {summary.messages.map((message) => <div key={message.id}><strong>{message.role === "user" ? "我的提问" : "AI 回复"}</strong><Markdown body={message.body} onNavigate={navigateSource} literatureLinks={message.literatureSources}
          onFindPaper={(query) => c.openLiterature(query, { noteId: note.id })} /></div>)}
      </details>
    </div>
    <footer className={styles.summaryFooter}>
      <details className={styles.provenance}><summary>更改写入位置 · {kind === "current" ? "当前工作笔记" : kind === "new" ? "新的想法笔记" : topics.find((topic) => topic.id === topicId)?.title || "关联研究问题"}</summary>
      <div className={styles.destination}><label>写入位置<select aria-label="整理稿写入位置" value={kind} disabled={applying}
        onChange={(event) => { setKind(event.target.value as typeof kind); setResultId(""); setError(""); }}>
        <option value="current">追加到当前想法的工作笔记</option><option value="new">另存为新的想法笔记</option>
        <option value="topic" disabled={!topics.length}>加入关联研究问题的综合笔记</option></select></label>
        {kind === "topic" && <label>研究问题<select aria-label="选择整理目标研究问题" value={topicId} disabled={applying} onChange={(event) => { setTopicId(event.target.value); setResultId(""); }}>
          {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.title}</option>)}</select></label>}
        {kind === "new" && <label>新笔记标题<input aria-label="整理后的新笔记标题" value={title} disabled={applying} onChange={(event) => { setTitle(event.target.value); setResultId(""); }} /></label>}
      </div>
      </details>
      <div className={styles.applyRow}><span>{resultId || !sectionIds.length && !selectingSections ? "阶段整理稿已写入所选笔记" : <>{selectingSections ? `已选 ${sectionIds.length} 段` : sectionIds.length === summary.sections.length ? "整份阶段整理稿" : `待写入 ${sectionIds.length} 段`}{kind === "current" ? "，追加到正文末尾" : ""}</>}</span>
        {resultId ? <span role="status">已写入。<button type="button" disabled={applying} onClick={onClose}>继续对话</button>{resultId !== note.id && <button type="button" disabled={applying} onClick={() => navigateSource(`kb://note/${resultId}`)}>打开笔记</button>}</span> :
          <button type="button" className={styles.primary} disabled={applying || !sectionIds.length || (kind === "topic" && !target) || (kind === "new" && !title.trim())} onClick={() => void apply()}>
            {applying ? "正在写入…" : !sectionIds.length && !selectingSections ? "已全部写入此目标" : selectingSections ? kind === "new" ? "另存所选段落" : "追加所选段落" : kind === "current" ? "追加到工作笔记" : kind === "new" ? "另存为新笔记" : "追加到研究问题"}</button>}
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </footer>
  </dialog>;
}
