"use client";
import { useEffect, useRef, useState } from "react";
import type { KBState } from "../lib/types";
import { inspectPdfFile } from "../lib/import/pdf-metadata";
import { pdfTitlesAgree } from "../lib/import/metadata-title";
import { submittedTagNames } from "../lib/tag-selection";
import TagPicker from "./TagPicker";
import MetadataEnrichment from "./MetadataEnrichment";
import {
  metadataContextKey, metadataDoiConflict, metadataFieldLabels, selectedMetadataChanges,
  type MetadataField, type MetadataValues,
} from "../lib/metadata-enrichment";
import {
  errorMessage,
  linked,
  readResponse,
  type Dialog,
} from "./WorkspaceShared";
import baseStyles from "./Workspace.module.css";
import contentStyles from "./styles/WorkspaceContent.module.css";
import formStyles from "./styles/PaperMetadataForm.module.css";
const styles = { ...baseStyles, ...contentStyles, ...formStyles };

interface PrefillMetadata {
  title?: string;
  authors?: string[];
  year?: number;
  abstract?: string;
  doi?: string;
  arxivId?: string;
  arxivVersion?: number | null;
  sourceUrl?: string;
}
export default function MetadataForm({
  dialog,
  state,
  busy,
  onSubmit,
  onDirtyChange,
  onCancel,
}: {
  dialog: Exclude<Dialog, null>;
  state: KBState;
  busy: boolean;
  onSubmit: (payload: Record<string, unknown>, file?: File) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onCancel?: () => void;
}) {
  const paper = dialog.kind === "paper" ? dialog.paper : undefined;
  const topic = dialog.kind === "topic" ? dialog.topic : undefined;
  const initialQuery =
    dialog.kind === "paper" ? dialog.initialQuery?.trim() || "" : "";
  const initialIsSource =
    /^(https?:\/\/|doi:|arxiv:|10\.\d{4,9}\/|\d{4}\.\d{4,5}(?:v\d+)?$)/i.test(
      initialQuery,
    );
  const [title, setTitle] = useState(
    paper?.title || topic?.title || (!initialIsSource ? initialQuery : ""),
  );
  const [source, setSource] = useState(
    paper?.sourceUrl || (initialIsSource ? initialQuery : ""),
  );
  const [authors, setAuthors] = useState(paper?.authors.join("; ") || "");
  const [authorDraft, setAuthorDraft] = useState("");
  const allAuthors = [authors, authorDraft].filter(Boolean).join("; ");
  const [step, setStep] = useState<"source" | "details">(paper || (initialQuery && !initialIsSource) ? "details" : "source");
  const creatingPaper = dialog.kind === "paper" && !paper;
  const showFields = !creatingPaper || step === "details";
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (creatingPaper && step === "details") titleInput.current?.focus(); }, [creatingPaper, step]);
  const [year, setYear] = useState(paper?.year?.toString() || "");
  const [abstract, setAbstract] = useState(paper?.abstract || "");
  const [doi, setDoi] = useState(paper?.doi || "");
  const [arxiv, setArxiv] = useState(paper?.arxivId || "");
  const [description, setDescription] = useState(topic?.description || "");
  const [tags, setTags] = useState(
    paper
      ? state.tags
          .filter((t) => linked(state, "paper", paper.id, "tag", t.id))
          .map((t) => t.name)
      : [],
  );
  const [tagDraft, setTagDraft] = useState("");
  const existingTagNames = state.tags.map((tag) => tag.name);
  const [file, setFile] = useState<File>();
  const [error, setError] = useState("");
  const [resolving, setResolving] = useState(false);
  const [warnings, setWarnings] = useState("");
  const [inspectingPdf, setInspectingPdf] = useState(false);
  const [autoCompletingPdf, setAutoCompletingPdf] = useState(false);
  const [pdfQueryAttempted, setPdfQueryAttempted] = useState(false);
  const [pdfWarnings, setPdfWarnings] = useState("");
  const [pdfSources, setPdfSources] = useState<Record<string, string>>({});
  const [detectedIdentifier, setDetectedIdentifier] = useState("");
  const formSnapshot = JSON.stringify({ title, source, authors, authorDraft, year, abstract, doi, arxiv, description, tags, tagDraft });
  const initialSnapshot = useRef(formSnapshot);
  const changed = Boolean(file) || formSnapshot !== initialSnapshot.current;
  useEffect(() => { onDirtyChange?.(changed); }, [changed, onDirtyChange]);
  useEffect(() => {
    if (!changed) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [changed]);
  const fileGeneration = useRef(0);
  const pdfContentTitle = useRef("");
  const resolveGeneration = useRef(0);
  const touched = useRef(new Set<MetadataField>());
  const fieldValues = useRef({
    title,
    source,
    authors,
    year,
    abstract,
    doi,
    arxiv,
  });
  fieldValues.current = { title, source, authors: allAuthors, year, abstract, doi, arxiv };
  const autoValues = useRef(
    new Map<MetadataField, { value: string; fileGeneration: number }>(
      initialQuery && !initialIsSource && !paper
        ? [["title", { value: initialQuery, fileGeneration: 0 }]]
        : [],
    ),
  );
  const setField = (field: MetadataField, value: string, manual = true) => {
    if (field === "authors") setAuthorDraft("");
    fieldValues.current[field] = value;
    if (manual) {
      touched.current.add(field);
      autoValues.current.delete(field);
    }
    const setters = {
      title: setTitle,
      source: setSource,
      authors: setAuthors,
      year: setYear,
      abstract: setAbstract,
      doi: setDoi,
      arxiv: setArxiv,
    };
    setters[field](value);
  };
  const autoFill = (
    field: MetadataField,
    value: string,
    generation: number,
  ) => {
    if (!value.trim() || touched.current.has(field)) return;
    const previous = fieldValues.current[field];
    if (previous && autoValues.current.get(field)?.value !== previous) return;
    setField(field, value, false);
    autoValues.current.set(field, { value, fileGeneration: generation });
  };
  const applyMetadata = (metadata: PrefillMetadata, generation: number) => {
    if (metadata.title) autoFill("title", metadata.title, generation);
    if (metadata.authors?.length)
      autoFill("authors", metadata.authors.join("; "), generation);
    if (metadata.year) autoFill("year", String(metadata.year), generation);
    if (metadata.abstract) autoFill("abstract", metadata.abstract, generation);
    if (metadata.doi) autoFill("doi", metadata.doi, generation);
    if (metadata.arxivId)
      autoFill(
        "arxiv",
        `${metadata.arxivId}${metadata.arxivVersion ? `v${metadata.arxivVersion}` : ""}`,
        generation,
      );
    if (metadata.sourceUrl) autoFill("source", metadata.sourceUrl, generation);
  };
  const resolveSource = async (input: string, byIdentifier = false) => {
    const request = ++resolveGeneration.current;
    const generation = fileGeneration.current;
    const sourceAtRequest = fieldValues.current.source;
    const doiAtRequest = fieldValues.current.doi;
    const arxivAtRequest = fieldValues.current.arxiv;
    setResolving(true);
    setWarnings("");
    try {
      const data = await readResponse(
        await fetch("/api/kb/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: input }),
        }),
      );
      if (
        request !== resolveGeneration.current ||
        generation !== fileGeneration.current
      )
        return;
      if (
        byIdentifier
          ? fieldValues.current.doi !== doiAtRequest ||
            fieldValues.current.arxiv !== arxivAtRequest
          : fieldValues.current.source !== sourceAtRequest
      ) {
        setWarnings("来源或标识已修改，已忽略旧请求的结果；可重新解析。");
        return;
      }
      const metadata = data.metadata as PrefillMetadata;
      if (byIdentifier && !metadata.title && data.warnings?.length) {
        setWarnings(
          `${data.warnings.join("；")}；公开元数据尚未获取，已保留本地识别结果，可手工核对或重试。`,
        );
        return;
      }
      if (
        byIdentifier &&
        pdfContentTitle.current &&
        (!metadata.title ||
          !pdfTitlesAgree(pdfContentTitle.current, metadata.title))
      ) {
        setWarnings(
          "标识对应标题与 PDF 不一致或缺少标题，保留本地识别结果，请核对标识与文献。",
        );
        return;
      }
      const before = { ...fieldValues.current };
      applyMetadata(metadata, generation);
      setStep("details");
      if (byIdentifier && generation > 0) {
        const sourceKeys: Partial<Record<MetadataField, string>> = {
          title: "title",
          authors: "authors",
          year: "year",
          doi: "doi",
          arxiv: "arxivId",
        };
        setPdfSources((previous) => {
          const next = { ...previous };
          for (const field of Object.keys(sourceKeys) as MetadataField[]) {
            if (
              before[field] !== fieldValues.current[field] &&
              !touched.current.has(field)
            )
              next[sourceKeys[field]!] = "公开元数据（仅按标识查询，请核对）";
          }
          return next;
        });
      }
      setWarnings(
        [
          ...(data.warnings || []),
          byIdentifier
            ? "已按标识补全未手填的字段；仅发送标识，没有上传 PDF。请核对后保存。"
            : "已解析未手填的字段，可核对修改后保存。",
        ].join("；"),
      );
    } catch (error) {
      if (
        request === resolveGeneration.current &&
        generation === fileGeneration.current
      )
        setWarnings(`${errorMessage(error)}。原输入保留，可手工填写并保存。`);
    } finally {
      if (request === resolveGeneration.current) setResolving(false);
    }
  };
  const choosePdf = async (selected?: File) => {
    const generation = ++fileGeneration.current;
    resolveGeneration.current += 1;
    setResolving(false);
    setFile(selected);
    pdfContentTitle.current = "";
    setAutoCompletingPdf(false);
    setPdfQueryAttempted(false);
    setPdfWarnings("");
    setPdfSources({});
    setDetectedIdentifier("");
    setWarnings("");
    // Existing nonempty metadata and every manually edited field stay protected.
    for (const [field, previous] of autoValues.current) {
      if (
        previous.fileGeneration > 0 &&
        !touched.current.has(field) &&
        fieldValues.current[field] === previous.value
      ) {
        setField(field, "", false);
        autoValues.current.delete(field);
      }
    }
    if (!selected) {
      setInspectingPdf(false);
      return;
    }
    autoFill("title", selected.name.replace(/\.pdf$/i, ""), generation);
    setPdfSources({ title: "文件名（待核对）" });
    setInspectingPdf(true);
    try {
      const result = await inspectPdfFile(selected);
      if (generation !== fileGeneration.current) return;
      pdfContentTitle.current =
        result.metadata.title &&
        result.sources.title &&
        !/文件名|filename/i.test(result.sources.title)
          ? result.metadata.title
          : "";
      applyMetadata(result.metadata, generation);
      setPdfSources(
        Object.fromEntries(
          Object.entries(result.sources).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      );
      setPdfWarnings(result.warnings.join("；"));
      const foundIdentifier =
        result.metadata.doi ||
        (result.metadata.arxivId
          ? `arxiv:${result.metadata.arxivId}${result.metadata.arxivVersion ? `v${result.metadata.arxivVersion}` : ""}`
          : "");
      setDetectedIdentifier(foundIdentifier);
      if (foundIdentifier && !paper) {
        setInspectingPdf(false);
        setAutoCompletingPdf(true);
        setPdfQueryAttempted(true);
        await resolveSource(foundIdentifier, true);
        if (generation === fileGeneration.current) setAutoCompletingPdf(false);
      }
    } catch (error) {
      if (generation === fileGeneration.current)
        setPdfWarnings(
          `${errorMessage(error)}。仍可修改文件名标题并手工填写资料、保存文献。`,
        );
    } finally {
      if (generation === fileGeneration.current) { setInspectingPdf(false); setStep("details"); }
    }
  };
  const fillSelectedMetadata = (
    proposed: MetadataValues, preview: MetadataValues, selected: MetadataField[], context: string,
  ) => {
    if (context !== metadataContextKey(fieldValues.current, fileGeneration.current))
      return "标题、来源、标识或 PDF 已更改，旧候选未填入；请重新查询。";
    if (metadataDoiConflict(fieldValues.current, proposed) &&
      (!selected.includes("doi") || !selected.includes("source")))
      return "DOI 与当前记录不同，请核对并同时勾选 DOI 和来源链接，避免混合文献信息。";
    const { changes, skipped } = selectedMetadataChanges(fieldValues.current, preview, proposed, selected);
    // An explicitly reviewed selection is protected from all older automatic lookups.
    resolveGeneration.current += 1;
    setResolving(false);
    const fields = Object.keys(changes) as MetadataField[];
    for (const field of fields) setField(field, changes[field]!);
    const message = [
      fields.length ? `已填入 ${fields.map((field) => metadataFieldLabels[field]).join("、")}；尚未保存，请核对后点击“保存修改”。` : "没有需要填入的变更，当前字段保持不变。",
      ...(skipped.length ? [`${skipped.map((field) => metadataFieldLabels[field]).join("、")}已在预览后修改，保留了当前值；可重新对比后选择。`] : []),
    ].join(" ");
    setWarnings(message);
    return message;
  };
  const identifier =
    doi.trim() || (arxiv.trim() ? `arxiv:${arxiv.trim()}` : detectedIdentifier);
  return (
    <form
      className={styles.metadataForm}
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || inspectingPdf || resolving) return;
        if (!showFields) { setStep("details"); return; }
        setError("");
        if (!title.trim() && !source.trim() && !file) {
          setError("请填写标题、来源或选择 PDF。");
          return;
        }
        const payload: Record<string, unknown> = {
          title:
            title.trim() || file?.name.replace(/\.pdf$/i, "") || source.trim(),
        };
        if (dialog.kind === "paper") {
          let sourceUrl = source.trim();
          let id = doi.trim();
          let aid = arxiv.trim();
          sourceUrl = sourceUrl.replace(/^doi:\s*/i, "");
          if (
            /^(?:https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\//i.test(sourceUrl)
          ) {
            id = sourceUrl.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
            sourceUrl = `https://doi.org/${id}`;
          } else if (/^(?:arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(sourceUrl)) {
            aid = sourceUrl.replace(/^arxiv:/i, "");
            sourceUrl = `https://arxiv.org/abs/${aid}`;
          }
          Object.assign(payload, {
            sourceUrl,
            authors: allAuthors
              .split(/[;；]/)
              .map((a) => a.trim())
              .filter(Boolean),
            year: year ? Number(year) : null,
            abstract,
            doi: id,
            arxivId: aid,
            tags: submittedTagNames(tags, tagDraft, existingTagNames),
          });
        } else if (dialog.kind === "topic") payload.description = description;
        else payload.body = description;
        try { await onSubmit(payload, file); }
        catch (error) { setError(errorMessage(error)); }
      }}
    >
      {creatingPaper && <ol className={styles.steps} aria-label="添加文献步骤"><li aria-current={step === "source" ? "step" : undefined}>1 选择来源</li><li aria-current={step === "details" ? "step" : undefined}>2 核对信息</li></ol>}
      {dialog.kind === "paper" && (
        <details className={styles.sourceSection} open={step === "source" || !creatingPaper} key={step}>
          <summary>{creatingPaper && step === "source" ? "从链接或 PDF 开始" : "来源与 PDF"}</summary>
          <label>
            期刊链接、DOI 或 arXiv 标识
            <input
              autoFocus={creatingPaper && step === "source"}
              aria-label="文献来源"
              value={source}
              onChange={(e) => setField("source", e.target.value)}
              placeholder="https://… / 10.… / 2601.01234"
            />
          </label>
          {paper ? <MetadataEnrichment
            values={{ title, source, authors: allAuthors, year, abstract, doi, arxiv }}
            contextKey={metadataContextKey({ title, source, authors: allAuthors, year, abstract, doi, arxiv }, fileGeneration.current)}
            disabled={busy || inspectingPdf || resolving}
            onApply={fillSelectedMetadata}
          /> : <button
            type="button"
            disabled={resolving || !source.trim()}
            onClick={() => void resolveSource(source)}
          >
            {resolving ? "正在读取…" : "读取文献信息"}
          </button>}
          {!paper && (
            <div className={styles.notice}>
              可粘贴链接、DOI 或 arXiv，或选择本地 PDF。读取公开信息需要联网，也可直接手动填写。
            </div>
          )}
          <label className={styles.fileUpload}>
            本地 PDF
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => void choosePdf(e.target.files?.[0])}
            />
            {file && <span>{file.name}</span>}
          </label>
          {file && (
            <div className={styles.notice} role="status" aria-live="polite">
              {inspectingPdf
                ? "正在本机读取 PDF 文档信息与首页内容…"
                : autoCompletingPdf
                  ? "已识别文献标识，正在自动查询公开元数据…"
                  : "PDF 信息仅作为预填建议，请核对后保存。手工编辑的字段不会被覆盖。"}
              <details className={styles.technical}><summary>识别来源与查询详情</summary><div>
                {paper
                  ? "本地解析不上传文件；此已有文献仅填补未编辑的空白字段，不会自动联网。"
                  : "本地解析不上传文件。识别 DOI 或 arXiv 后，仅发送标识查询公开元数据。"}
              </div>
              {pdfQueryAttempted && !autoCompletingPdf && (
                <div>
                  已尝试按识别标识查询公开元数据；结果及失败原因见解析提示，本地候选仍保留。
                </div>
              )}
              {!inspectingPdf && Object.keys(pdfSources).length > 0 && (
                <div>文献信息识别参考来源（手填字段仍保持原值）：</div>
              )}
              {!inspectingPdf &&
                Object.entries(pdfSources).map(([field, origin]) => (
                  <div key={field}>
                    {(
                      {
                        title: "标题",
                        authors: "作者",
                        year: "年份",
                        doi: "DOI",
                        arxivId: "arXiv ID",
                      } as Record<string, string>
                    )[field] || field}
                    来源：{origin}
                  </div>
                ))}
              {pdfWarnings && <p>{pdfWarnings}</p>}
              {!inspectingPdf && identifier && (
                <>
                  <p>查询公开元数据时仅发送标识 {identifier}，不会上传 PDF。</p>
                  <button
                    type="button"
                    disabled={resolving}
                    onClick={() => void resolveSource(identifier, true)}
                  >
                    {resolving ? "正在查询公开元数据…" : "重新查询公开元数据"}
                  </button>
                </>
              )}</details>
            </div>
          )}
        </details>
      )}
      {warnings && <p className={styles.muted} role="status">{warnings}</p>}
      {showFields && <>
      <label>
        {dialog.kind === "paper"
          ? "文献标题"
          : dialog.kind === "topic"
            ? "研究问题"
            : "想法标题"}
        <input
          ref={titleInput}
          autoFocus={dialog.kind !== "paper"}
          aria-label="标题"
          value={title}
          onChange={(e) => setField("title", e.target.value)}
          placeholder={
            dialog.kind === "topic"
              ? "你正在探索什么问题？"
              : "给这条记录起个名字"
          }
        />
      </label>
      {dialog.kind === "paper" ? (
        <>
          <div className={styles.formColumns}>
            <label>
              作者
              <AuthorsInput value={authors} draft={authorDraft} disabled={busy}
                onChange={(value) => setField("authors", value)}
                onDraftChange={(value) => { touched.current.add("authors"); setAuthorDraft(value); }} />
            </label>
            <label>
              年份
              <input
                type="number"
                min="1000"
                max="3000"
                value={year}
                onChange={(e) => setField("year", e.target.value)}
              />
            </label>
          </div>
          <details className={styles.advanced} open={Boolean(paper)}><summary>更多信息 · 标识、标签与摘要</summary><div className={styles.formColumns}>
            <label>
              DOI
              <input
                value={doi}
                onChange={(e) => setField("doi", e.target.value)}
              />
            </label>
            <label>
              arXiv ID
              <input
                value={arxiv}
                onChange={(e) => setField("arxiv", e.target.value)}
              />
            </label>
          </div>
          <TagPicker existing={existingTagNames} value={tags} draft={tagDraft}
            onChange={setTags} onDraftChange={setTagDraft} disabled={busy} />
          <label>
            原文摘要
            <textarea
              value={abstract}
              onChange={(e) => setField("abstract", e.target.value)}
              rows={3}
            />
          </label>
          </details>
        </>
      ) : (
        <label>
          {dialog.kind === "topic" ? "问题描述" : "先写下一点想法"}
          <textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      )}
      </>}
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.formFooter}>
        {onCancel && <button type="button" disabled={busy} onClick={onCancel}>取消</button>}
        {creatingPaper && step === "details" && <button type="button" disabled={busy} onClick={() => setStep("source")}>上一步</button>}
        {creatingPaper && step === "source" ? <button type="button" className={styles.primary} disabled={busy || inspectingPdf || resolving} onClick={() => setStep("details")}>{source.trim() || file ? "下一步：核对信息" : "手动填写"}</button> :
        <button
          className={styles.primary}
          type="submit"
          disabled={
            busy || inspectingPdf || resolving
          }
        >
          {busy
            ? "正在保存…"
            : inspectingPdf
              ? "正在读取 PDF…"
              : file && !paper && resolving
                ? "正在补全文献信息…"
                : paper || topic
                  ? "保存修改"
                  : dialog.kind === "paper" ? "添加文献" : "创建"}
        </button>}
      </div>
    </form>
  );
}

function AuthorsInput({ value, draft, disabled, onChange, onDraftChange }: { value: string; draft: string; disabled: boolean; onChange: (value: string) => void; onDraftChange: (value: string) => void }) {
  const authors = value.split(/[;；\n]/).map((name) => name.trim()).filter(Boolean);
  const commit = () => { if (draft.trim()) onChange([...authors, ...draft.split(/[;；\n]/).map((name) => name.trim()).filter(Boolean)].join("; ")); };
  return <div className={styles.authorsInput}>
    <div className={styles.authorChips}>{authors.map((author, index) => <span key={`${author}-${index}`}>{author}<button type="button" aria-label={`移除作者 ${author}`} disabled={disabled} onClick={() => onChange(authors.filter((_, i) => i !== index).join("; "))}>×</button></span>)}</div>
    <input aria-label="添加作者" value={draft} disabled={disabled} placeholder="输入作者，按回车添加" onChange={(event) => onDraftChange(event.target.value)} onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); commit(); } }} />
  </div>;
}
