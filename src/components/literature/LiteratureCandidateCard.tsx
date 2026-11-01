"use client";
import { ExternalLink, FileCheck2 } from "lucide-react";
import type { KBState } from "../../lib/types";
import type { LiteratureCandidate } from "../../lib/literature/types";
import { existingLiteraturePaper, safeLiteratureHref } from "../../lib/literature/client";
import type { CandidateOutcome } from "./useLiteratureDialog";
import styles from "./LiteratureDialog.module.css";

const fields: Record<string, string> = { title: "标题", authors: "作者", year: "年份", doi: "DOI", arxivId: "arXiv", abstract: "摘要", sourceUrl: "来源链接" };
const matchLabels = { exact: "题名一致，请核对作者、年份与标识", similar: "相近题名，请核对文献身份", different: "与查询信息有差异", unknown: "请核对文献身份" };
export default function LiteratureCandidateCard({ candidate, state, outcome, busy, saving, stale, onSave, onOpenPaper, onRefresh }: {
  candidate: LiteratureCandidate; state: KBState; outcome?: CandidateOutcome; busy: boolean; saving: boolean; stale: boolean;
  onSave: () => void; onOpenPaper: (id: string) => void; onRefresh: () => void;
}) {
  const metadata = candidate.metadata, existing = existingLiteraturePaper(state, candidate);
  const paperId = outcome?.paperId ?? existing?.id ?? candidate.existingPaperId;
  const trashed = existing ? Boolean(existing.deletedAt) : Boolean(candidate.existingTrashed);
  const hasPdf = Boolean(outcome?.pdfReady || (existing && state.attachments.some((attachment) => attachment.paperId === existing.id && attachment.status === "available")) || (!existing && candidate.hasPdf));
  const source = safeLiteratureHref(metadata.sourceUrl), warnings = [...new Set([...(outcome?.warnings ?? []), ...candidate.warnings])];
  const label = saving ? "正在核对并下载 PDF…" : trashed ? "恢复后可下载" : hasPdf ? "同步所选标签" : paperId ? "重试下载 PDF" : "保存并下载 PDF";
  return <article className={styles.candidate} aria-label={metadata.title || "文献候选"}>
    <div className={styles.candidateHeading}><h3>{metadata.title || "来源未提供标题"}</h3>
      {paperId && <span className={styles.libraryStatus}><FileCheck2 size={14} aria-hidden="true" />{trashed ? "已在回收站" : hasPdf ? "库中已有 PDF" : "库中已有题录"}</span>}</div>
    <p className={styles.authors}>{metadata.authors?.length ? metadata.authors.join("；") : "作者未提供"}<span> · {metadata.year || "年份未提供"}</span></p>
    {(candidate.publication || candidate.workType) && <p className={styles.muted}>{[candidate.publication, candidate.workType].filter(Boolean).join(" · ")}</p>}
    <dl className={styles.identifiers}>{metadata.doi && <><dt>DOI</dt><dd>{metadata.doi}</dd></>}{metadata.arxivId && <><dt>arXiv</dt><dd>{metadata.arxivId}{metadata.arxivVersion ? `v${metadata.arxivVersion}` : ""}</dd></>}</dl>
    <p className={styles.match}>{matchLabels[candidate.match]}</p>
    {metadata.abstract && <details className={styles.details}><summary>查看摘要</summary><p className={styles.abstract}>{metadata.abstract}</p></details>}
    <details className={styles.details}><summary>核对来源与字段依据</summary>
      {source && <a href={source} target="_blank" rel="noopener noreferrer">打开文献来源<ExternalLink size={12} aria-hidden="true" /></a>}
      {candidate.provenance.map((origin, index) => { const url = safeLiteratureHref(origin.url); return <div key={`${origin.label}-${index}`} className={styles.provenance}>
        {url ? <a href={url} target="_blank" rel="noopener noreferrer">{origin.label}<ExternalLink size={12} aria-hidden="true" /></a> : <span>{origin.label}</span>}
        <small>{origin.fields.map((field) => fields[field] || field).join("、")}</small></div>; })}
      {!source && !candidate.provenance.length && <p className={styles.muted}>来源未提供可打开的链接，请核对其他文献信息。</p>}
    </details>
    {outcome && <p className={outcome.uncertain || !outcome.pdfReady ? styles.warning : styles.success} role="status">{outcome.uncertain && existing ? trashed ? "已找到回收站中的已有记录" : hasPdf ? "已找到库中记录，PDF 可用" : "已找到库中题录，PDF 待补" : outcome.label}</p>}
    {trashed && <p className={styles.warning}>该文献在回收站中。请打开已有文献并恢复，再重新查找下载。</p>}
    {warnings.length > 0 && <div className={styles.warnings}>{warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
    <div className={styles.cardActions}><button type="button" className={styles.primary} disabled={busy || stale || trashed || !metadata.title?.trim()} onClick={onSave}>{label}</button>
      {paperId && <button type="button" disabled={busy} onClick={() => onOpenPaper(paperId)}>打开已有文献</button>}
      {outcome?.uncertain && <button type="button" disabled={busy} onClick={onRefresh}>刷新文献库核对</button>}
      {!paperId && source && <a href={source} target="_blank" rel="noopener noreferrer">核对原文来源<ExternalLink size={12} aria-hidden="true" /></a>}
    </div>
  </article>;
}
