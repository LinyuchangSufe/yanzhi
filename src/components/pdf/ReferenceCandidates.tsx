"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { ReferenceCandidate } from "../../lib/pdf-reference/resolver";
import type { PaperRefKind } from "../../lib/pdf-reference/paper-refs";
import type { ReferenceCandidatesPreview } from "./usePaperReferences";
import { referencePreviewGeometry } from "./reference-preview-geometry";
import styles from "./PdfReader.module.css";

const sourceLabels: Record<ReferenceCandidate["source"], string> = {
  outline: "PDF 目录", heading: "章节标题", caption: "图表说明", equation: "公式编号",
};
const kindLabels: Record<PaperRefKind, string> = {
  section: "章节", figure: "图", table: "表", equation: "公式", algorithm: "算法", appendix: "附录",
  theorem: "定理", lemma: "引理", proposition: "命题", definition: "定义", corollary: "推论",
};

/** Read the real page around a candidate; selecting a candidate never navigates. */
function CandidateCrop({ document, candidate }: { document: PDFDocumentProxy; candidate: ReferenceCandidate }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("正在载入原文预览…");
  useEffect(() => {
    let disposed = false;
    let task: RenderTask | undefined;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
    setStatus("正在载入原文预览…");
    void (async () => {
      const page = await document.getPage(candidate.target.pageNumber);
      if (disposed || !canvas || !context) return;
      const viewport = page.getViewport({ scale: Math.min(1.5, 1000 / page.getViewport({ scale: 1 }).width) });
      const geometry = referencePreviewGeometry(viewport, page.view, candidate.target, candidate.source);
      if (!geometry) throw new Error("Invalid PDF page dimensions");
      canvas.width = geometry.width;
      canvas.height = geometry.height;
      task = page.render({ canvas, canvasContext: context, viewport, transform: [1, 0, 0, 1, 0, -geometry.sourceY] });
      await task.promise;
      if (!disposed) setStatus("");
    })().catch(() => { if (!disposed) setStatus("截图暂不可用，可先核对候选页和下方原文。"); });
    return () => { disposed = true; task?.cancel(); };
  }, [document, candidate]);
  return <>
    <div className={styles.referenceCrop}><canvas ref={canvasRef} aria-label="候选位置原文截图" /></div>
    {status && <p className={styles.referenceStatus} role="status">{status}</p>}
  </>;
}

export function ReferenceCandidates({ preview, pageLabels, onClose, onJump }: {
  preview: ReferenceCandidatesPreview;
  pageLabels: readonly string[];
  onClose: () => void;
  onJump: (candidate: ReferenceCandidate) => void;
}) {
  const [selected, setSelected] = useState(0);
  const candidate = preview.candidates[selected] ?? preview.candidates[0];
  if (!candidate) return null;
  const pageDescription = (item: ReferenceCandidate) => {
    const number = item.target.pageNumber;
    const label = pageLabels[number - 1];
    return `物理第 ${number} 页${label && label !== String(number) ? ` · 页码 ${label}` : ""}`;
  };
  return (
    <aside className={styles.referencePreview} data-reference-candidates="true" aria-label="引用位置候选"
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <div className={styles.referenceHeader}>
        <strong>{kindLabels[preview.request.kind]} {preview.request.label} · 核对原文</strong>
        <button type="button" onClick={onClose} aria-label="关闭引用位置候选">×</button>
      </div>
      <p className={styles.referenceStatus}>{preview.reason ?? "请核对候选位置，确认后再跳转。"}</p>
      <div className={styles.referenceCandidates} role="group" aria-label="选择候选预览">
        {preview.candidates.map((item, index) => (
          <button key={`${item.target.pageNumber}:${item.target.left}:${item.target.top}:${index}`} type="button"
            aria-pressed={item === candidate} onClick={() => setSelected(index)}>
            <span>{pageDescription(item)} · {sourceLabels[item.source]}</span>
            <span>{item.text || "打开原文截图核对"}</span>
          </button>
        ))}
      </div>
      <p className={styles.referenceSelectedPage}>{pageDescription(candidate)} · 原文截图</p>
      <CandidateCrop key={`${preview.generation}:${selected}`} document={preview.document} candidate={candidate} />
      {candidate.text && <p className={styles.referenceText}>{candidate.text}</p>}
      <div className={styles.referenceActions}>
        <button type="button" onClick={() => onJump(candidate)}>跳转此处</button>
        <span>选择候选仅切换预览 · 阅读位置保持不变</span>
      </div>
    </aside>
  );
}
