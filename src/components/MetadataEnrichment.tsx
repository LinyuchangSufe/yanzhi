"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ExternalLink, Search, X } from "lucide-react";
import type { MetadataCandidate, MetadataLookupResult } from "../lib/import/enrichment-types";
import {
  candidateValues, defaultMetadataFields, metadataDoiConflict, metadataFieldLabels,
  metadataQuery, metadataSourceUrl, type MetadataField, type MetadataQuery, type MetadataValues,
} from "../lib/metadata-enrichment";
import { errorMessage, readResponse } from "./WorkspaceShared";
import styles from "./styles/MetadataEnrichment.module.css";

type Preview = { candidate: MetadataCandidate; base: MetadataValues; context: string };
const matchLabels = {
  exact: "标题一致", similar: "标题相近，请核对", different: "标题不同，请谨慎核对", unknown: "缺少标题，无法核对",
};
const publicationTypes: Record<string, string> = {
  "journal-article": "期刊文章", "posted-content": "预印本 / 发布稿",
  "proceedings-article": "会议文章", "book-chapter": "书籍章节",
  book: "书籍", monograph: "专著", report: "报告", dataset: "数据集",
};

export default function MetadataEnrichment({ values, contextKey, disabled, onApply }: {
  values: MetadataValues;
  contextKey: string;
  disabled: boolean;
  onApply: (proposed: MetadataValues, preview: MetadataValues, selected: MetadataField[], context: string) => string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lookup, setLookup] = useState<MetadataLookupResult | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [showCandidates, setShowCandidates] = useState(true);
  const [selected, setSelected] = useState<MetadataField[]>([]);
  const [confirmedConflict, setConfirmedConflict] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const latest = useRef({ values, contextKey });
  latest.current = { values, contextKey };
  const active = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });
  const lastContext = useRef(contextKey);
  const cancel = () => {
    active.current.generation += 1;
    active.current.controller?.abort();
    active.current.controller = null;
    setLoading(false);
  };
  useEffect(() => () => {
    active.current.generation += 1;
    active.current.controller?.abort();
  }, []);
  useEffect(() => {
    if (lastContext.current === contextKey) return;
    lastContext.current = contextKey;
    cancel();
    setLookup(null);
    setPreview(null);
    setShowCandidates(true);
    setSelected([]);
    setError("");
    setStatus("标题、来源、标识或 PDF 已更改；可按当前资料重新查询。");
  }, [contextKey]);

  const compare = (candidate: MetadataCandidate, key: string) => {
    const base = { ...latest.current.values };
    const proposed = candidateValues(candidate);
    setPreview({ candidate, base, context: key });
    setShowCandidates(false);
    setSelected(metadataDoiConflict(base, proposed) || candidate.match === "different"
      ? [] : defaultMetadataFields(base, proposed));
    setConfirmedConflict(false);
    setStatus("");
  };
  const query = async (request: MetadataQuery, selectedCandidate?: MetadataCandidate) => {
    cancel();
    const generation = ++active.current.generation;
    const controller = new AbortController();
    active.current.controller = controller;
    const key = latest.current.contextKey;
    setOpen(true);
    setLoading(true);
    setError("");
    setStatus("");
    if (!selectedCandidate) { setLookup(null); setPreview(null); setShowCandidates(true); setSelected([]); }
    const isCurrent = () => generation === active.current.generation && key === latest.current.contextKey && !controller.signal.aborted;
    try {
      const result = await readResponse(await fetch("/api/kb/metadata", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request), signal: controller.signal,
      })) as MetadataLookupResult;
      if (!isCurrent()) return;
      if (selectedCandidate) {
        const candidate = result.candidates[0] || selectedCandidate;
        setLookup((previous) => ({ ...result, candidates: previous?.candidates.map((item) =>
          item.id === selectedCandidate.id ? candidate : item) || [candidate] }));
        compare(candidate, key);
      } else {
        setLookup(result);
        if (request.action === "detail" && result.candidates.length === 1) compare(result.candidates[0], key);
        else if (!result.candidates.length) setStatus("没有找到候选。可补充 DOI 或期刊链接后重试，也可手工填写。");
      }
    } catch (failure) {
      if (!isCurrent()) return;
      setError(`${errorMessage(failure)}。原有字段已保留。`);
      if (selectedCandidate) {
        compare(selectedCandidate, key);
        setStatus("详情暂未读到，当前对比使用刚才的搜索结果；未提供的字段保持空缺。");
      }
    } finally {
      if (isCurrent()) { setLoading(false); active.current.controller = null; }
    }
  };
  const start = (titleOnly = false) => {
    const request = metadataQuery(latest.current.values, titleOnly);
    if (request) void query(request);
  };
  const proposed = preview ? candidateValues(preview.candidate) : null;
  const conflict = Boolean(proposed && metadataDoiConflict(values, proposed));
  const requiresIdentity = conflict && (!confirmedConflict || !selected.includes("doi") || !selected.includes("source"));
  const fieldNames = Object.keys(metadataFieldLabels) as MetadataField[];

  return (
    <section className={styles.enrichment} aria-label="读取文献信息">
      <div className={styles.actions}>
        <button type="button" disabled={disabled || loading || !metadataQuery(values)} onClick={() => start()}>
          <Search size={13} aria-hidden="true" />{loading ? "正在读取…" : "读取文献信息"}
        </button>
        {metadataQuery(values)?.action === "detail" && values.title.trim().length >= 2 &&
          <button type="button" className={styles.quiet} disabled={disabled || loading} onClick={() => start(true)}>按标题查找</button>}
        {loading && <button type="button" className={styles.quiet} onClick={() => { cancel(); setStatus("已取消查询，原有字段保持不变。"); }}>取消查询</button>}
        {!loading && lookup && <button type="button" className={styles.quiet} aria-expanded={open} aria-controls={`${id}-results`}
          onClick={() => setOpen(!open)}>{open ? <X size={12} /> : <ChevronDown size={12} />}{open ? "收起结果" : "展开结果"}</button>}
      </div>
      <p className={styles.hint}>点击后查询公开信息，不发送 PDF 和笔记。核对后填入表单，保存才生效。</p>
      {error && <p className={styles.warning} role="alert">{error}</p>}
      {status && <p className={styles.status} role="status">{status}</p>}
      {open && lookup && <div className={styles.results} id={`${id}-results`}>
        <div className={styles.resultHeading}>
          <strong>{!showCandidates && preview ? "已选文献" : lookup.candidates.length ? "核对候选文献" : "查询结果"}</strong>
          <small>读取于 {new Date(lookup.queriedAt).toLocaleString("zh-CN", { hour12: false })}</small>
        </div>
        <p className={styles.hint}>请核对作者、年份及 DOI；同名结果可能属于其他文献。</p>
        {lookup.warnings.map((warning, index) => <p key={index} className={styles.warning}>{warning}</p>)}
        {showCandidates && <div className={styles.candidates}>
          {lookup.candidates.map((candidate) => {
            const source = metadataSourceUrl(candidate.metadata.sourceUrl);
            return <article key={candidate.id} className={`${styles.candidate} ${preview?.candidate.id === candidate.id ? styles.active : ""}`}>
              <strong>{candidate.metadata.title || "来源未提供标题"}</strong>
              <span>{candidate.metadata.authors?.join("; ") || "作者未提供"} · {candidate.metadata.year || "年份未提供"}</span>
              {(candidate.publication || candidate.workType) && <small>
                {[candidate.publication, candidate.workType ? publicationTypes[candidate.workType] || candidate.workType : ""].filter(Boolean).join(" · ")}
              </small>}
              <span className={candidate.match === "different" ? styles.warning : styles.match}>{matchLabels[candidate.match]}</span>
              <small>DOI：{candidate.metadata.doi || "未提供"}</small>
              <div className={styles.actions}>
                <button type="button" disabled={disabled || loading} onClick={() => compare(candidate, contextKey)}>选择并对比</button>
                {source && <a href={source} target="_blank" rel="noopener noreferrer">核对来源 <ExternalLink size={11} aria-hidden="true" /></a>}
              </div>
            </article>;
          })}
        </div>}
        {!showCandidates && preview && proposed && <div className={styles.comparison}>
          <div className={styles.candidate}>
            <strong>{preview.candidate.metadata.title || "来源未提供标题"}</strong>
            <small>{[preview.candidate.publication, preview.candidate.metadata.year,
              preview.candidate.workType ? publicationTypes[preview.candidate.workType] || preview.candidate.workType : ""].filter(Boolean).join(" · ")}</small>
            <div className={styles.actions}>
              <button type="button" disabled={disabled || loading} onClick={() => setShowCandidates(true)}>更换候选（{lookup.candidates.length}）</button>
              {(!preview.candidate.metadata.authors?.length || !preview.candidate.metadata.year || !preview.candidate.metadata.abstract) &&
                <button type="button" className={styles.quiet} disabled={disabled || loading}
                  onClick={() => void query({ action: "detail", source: preview.candidate.metadata.doi || preview.candidate.metadata.sourceUrl,
                    ...(values.title.trim().length >= 2 ? { title: values.title.trim() } : {}) }, preview.candidate)}>补充读取公开详情</button>}
            </div>
          </div>
          <p className={styles.previewHeading}><strong>选择要填入的字段</strong></p>
          <p className={styles.hint}>默认仅勾选空缺字段。已有值需手动勾选才更新；来源未提供的内容不会清空当前值。</p>
          {preview.candidate.match === "different" && <p className={styles.warning}>候选标题与当前记录不同，已取消默认勾选。请先确认它们是否为同一篇文献。</p>}
          {conflict && <div className={styles.conflict}>
            <p className={styles.warning}>候选 DOI 与当前记录不同。为避免混合两篇文献的信息，需核对并同时勾选更新 DOI 和来源链接；PDF、笔记仍保持原样。</p>
            <label className={styles.check}><input type="checkbox" checked={confirmedConflict} onChange={(event) => setConfirmedConflict(event.target.checked)} />
              我已核对，确认候选对应当前文献</label>
          </div>}
          <fieldset className={styles.fields} disabled={disabled || loading}>
            <legend className={styles.srOnly}>待补全元数据字段</legend>
            {fieldNames.map((field) => {
              const changed = values[field] !== preview.base[field];
              const unavailable = !proposed[field].trim();
              return <div key={field} className={styles.fieldRow}>
                <label className={styles.check}>
                  <input type="checkbox" checked={selected.includes(field)} disabled={unavailable}
                    onChange={(event) => setSelected(event.target.checked ? [...selected, field] : selected.filter((item) => item !== field))} />
                  {metadataFieldLabels[field]}
                </label>
                <div className={styles.versions}>
                  <div><small>当前</small><p>{values[field] || "空缺"}</p></div>
                  <div><small>候选</small><p>{proposed[field] || "来源未提供"}</p></div>
                </div>
                {changed && <small className={styles.warning}>预览后已修改，将保留当前值；点击“更换候选”后重新选择，可核对当前值。</small>}
              </div>;
            })}
          </fieldset>
          <details className={styles.provenance}><summary>公开资料来源与读取说明</summary>
            <small>检索当前公开记录；读取时间不代表文章版本。读取文献信息不使用 AI。</small>
            {preview.candidate.provenance.map((origin, index) => {
              const url = metadataSourceUrl(origin.url);
              return <span key={`${origin.label}-${index}`}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{origin.label} <ExternalLink size={10} /></a> : origin.label}
                <small>：{origin.fields.map((field) => metadataFieldLabels[field === "sourceUrl" ? "source" : field === "arxivId" ? "arxiv" : field]).join("、")}</small></span>;
            })}
          </details>
          {preview.candidate.warnings.map((warning, index) => <p key={index} className={styles.warning}>{warning}</p>)}
          <div className={styles.actions}>
            <button type="button" className={styles.fill} disabled={disabled || loading || !selected.length || requiresIdentity}
              onClick={() => { setStatus(onApply(proposed, preview.base, selected, preview.context)); }}>
              填入所选字段（{selected.length}）
            </button>
            <small>只填入当前表单，点击下方“保存修改”后才写入知识库。</small>
          </div>
        </div>}
      </div>}
    </section>
  );
}
