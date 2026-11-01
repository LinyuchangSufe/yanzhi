"use client";

import { Download, Ellipsis, ExternalLink, FilePlus, FolderOpen, Link2, Link2Off, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { Paper } from "../lib/types";
import { paperSource } from "../lib/paper-actions";
import styles from "./styles/PaperRowActions.module.css";

type Props = {
  paper: Paper;
  busy: boolean;
  hasPdf: boolean;
  sharing: boolean;
  onEdit: () => void;
  onLink: () => void;
  onUpload: (file: File) => void;
  onFetch: () => void;
  onShowPdf: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onUnlink?: () => void;
};

/** A top-layer popover remains visible above the clipped, scrollable paper list. */
export default function PaperRowActions({ paper, busy, hasPdf, sharing, onEdit, onLink, onUpload, onFetch, onShowPdf, onTrash, onRestore, onUnlink }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const firstFocus = useRef<"first" | "last">("first");
  const source = paperSource(paper);
  const close = (returnFocus = false) => {
    menu.current?.hidePopover();
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  };
  const show = (focus: "first" | "last" = "first") => {
    if (busy) return;
    document.querySelectorAll<HTMLElement>("[data-paper-row-actions]:popover-open")
      .forEach((other) => { if (other !== menu.current) other.hidePopover(); });
    firstFocus.current = focus;
    menu.current?.showPopover();
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const fields = menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)');
    (firstFocus.current === "last" ? fields?.[fields.length - 1] : fields?.[0])?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        close(true);
      }
    };
    // Closing on scroll keeps the menu attached to the row even without CSS anchors.
    const move = (event: Event) => {
      if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", move, true);
    window.addEventListener("resize", move);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", move, true);
      window.removeEventListener("resize", move);
    };
  }, [open]);
  useEffect(() => { if (busy) close(); }, [busy]);
  const action = (callback: () => void) => { close(true); callback(); };
  const itemTitle = (label: string) => `${label}：${paper.title}`;

  return (
    <div ref={root} className={styles.root}>
      <button
        ref={trigger} type="button" className={styles.trigger}
        disabled={busy} title={itemTitle("更多文献操作")}
        aria-label={itemTitle("更多文献操作")} aria-haspopup="menu"
        aria-expanded={open} aria-controls={id}
        onClick={(event) => { event.stopPropagation(); open ? close(true) : show(); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); show(event.key === "ArrowUp" ? "last" : "first");
          }
        }}
      ><Ellipsis size={18} aria-hidden="true" /></button>
      <div
        ref={menu} id={id} popover="manual" role="menu" data-paper-row-actions
        className={styles.menu} aria-label={itemTitle("文献操作")}
        onToggle={(event) => setOpen(event.newState === "open")}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Tab") { setTimeout(() => close(), 0); return; }
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const fields = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
          const index = fields.indexOf(document.activeElement as HTMLElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? fields.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + fields.length) % fields.length;
          fields[next]?.focus();
        }}
      >
        <p className={styles.heading} title={paper.title}>{paper.title}</p>
        {paper.deletedAt ? (
          <button role="menuitem" tabIndex={-1} title={itemTitle("恢复文献")} disabled={busy} onClick={() => action(onRestore)}>
            <RotateCcw size={15} aria-hidden="true" />恢复文献
          </button>
        ) : <>
          <button role="menuitem" tabIndex={-1} aria-label="编辑文献信息" title={itemTitle("编辑文献信息")} disabled={busy} onClick={() => action(onEdit)}><Pencil size={15} aria-hidden="true" />编辑信息</button>
          <button role="menuitem" tabIndex={-1} title={itemTitle("关联问题与想法")} disabled={busy} onClick={() => action(onLink)}><Link2 size={15} aria-hidden="true" />关联问题与想法</button>
          {onUnlink && <button role="menuitem" tabIndex={-1} disabled={busy} onClick={() => action(onUnlink)}><Link2Off size={15} aria-hidden="true" />移除当前关联</button>}
          <hr />
          <button role="menuitem" tabIndex={-1} title={itemTitle("添加 PDF 附件")} disabled={busy} onClick={() => action(() => input.current?.click())}><FilePlus size={15} aria-hidden="true" />添加 PDF 附件</button>
          <button role="menuitem" tabIndex={-1} title={source ? itemTitle("从来源获取 PDF") : "请先编辑文献信息，添加来源链接、DOI 或 arXiv 标识"} disabled={busy || !source} onClick={() => action(onFetch)}><Download size={15} aria-hidden="true" />从来源获取 PDF</button>
          <button role="menuitem" tabIndex={-1} title={hasPdf ? itemTitle("整理格式化命名的 PDF 副本，并在本地文件夹中显示") : "这篇文献还没有本地 PDF，请先添加 PDF 附件"} disabled={busy || sharing || !hasPdf} onClick={() => action(onShowPdf)}><FolderOpen size={15} aria-hidden="true" />在文件夹中显示 PDF</button>
          {source ? <a role="menuitem" tabIndex={-1} title={itemTitle("打开原始来源")} href={source} target="_blank" rel="noopener noreferrer" onClick={() => close(true)}><ExternalLink size={15} aria-hidden="true" />打开原始来源</a>
            : <button role="menuitem" tabIndex={-1} disabled title="请先编辑文献信息，添加来源链接、DOI 或 arXiv 标识"><ExternalLink size={15} aria-hidden="true" />打开原始来源</button>}
          <hr />
          <button role="menuitem" tabIndex={-1} className={styles.trash} title={itemTitle("移入回收站，可恢复")} disabled={busy} onClick={() => action(onTrash)}><Trash2 size={15} aria-hidden="true" />移入回收站</button>
        </>}
      </div>
      <input ref={input} type="file" hidden accept="application/pdf,.pdf" aria-label={itemTitle("添加 PDF 附件")}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onUpload(file);
        }} />
    </div>
  );
}
