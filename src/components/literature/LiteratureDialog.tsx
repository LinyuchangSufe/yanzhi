"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { KBState } from "../../lib/types";
import type { LiteratureContext } from "../../lib/literature/types";
import { useLiteratureDialog } from "./useLiteratureDialog";
import LiteratureCandidateCard from "./LiteratureCandidateCard";
import styles from "./LiteratureDialog.module.css";

export interface LiteratureDialogProps {
  state: KBState; context: LiteratureContext; initialQuery?: string;
  onClose: () => void; onChanged: () => Promise<void>; onOpenPaper: (id: string) => void;
}
export default function LiteratureDialog(props: LiteratureDialogProps) {
  const flow = useLiteratureDialog(props), dialog = useRef<HTMLDialogElement>(null), queryInput = useRef<HTMLInputElement>(null), titleId = useId();
  const [elapsed, setElapsed] = useState(0);
  const opener = useRef<HTMLElement | null>(typeof document === "undefined" ? null : document.activeElement as HTMLElement | null);
  useEffect(() => {
    const element = dialog.current, previous = opener.current;
    if (element && !element.open) element.showModal(); queryInput.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { setElapsed(0); if (!flow.savingToken) return; const startedAt = Date.now(); const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000); return () => window.clearInterval(timer); }, [flow.savingToken]);
  const close = () => { if (flow.savingToken) return; flow.cancelSearch(false); props.onClose(); };
  const busy = Boolean(flow.savingToken), searching = flow.searching;
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); close(); }}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <header className={styles.header}><div><h2 id={titleId}>查找文献</h2><p>核对公开来源中的题录，点击保存后才会加入文献库。</p></div><button type="button" className={styles.close} disabled={busy} onClick={close} aria-label="关闭文献查找，返回原页面"><X size={18} /></button></header>
    <div className={styles.body}>
      <form className={styles.searchForm} onSubmit={(event) => { event.preventDefault(); void flow.search(); }}>
        <label>题名、DOI、arXiv 或论文链接<input ref={queryInput} autoFocus aria-label="查找文献的题名或链接" value={flow.query} maxLength={4000} disabled={busy} placeholder="例如：论文标题、10.…、2601.01234 或 https://…" onChange={(event) => flow.changeQuery(event.target.value)} /></label>
        <button type="submit" className={styles.primary} disabled={busy || searching || flow.query.trim().length < 2 || flow.paperIds.length > 16}><Search size={15} aria-hidden="true" />{searching ? "正在搜索…" : "搜索文献"}</button>
        {searching && <button type="button" onClick={() => flow.cancelSearch()}>取消搜索</button>}
      </form>
      <section className={styles.scope} aria-label="继承标签与文献范围"><div className={styles.scopeHeading}><strong>继承标签</strong><span>{flow.paperIds.length} 篇来源文献</span></div>
        {flow.tags.length > 0 ? <div className={styles.tags} aria-label="本次继承的标签">{flow.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div> : <p className={styles.muted}>当前所选范围没有标签，本次不会自动添加标签。</p>}
        {flow.scopePapers.length > 0 && <details className={styles.scopeDetails} open={flow.scopePapers.length <= 4}><summary>选择标签来源 · {flow.paperIds.length}/{flow.scopePapers.length} 篇</summary><fieldset disabled={busy}>
          <legend className={styles.srOnly}>从哪些文献继承标签</legend>{flow.scopePapers.map((paper) => <label key={paper.id}><input type="checkbox" checked={flow.paperIds.includes(paper.id)} disabled={!flow.paperIds.includes(paper.id) && flow.paperIds.length >= 16} onChange={(event) => flow.togglePaper(paper.id, event.target.checked)} /><span>{paper.title}</span></label>)}
        </fieldset><p className={styles.muted}>将合并所选文献的标签，保留目标文献原有标签。改选后请重新搜索。</p></details>}
        {flow.paperIds.length > 16 && <p className={styles.warning}>最多选择 16 篇来源文献，请减少范围后搜索。</p>}
      </section>
      {flow.restored && !props.initialQuery && <p className={styles.muted}>已恢复本窗口上次的查询与标签来源范围。</p>}
      {flow.storageError && <p className={styles.muted}>{flow.storageError}</p>}
      {flow.stale && <p className={styles.warning} role="status">{flow.stale}</p>}
      {flow.error && <div className={styles.error} role="alert"><p>{flow.error}</p><button type="button" disabled={busy} onClick={() => void flow.refresh()}>刷新文献库核对</button></div>}
      {flow.notice && <p className={styles.muted} role="status">{flow.notice}</p>}
      {flow.result && <section className={styles.results} aria-label="公开题录候选"><div className={styles.resultsHeading}><h3>题录候选 <span>{flow.result.data.candidates.length}</span></h3><small>检索于 {new Date(flow.result.data.queriedAt).toLocaleString("zh-CN", { hour12: false })}</small></div><p className={styles.muted}>查询：{flow.result.query}</p>
        {flow.result.data.warnings.map((warning, index) => <p key={index} className={styles.warning}>{warning}</p>)}
        {!flow.result.data.candidates.length && <p className={styles.empty}>没有找到可核对的题录。可尝试更完整的标题、DOI 或论文详情页链接。</p>}
        {flow.result.data.candidates.map((candidate) => <LiteratureCandidateCard key={candidate.candidateToken} candidate={candidate} state={props.state} outcome={flow.outcomes[candidate.candidateToken]} busy={busy} saving={flow.savingToken === candidate.candidateToken} stale={Boolean(flow.stale)} onSave={() => void flow.save(candidate)} onOpenPaper={props.onOpenPaper} onRefresh={() => void flow.refresh()} />)}
      </section>}
      {!flow.result && !searching && !flow.error && !flow.stale && <p className={styles.empty}>输入你想查找的文献，或粘贴论文链接。检索不会写入文献库。</p>}
    </div>
    <footer className={styles.footer}><span role="status">{busy ? `正在核对并下载 PDF…已等待 ${elapsed} 秒` : searching ? "正在查询公开文献记录…" : "保存后留在当前页面，可另外点击打开文献。"}</span><button type="button" disabled={busy} onClick={close}>返回原页面</button></footer>
  </dialog>;
}
