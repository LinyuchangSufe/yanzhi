"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./AnnotationOverview.module.css";

/** Keep the comment editor mounted so closing tools never discards a draft. */
export default function AnnotationMore({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const [open, setOpen] = useState(false), root = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault(); setOpen(false); root.current?.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className={actions ? styles.inlineMore : undefined}>
    {actions && <div className={styles.footer}>{actions}</div>}
    <details ref={root} className={styles.more} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary aria-label="更多标注操作">更多</summary><div>{children}</div>
    </details>
  </div>;
}
