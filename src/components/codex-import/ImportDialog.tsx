"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import styles from "./CodexImport.module.css";
export default function ImportDialog({ title, busy, onClose, children }: { title: string; busy?: boolean; onClose: () => void; children: ReactNode }) {
  const root = useRef<HTMLElement>(null), opener = useRef<HTMLElement | null>(typeof document === "undefined" ? null : document.activeElement as HTMLElement | null);
  const close = useRef({ busy, onClose }); close.current = { busy, onClose };
  useEffect(() => {
    const elements = () => [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length);
    const old = opener.current; elements()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) { event.preventDefault(); event.stopPropagation(); if (!close.current.busy) close.current.onClose(); }
      if (event.key !== "Tab") return;
      const fields = elements(), first = fields[0], last = fields.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); if (old?.isConnected) old.focus(); };
  }, []);
  return <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section ref={root} className={styles.dialog} role="dialog" aria-modal="true" aria-label={title}>
    <header><h2>{title}</h2><button type="button" aria-label="关闭 Codex 资料窗口" disabled={busy} onClick={onClose}><X size={18} /></button></header>{children}
  </section></div>;
}
