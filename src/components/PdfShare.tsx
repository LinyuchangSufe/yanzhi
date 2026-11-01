"use client";

import { Check, Copy, FolderOpen, LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { errorMessage, readResponse } from "./WorkspaceShared";
import styles from "./styles/PdfShare.module.css";

type ShareResult = {
  directory: string;
  files: { paperId: string; attachmentId: string; filename: string; path: string }[];
  missingCount: number;
  opened: boolean;
  warning?: string;
};

/** Owned by the workspace so closing a row menu never loses the request/result. */
export function usePdfShare() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ShareResult | null>(null);
  const [error, setError] = useState("");
  const [paperId, setPaperId] = useState<string>();
  const inFlight = useRef(false);

  const prepare = async (id?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOpen(true);
    setPending(true);
    setResult(null);
    setError("");
    setPaperId(id);
    try {
      const next: ShareResult = await readResponse(await fetch("/api/kb/pdf-share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(id ? { paperId: id } : {}), open: true }),
      }));
      setResult(next);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return { open, pending, result, error, paperId, prepare, close: () => setOpen(false) };
}

export type PdfShareController = ReturnType<typeof usePdfShare>;

export function PdfShareDialog({ share }: { share: PdfShareController }) {
  const modal = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const { open, pending, result, error, prepare, paperId, close } = share;

  useEffect(() => {
    const dialog = modal.current;
    if (open) {
      if (!dialog?.open) dialog?.showModal();
    } else dialog?.close();
  }, [open]);
  useEffect(() => { setCopied(false); setCopyError(""); }, [result]);

  return (
    <dialog ref={modal} className={styles.dialog} aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); close(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}>
      <header className={styles.heading}>
        <h2 id={titleId}><FolderOpen size={19} aria-hidden="true" />PDF 文件夹</h2>
        <button type="button" className={styles.close} aria-label="关闭 PDF 文件夹提示" onClick={close}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className={styles.body}>
        {pending && <p className={styles.status} role="status"><LoaderCircle size={17} className={styles.spin} aria-hidden="true" />正在整理 PDF 并打开本地文件夹…</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {result && <>
          <p className={styles.status} role="status"><Check size={17} aria-hidden="true" />已整理 {result.files.length} 个 PDF 副本{result.opened ? "，已打开本地文件夹。" : "。"}</p>
          <p className={styles.hint}>按“年份 · 第一作者 · 文献标题”命名，多份附件分别保留。可以直接从文件夹选取 PDF 发送给别人。</p>
          <div className={styles.path}>
            <span>分享文件夹</span>
            <code>{result.directory}</code>
          </div>
          {result.warning && <p className={styles.warning} role="status">{result.warning}</p>}
          {result.missingCount > 0 && <p className={styles.hint}>{result.missingCount} 篇文献还没有可用 PDF，可在文献的“添加 PDF 附件”中补充。</p>}
          <p className={styles.privacy}>这里只整理原 PDF 副本，知识库内单独保存的笔记、批注和 AI 内容不会打包。原文件保持原样。文件夹中的已有副本会保留，可自行整理。</p>
          {result.files.length > 0 && <details className={styles.files}>
            <summary>查看文件名（{result.files.length}）</summary>
            <ul>{result.files.map((file) => <li key={file.attachmentId}>{file.filename}</li>)}</ul>
          </details>}
        </>}
        {copyError && <p className={styles.error} role="alert">{copyError}</p>}
        <div className={styles.actions}>
          {result && <button type="button" onClick={async () => {
            try {
              await navigator.clipboard.writeText(result.directory);
              setCopied(true);
              setCopyError("");
            } catch {
              setCopyError("未能复制路径，请选中上方路径手动复制。");
            }
          }}><Copy size={14} aria-hidden="true" />{copied ? "路径已复制" : "复制文件夹路径"}</button>}
          {!pending && (error || (result && !result.opened)) && <button type="button" onClick={() => void prepare(paperId)}><FolderOpen size={14} aria-hidden="true" />{error ? "重试" : "重新打开文件夹"}</button>}
          <button type="button" onClick={close}>{pending ? "关闭" : "完成"}</button>
        </div>
      </div>
    </dialog>
  );
}
