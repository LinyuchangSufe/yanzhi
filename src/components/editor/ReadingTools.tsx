"use client";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import TooltipButton from "../TooltipButton";
import styles from "./ReadingTools.module.css";

export default function ReadingTools({ label, children, upward = false }: { label: string; children: ReactNode; upward?: boolean }) {
  const [open, setOpen] = useState(false), root = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), id = useId();
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault(); setOpen(false); trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div ref={root} className={`${styles.root} ${upward ? styles.upward : ""}`} onBlur={(event) => { if (event.relatedTarget instanceof Node && !root.current?.contains(event.relatedTarget)) setOpen(false); }}>
    <TooltipButton ref={trigger} type="button" aria-expanded={open} aria-controls={id} title={label} onClick={() => setOpen(!open)}>{label}<ChevronDown size={14} /></TooltipButton>
    {open && <div ref={panel} id={id} role="region" aria-label={label} tabIndex={-1} className={styles.panel}
      onClick={(event) => { if (event.target instanceof Element && event.target.closest("button")) setOpen(false); }}>{children}</div>}
  </div>;
}
