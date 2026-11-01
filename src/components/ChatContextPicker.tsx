"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ExternalLink, FileText, Search, X } from "lucide-react";
import type { KBState, Note, NotePurpose, Topic } from "../lib/types";
import type { ChatContext } from "../lib/paper-chat/types";
import Markdown from "./Markdown";
import TooltipButton from "./TooltipButton";
import { ChatContextReferences, contextPurposeLabel } from "./ChatContextReferences";
import { originalTextOffset } from "./chat-context-selection";
import styles from "./ChatContextPicker.module.css";

type Source = { note: Note; topic?: Topic; title: string };
type Library = Pick<KBState, "notes" | "topics">;
type Selection = { start: number; end: number };
const MAX_COUNT = 8;
const MAX_ITEM = 16_000;
const MAX_TOTAL = 24_000;

export function ChatContextPicker({ contexts, onAdd, onAddMany, onRemove, onClose, onNavigate }: {
  contexts: readonly ChatContext[];
  onAdd: (context: ChatContext) => boolean;
  onAddMany: (contexts: ChatContext[]) => boolean;
  onRemove?: (index: number) => void;
  onClose: () => void;
  onNavigate?: (href: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const backdropDown = useRef(false);
  const titleId = useId();
  const [library, setLibrary] = useState<Library | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<NotePurpose | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [field, setField] = useState<"body" | "description">("body");
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 });
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    searchInput.current?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void (async () => {
      try {
        const response = await fetch("/api/kb", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("暂时无法读取个人记录，请重试。");
        const state = await response.json() as KBState;
        if (!Array.isArray(state.notes) || !Array.isArray(state.topics)) throw new Error("个人记录格式异常，请重试。");
        if (!controller.signal.aborted) setLibrary({ notes: state.notes, topics: state.topics });
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "暂时无法读取个人记录，请重试。");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [attempt]);

  const sources = useMemo<Source[]>(() => {
    if (!library) return [];
    const topics = new Map(library.topics.map(topic => [topic.noteId, topic]));
    return library.notes.map(note => {
      const topic = topics.get(note.id);
      return { note, topic, title: topic?.title || note.title || "未命名" };
    }).sort((a, b) => b.note.updatedAt.localeCompare(a.note.updatedAt));
  }, [library]);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return sources.filter(source => (filter === "all" || source.note.purpose === filter) && (!query || `${source.title}\n${source.note.body}\n${source.topic?.description || ""}`.toLocaleLowerCase().includes(query)));
  }, [sources, search, filter]);
  const selected = sources.find(source => source.note.id === selectedId);
  const body = field === "description" ? selected?.topic?.description || "" : selected?.note.body || "";
  const revision = field === "description" ? selected?.topic?.revision || 0 : selected?.note.revision || 0;
  const fullLength = body.length;
  const excerpt = body.slice(selection.start, selection.end);
  const used = contexts.reduce((sum, context) => sum + context.text.length, 0);
  const remaining = Math.max(0, MAX_TOTAL - used);
  const sourceHref = selected?.topic ? `kb://topic/${selected.topic.id}` : selected ? `kb://note/${selected.note.id}` : "";

  function choose(source: Source) {
    setSelectedId(source.note.id); setSelection({ start: 0, end: 0 });
    setField(!source.note.body.trim() && source.topic?.description.trim() ? "description" : "body");
    setShowSource(false); setError(""); setNotice("");
  }

  function add(mode: "full" | "excerpt") {
    if (!selected) return;
    const text = mode === "full" ? body : excerpt;
    if (!text.trim()) { setError(mode === "full" ? "这条记录还没有可引用的笔记正文。" : "请先在原文中选中要引用的片段。"); return; }
    if (contexts.length >= MAX_COUNT) { setError("每轮最多引用 8 项，请先移除部分引用。"); return; }
    if (text.length > MAX_ITEM || text.length > remaining) { setError("内容超出本轮引用限额，请选取较短片段。"); return; }
    const start = mode === "full" ? 0 : selection.start;
    const end = mode === "full" ? body.length : selection.end;
    const context: ChatContext = {
      noteId: selected.note.id, ...(selected.topic ? { topicId: selected.topic.id } : {}),
      title: selected.title, purpose: selected.note.purpose, revision,
      field, mode, text, start, end, sourceHref,
    };
    if (contexts.some(item => item.noteId === context.noteId && (item.field || "body") === field && item.start === start && item.end === end && item.revision === context.revision)) {
      setError("这段内容已在本轮引用中。"); return;
    }
    if (onAdd(context)) { setError(""); setNotice(`已加入：${selected.title}（${mode === "full" ? "全文" : "片段"}）`); }
    else { setError("无法添加这段内容，请检查引用数量和长度，或重新打开读取最新记录。"); }
  }

  function addWholeQuestion() {
    if (!selected?.topic) return;
    const items: ChatContext[] = (["description", "body"] as const).flatMap(part => {
      const text = part === "description" ? selected.topic!.description : selected.note.body;
      if (!text.trim()) return [];
      return [{ noteId: selected.note.id, topicId: selected.topic!.id, title: selected.title,
        purpose: selected.note.purpose, revision: part === "description" ? selected.topic!.revision : selected.note.revision,
        field: part, mode: "full" as const, text, start: 0, end: text.length, sourceHref }];
    });
    if (!items.length) { setError("这个问题还没有可引用的描述或笔记正文。"); return; }
    if (contexts.length + items.length > MAX_COUNT || items.some(item => item.text.length > MAX_ITEM) || used + items.reduce((sum, item) => sum + item.text.length, 0) > MAX_TOTAL) {
      setError("整个问题超出本轮引用限额，请分别选择需要的描述或笔记片段。"); return;
    }
    if (items.some(item => contexts.some(existing => existing.noteId === item.noteId && (existing.field || "body") === item.field && existing.start === item.start && existing.end === item.end && existing.revision === item.revision))) {
      setError("这个问题的部分全文已在本轮引用中，可切换内容范围补充另一部分。"); return;
    }
    if (onAddMany(items)) { setError(""); setNotice(`已加入整个问题：${selected.title}（${items.length} 项）`); }
    else setError("无法加入整个问题，请检查引用数量和长度，或重新读取最新记录。");
  }

  const navigate = onNavigate ? (href: string) => { onClose(); onNavigate(href); } : undefined;
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}
    onPointerDown={event => { backdropDown.current = event.target === event.currentTarget; }}
    onClick={event => { if (backdropDown.current && event.target === event.currentTarget) onClose(); }}>
    <div className={styles.header}>
      <div><h2 id={titleId}>参考资料</h2><p>添加已保存的笔记、研究问题或想法，随下一条消息发送。</p></div>
      <TooltipButton type="button" className={styles.close} aria-label="关闭参考资料" tooltip="关闭参考资料（Esc）" onClick={onClose}><X size={18} aria-hidden="true" /></TooltipButton>
    </div>
    <div className={styles.layout}>
      <aside className={styles.sidebar} aria-label="选择参考资料来源">
        <label className={styles.search}><Search size={15} aria-hidden="true" /><input ref={searchInput} aria-label="搜索参考资料" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索标题或内容" /></label>
        <div className={styles.filters} role="group" aria-label="来源类型">
          {(["all", "paper", "topic", "idea"] as const).map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "all" ? "全部" : contextPurposeLabel[value]}</button>)}
        </div>
        <div className={styles.sources}>
          {loading ? <p className={styles.empty} role="status">正在读取个人记录…</p> : !library ? <div className={styles.empty}><p>暂时无法读取记录。</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></div> : filtered.length ? filtered.map(source => <button type="button" key={source.note.id} className={styles.source} aria-pressed={selectedId === source.note.id} onClick={() => choose(source)}>
            <span className={styles.sourceTitle}><FileText size={14} aria-hidden="true" />{source.title}</span>
            <span className={styles.sourceMeta}>{contextPurposeLabel[source.note.purpose]} · {source.note.body.trim() || source.topic?.description.trim() ? `${(source.note.body.length + (source.topic?.description.length || 0)).toLocaleString()} 字符` : "尚无内容"}</span>
          </button>) : <p className={styles.empty}>{search.trim() ? "没有找到匹配的记录。" : "这里还没有已保存的记录。"}</p>}
        </div>
      </aside>
      <section className={styles.preview} aria-label="参考资料内容预览">
        {selected ? <>
          <div className={styles.previewHeading}><div><h3>{selected.title}</h3><details className={styles.scopeDetails}><summary>{contextPurposeLabel[selected.note.purpose]} · {field === "description" ? "问题描述" : "笔记正文"}</summary><p>修订 {revision} · 完整内容 {fullLength.toLocaleString()} 字符。只会加入明确选择的已保存文字。</p></details></div>{navigate && <button type="button" className={styles.openSource} onClick={() => navigate(sourceHref)}><ExternalLink size={13} aria-hidden="true" />打开来源</button>}</div>
          {selected.topic && <div className={styles.fieldModes} role="group" aria-label="问题内容范围"><button type="button" aria-pressed={field === "body"} onClick={() => { setField("body"); setSelection({ start: 0, end: 0 }); setError(""); setNotice(""); }}>综合笔记</button><button type="button" aria-pressed={field === "description"} onClick={() => { setField("description"); setSelection({ start: 0, end: 0 }); setError(""); setNotice(""); }}>问题描述</button><button type="button" className={styles.wholeQuestion} onClick={addWholeQuestion}>加入整个问题</button></div>}
          {body.trim() ? <>
            <div className={styles.viewModes} role="group" aria-label="参考资料预览模式"><button type="button" aria-pressed={!showSource} onClick={() => setShowSource(false)}>完整内容预览</button><button type="button" aria-pressed={showSource} onClick={() => setShowSource(true)}>选择片段</button></div>
            {showSource ? <div className={styles.sourceEditor}><p>选中原文后点“加入所选片段”，Markdown 和 LaTeX 会一同保留。</p><textarea readOnly aria-label="选择参考资料原文片段" value={body} onSelect={event => setSelection({ start: originalTextOffset(body, event.currentTarget.selectionStart), end: originalTextOffset(body, event.currentTarget.selectionEnd) })} /></div> : <div className={styles.rendered}><Markdown body={body} onNavigate={navigate} /></div>}
            <div className={styles.addActions}><span>{showSource ? `已选 ${excerpt.length.toLocaleString()} 字符` : `完整内容 ${fullLength.toLocaleString()} 字符`}</span>{showSource && <button type="button" className={styles.primary} disabled={!excerpt.trim() || excerpt.length > MAX_ITEM || excerpt.length > remaining || contexts.length >= MAX_COUNT} onClick={() => add("excerpt")}>加入所选片段</button>}<button type="button" className={showSource ? styles.secondary : styles.primary} disabled={fullLength > MAX_ITEM || fullLength > remaining || contexts.length >= MAX_COUNT} onClick={() => add("full")}>加入完整内容</button></div>
            {(fullLength > MAX_ITEM || fullLength > remaining) && <p className={styles.limit}>内容较长，可选择所需片段。每项最多 16,000 字符。</p>}
          </> : <div className={styles.noBody}><p>{field === "description" ? "这个问题尚未填写描述。" : "这条记录尚无可引用的笔记正文。"}</p>{selected.topic && field === "body" && selected.topic.description.trim() && <p>可切换“问题描述”，引用问题本身。</p>}</div>}
        </> : <div className={styles.placeholder}><FileText size={28} aria-hidden="true" /><p>选择资料，预览后加入下一条提问。</p><span>可加入完整内容或原文片段。</span></div>}
      </section>
    </div>
    <div className={styles.footer}><div><span>待发送 {contexts.length} / 8 项 · {used.toLocaleString()} / 24,000 字符</span>
      {contexts.length > 0 && <div className={styles.selectedSources}><ChatContextReferences contexts={contexts} onNavigate={navigate} onRemove={onRemove} /></div>}
      {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status"><Check size={12} aria-hidden="true" />{notice}</p>}</div><button type="button" className={styles.primary} onClick={onClose}>完成选择</button></div>
  </dialog>;
}
