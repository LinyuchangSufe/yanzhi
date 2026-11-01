"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { CitationPreview } from "./usePaperReferences";
import styles from "./PdfReader.module.css";
import { literatureReferenceQuery } from "../../lib/literature-links";

/** Read-only crop of the real bibliography. Opening/closing never navigates. */
export function ReferencePreview({ preview, document, pageLabel, onClose, onJump, onFindPaper }: {
  preview: CitationPreview;
  document: PDFDocumentProxy;
  pageLabel: string;
  onClose: () => void;
  onJump: () => void;
  onFindPaper?: (query: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState("");
  const { entry } = preview;
  useEffect(() => {
    let disposed = false;
    let task: RenderTask | undefined;
    setCopied(false);
    setStatus("正在载入原文预览…");
    void (async () => {
      const page = await document.getPage(entry.pageNumber);
      const canvas = canvasRef.current;
      if (disposed || !canvas) return;
      const viewport = page.getViewport({ scale: 1.6 });
      const [x, y] = viewport.convertToViewportPoint(entry.x, entry.y + 10);
      const sourceX = Math.max(0, x - 12);
      const sourceY = Math.max(0, y - 8);
      canvas.width = Math.min(660, Math.ceil(viewport.width - sourceX));
      canvas.height = Math.min(180, Math.ceil(viewport.height - sourceY));
      const context = canvas.getContext("2d");
      if (!context || canvas.width <= 0 || canvas.height <= 0) return;
      task = page.render({ canvas, canvasContext: context, viewport, transform: [1, 0, 0, 1, -sourceX, -sourceY] });
      await task.promise;
      if (!disposed) setStatus("");
    })().catch(() => { if (!disposed) setStatus("图像预览不可用，下面仍显示 PDF 原文条目。"); });
    return () => { disposed = true; task?.cancel(); };
  }, [document, entry]);
  return (
    <aside className={styles.referencePreview} data-reference-preview="true" aria-label="参考文献预览"
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <div className={styles.referenceHeader}>
        <strong>参考文献 · 第 {pageLabel} 页</strong>
        <button type="button" onClick={onClose} aria-label="关闭参考文献预览">×</button>
      </div>
      <div className={styles.referenceCrop}><canvas key={`${preview.attachmentId}:${entry.pageNumber}:${entry.y}`} ref={canvasRef} aria-label="参考文献原文截图" /></div>
      {status && <p className={styles.referenceStatus} role="status">{status}</p>}
      <p className={styles.referenceText}>{entry.text}</p>
      <div className={styles.referenceActions}>
        {onFindPaper && <button type="button" onClick={() => { onClose(); onFindPaper(literatureReferenceQuery(entry.text)); }}>查找并收藏文献</button>}
        <button type="button" onClick={onJump}>跳转原文</button>
        <button type="button" onClick={() => {
          void navigator.clipboard.writeText(entry.text).then(() => setCopied(true)).catch(() => setStatus("无法写入剪贴板，可以直接选择下方条目复制。"));
        }}>{copied ? "已复制" : "复制条目"}</button>
        <span>来自当前 PDF · 无需 AI</span>
      </div>
    </aside>
  );
}
