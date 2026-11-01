"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Search, X } from "lucide-react";
import type { KBState } from "../../lib/types";
import type { IdeaSourceSnapshot } from "../../lib/idea-lab/types";
import { ideaSourceScope } from "../../lib/idea-lab/source-details";
import Markdown from "../Markdown";
import TooltipButton from "../TooltipButton";
import { originalTextOffset } from "../chat-context-selection";
import { historicalIdeaMaterialProblem, ideaMaterials, materialAdditionError, selectIdeaMaterial, type SelectedIdeaMaterial } from "./idea-materials";
import styles from "./IdeaWorkspace.module.css";

export default function IdeaMaterials({ state, noteId, selected, onAdd, onRemove, includeCurrentNote, onIncludeCurrentNoteChange, currentNoteCharacters, historySources, onImportCodex, onFindPaper, onClose, onNavigate }: {
  state: KBState; noteId: string; selected: readonly SelectedIdeaMaterial[];
  onAdd: (material: SelectedIdeaMaterial) => boolean; onRemove: (key: string) => void;
  includeCurrentNote: boolean; onIncludeCurrentNoteChange: (include: boolean) => void; currentNoteCharacters: number;
  historySources: readonly IdeaSourceSnapshot[];
  onImportCodex?: () => void;
  onFindPaper?: (query?: string) => void;
  onClose: () => void; onNavigate: (href: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropDown = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [active, setActive] = useState("");
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [excerpt, setExcerpt] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal(); input.current?.focus();
    return () => { dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const candidates = useMemo(() => ideaMaterials(state, noteId), [state, noteId]);
  const visible = candidates.filter((item) => (filter === "all" || item.input.type === filter) &&
    (!query.trim() || `${item.title} ${item.label} ${item.text}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const item = candidates.find((candidate) => candidate.key === active);
  const preview = item ? excerpt ? selectIdeaMaterial(item, range.start, range.end) : selectIdeaMaterial(item) : undefined;
  const used = selected.reduce((sum, material) => sum + material.text.length, 0);
  const totalCharacters = used + (includeCurrentNote ? currentNoteCharacters : 0);
  const totalCount = selected.length + Number(includeCurrentNote);
  const add = () => {
    if (!preview) return;
    if (historySources.some((source) => source.type === preview.input.type && source.entityId === preview.input.id && source.field === preview.input.field &&
      source.evidenceId === preview.input.evidenceId && source.revision === preview.input.revision && source.start === (preview.input.start ?? 0) && source.end === (preview.input.end ?? preview.text.length))) {
      setError(""); setNotice("已在讨论中，无需重复添加。若要换一组资料，可新建讨论。"); return;
    }
    const problem = materialAdditionError(selected, preview);
    if (problem) { setError(problem); return; }
    if (totalCount >= 8 || totalCharacters + preview.text.length > 24000) { setError("本次新增资料最多 8 项、共 24,000 字符，工作笔记也计入上限。"); return; }
    if (onAdd(preview)) { setError(""); setNotice(`已加入参考资料：${preview.title}`); }
  };
  return <dialog ref={dialog} className={styles.materialDialog} aria-labelledby="idea-materials-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onPointerDown={(event) => { backdropDown.current = event.target === event.currentTarget; }}
    onClick={(event) => { if (backdropDown.current && event.target === event.currentTarget) onClose(); backdropDown.current = false; }}>
    <header className={styles.dialogHeader}>
      <div><h2 id="idea-materials-title">参考资料</h2><p>选择后随下一条消息发送，后续讨论自动沿用，无需每轮重复选择。论文只读取摘要。</p></div>
      <TooltipButton type="button" aria-label="关闭讨论资料" onClick={onClose}><X size={18} /></TooltipButton>
    </header>
    <div className={styles.materialContent}><div className={styles.materialLayout}>
      <aside className={styles.materialSidebar}>
        <label className={styles.search}><Search size={15} /><input ref={input} aria-label="搜索参考资料" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或内容" /></label>
        <div className={styles.materialFilters} role="group" aria-label="资料类型">
          {[["all", "全部"], ["paper", "论文摘要"], ["note", "笔记与想法"], ["topic", "研究问题"], ["annotation", "批注"], ["guideEvidence", "导读原句"], ["externalDiscussion", "外部讨论"]].map(([id, label]) =>
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
        </div>
        {onImportCodex && <button type="button" onClick={() => { onClose(); onImportCodex(); }}>从 Codex 导入</button>}
        {onFindPaper && <button type="button" onClick={() => { onClose(); onFindPaper(); }}>查找并收藏文献</button>}
        <div className={styles.materialList}>
          {visible.map((candidate) => <button type="button" key={candidate.key} aria-pressed={active === candidate.key}
            onClick={() => { setActive(candidate.key); setRange({ start: 0, end: 0 }); setExcerpt(false); setError(""); setNotice(""); }}>
            <strong>{candidate.title}</strong><span>{candidate.label}{candidate.related ? " · 已关联" : ""}{candidate.disabledReason ? " · 来源不可用" : !candidate.text.trim() ? candidate.input.type === "paper" ? " · 尚无摘要" : " · 尚无文字" : ""}</span>
          </button>)}
          {!visible.length && <p className={styles.empty}>没有匹配的资料。</p>}
        </div>
      </aside>
      <section className={styles.materialPreview} aria-label="讨论资料预览">
        {item ? <>
          <div className={styles.materialTitle}><div><h3>{item.title}</h3><p>{item.label}</p></div>
            <button type="button" onClick={() => { onClose(); onNavigate(item.sourceHref); }}><ExternalLink size={13} />打开来源</button></div>
          <details className={styles.materialMeta}><summary>读取范围与版本</summary><p>修订 {item.input.revision} · 完整内容 {item.text.length.toLocaleString()} 字符。{item.input.type === "paper" ? "仅使用已保存的论文摘要，不读取 PDF 全文。" : "使用已保存的文字快照；可在下方选择所需片段。"}</p></details>
          {item.disabledReason && <p className={styles.error} role="status">{item.disabledReason} 当前预览仍保留。</p>}
          {item.input.type === "guideEvidence" && <p className={styles.muted}>这里只附上原句。原句匹配不代表导读的 AI 解释已经核验。</p>}
          {item.explanation && <details className={styles.materialMeta}><summary>AI 解释 · 不随原文证据发送</summary><Markdown body={item.explanation} onNavigate={(href) => { onClose(); onNavigate(href); }} /></details>}
          {item.input.type === "externalDiscussion" && <p className={styles.muted}>这是导入的用户与 AI 对话正文。它可作为思考材料，不能直接当作论文原文或已核验结论。</p>}
          <div className={styles.inlineActions} role="group" aria-label="资料范围">
            <button type="button" aria-pressed={!excerpt} onClick={() => setExcerpt(false)}>{item.input.type === "paper" ? "摘要预览" : "完整内容预览"}</button>
            <button type="button" aria-pressed={excerpt} onClick={() => setExcerpt(true)}>选择片段</button>
          </div>
          {!item.text.trim() ? <p className={styles.empty}>{item.input.type === "paper" ? "这篇论文尚无摘要。可先补全摘要，或引用它的笔记、批注原文。这里不会读取 PDF 全文。" : "这项资料尚无文字。区域批注没有自动识别原文，可选择已经写下的评论。"}</p> : excerpt ? <>
            <p className={styles.muted}>在下方原文中选中文字，Markdown 与 LaTeX 原样保留。</p>
            <textarea readOnly className={styles.sourceText} aria-label="选择讨论资料片段" value={item.text}
              onSelect={(event) => setRange({ start: originalTextOffset(item.text, event.currentTarget.selectionStart), end: originalTextOffset(item.text, event.currentTarget.selectionEnd) })} />
          </> : <div className={styles.materialBody}><Markdown body={item.text} onNavigate={(href) => { onClose(); onNavigate(href); }} /></div>}
          <div className={styles.materialAdd}><span>{excerpt ? `已选 ${Math.max(0, range.end - range.start).toLocaleString()} 字符` : `${item.input.type === "paper" ? "摘要" : "完整内容"} ${item.text.length.toLocaleString()} 字符`}</span>
            <button type="button" className={styles.primary} disabled={!preview?.text.trim() || preview.text.length > 16000 || Boolean(preview.disabledReason)}
              onClick={add}>{excerpt ? "加入所选片段" : item.input.type === "paper" ? "加入摘要" : "加入完整内容"}</button></div>
          {(excerpt ? range.end - range.start : item.text.length) > 16000 && <p className={styles.error}>单项资料最多 16,000 字符，请选择较短片段。</p>}
        </> : <p className={styles.empty}>可选论文摘要、笔记、研究问题、批注、导读原句或导入的外部讨论。预览后加入参考资料，后续讨论会继续沿用。</p>}
      </section>
    </div>
      {(selected.length > 0 || historySources.length > 0) && <details className={styles.materialSelection}><summary>已选与历史资料 · 待发送 {totalCount} 项{historySources.length ? `，历史 ${historySources.length} 项` : ""}</summary>
        <div className={styles.materialSelectionBody}>
          {selected.length > 0 && <><div className={styles.chips}>{selected.map((material) => <span key={material.key}>{material.title} · 修订 {material.input.revision}<TooltipButton type="button" aria-label={`移除资料：${material.title}`} onClick={() => onRemove(material.key)}><X size={14} /></TooltipButton></span>)}</div>
            {selected.map((material) => {
              const current = candidates.find((candidate) => candidate.input.type === material.input.type && candidate.input.id === material.input.id && candidate.input.field === material.input.field && candidate.input.evidenceId === material.input.evidenceId);
              const retainedExternal = material.input.type === "externalDiscussion" && state.externalDiscussions?.some((item) => item.id === material.input.id && item.history.some((version) => version.revision === material.input.revision));
              const problem = !current ? "当前来源已不存在，请移除后重新选择。" : current.input.revision !== material.input.revision && !retainedExternal ? "来源已更新，待发送资料仍是旧版本，请重新选择。" : current.disabledReason;
              if (retainedExternal && current?.input.revision !== material.input.revision) return <p className={styles.muted} key={material.key}>{material.title}：本次沿用你选择的历史修订 {material.input.revision}，不会自动换成当前正文。</p>;
              return problem ? <p className={styles.error} key={material.key}>{material.title}：{problem}</p> : null;
            })}
          </>}
          {historySources.length > 0 && <><p>以下快照已在本对话中沿用，无需重复添加。要换一组资料，请新建对话。</p>
            {historySources.map((source) => <details key={source.id} className={styles.historyMaterials}><summary>{source.title}{historicalIdeaMaterialProblem(state, source) ? " · 来源不可用" : ""}</summary>
              <div className={styles.sourceSnapshot}><button type="button" onClick={() => { onClose(); onNavigate(source.sourceHref); }}><ExternalLink size={13} />打开来源</button>
                <small>{ideaSourceScope(source)} · {source.text.length.toLocaleString()} 字符 · 修订 {source.revision}{source.pageIndex === undefined ? "" : ` · 物理第 ${source.pageIndex + 1} 页`}</small>
                {historicalIdeaMaterialProblem(state, source) && <p className={styles.error}>{historicalIdeaMaterialProblem(state, source)} 原快照未更改。</p>}
                <blockquote>{source.text}</blockquote></div>
            </details>)}
          </>}
        </div>
      </details>}
    </div>
    <footer className={styles.materialFooter}>
      <div><label className={styles.includeNote}><input type="checkbox" checked={includeCurrentNote} disabled={!currentNoteCharacters && !includeCurrentNote} onChange={(event) => {
        const include = event.target.checked;
        if (include && currentNoteCharacters > 16000) { setError("工作笔记超过单项 16,000 字符上限，可将需要的短片段粘贴到提问中。"); return; }
        if (include && (selected.length >= 8 || used + currentNoteCharacters > 24000)) { setError("本次新增资料最多 8 项、共 24,000 字符，工作笔记也计入上限。"); return; }
        onIncludeCurrentNoteChange(include); setError("");
      }} />下次发送时附上工作笔记 · {currentNoteCharacters.toLocaleString()} 字符</label>
        <strong>待发送 {totalCount} / 8 项 · {totalCharacters.toLocaleString()} / 24,000 字符</strong>
        <div className={styles.materialFeedback}>{error && <p className={styles.error} role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</div></div>
      <button type="button" className={styles.primary} onClick={onClose}>完成选择</button>
    </footer>
  </dialog>;
}
