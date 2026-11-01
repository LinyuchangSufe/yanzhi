"use client";

import { useState } from "react";
import { Check, Copy, NotebookPen } from "lucide-react";
import Markdown from "./Markdown";
import styles from "./styles/SelectionAssistant.module.css";

/** A local, editable transfer draft; recognition never writes into personal notes. */
export default function MarkdownTransfer({ body, onNavigate, onInsert }: {
  body: string;
  onNavigate: (href: string) => void;
  onInsert: (body: string) => void;
}) {
  const [draft, setDraft] = useState(body);
  const [source, setSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function copy() {
    setError("");
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
    } catch {
      setSource(true);
      setError("剪贴板不可用，请在源码框中全选并复制。");
    }
  }
  return <div className={styles.transfer}>
    <p className={styles.recognitionHint}>根据 PDF 图像识别重建；并非作者原始 LaTeX。复制前请核对公式，尤其是上下标与特殊符号。</p>
    <div className={styles.transferModes} role="group" aria-label="识别结果显示方式">
      <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>预览</button>
      <button type="button" aria-pressed={source} onClick={() => setSource(true)}>Markdown 源码 / 修改</button>
    </div>
    {source ? <>
      <textarea className={styles.markdownSource} aria-label="Markdown 与 LaTeX 源码"
        spellCheck={false} value={draft} onChange={(event) => {
          setDraft(event.target.value); setCopied(false);
        }} />
      <p className={styles.sourceEditHint}>修改用于本次复制或引用；原识别记录保留。</p>
    </> : <div className={styles.answer}><Markdown body={draft} onNavigate={onNavigate} /></div>}
    <div className={styles.actions}>
      <button type="button" className={styles.primary} disabled={!draft.trim()} onClick={() => void copy()}>
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        {copied ? "已复制 Markdown" : "复制 Markdown + LaTeX"}
      </button>
      <button type="button" disabled={!draft.trim()} onClick={() => onInsert(draft)}>
        <NotebookPen size={13} aria-hidden="true" />添加到笔记
      </button>
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {copied && <span className={styles.copyStatus} role="status">已复制源码，可粘贴到笔记编辑区。</span>}
  </div>;
}
