"use client";
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import TooltipButton from "../TooltipButton";
import styles from "./ObjectActions.module.css";

export interface ObjectAction { label: string; onSelect: () => void | Promise<void>; disabled?: boolean; danger?: boolean }
export default function ObjectActions({ label, actions }: { label: string; actions: ObjectAction[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef(0);
  useEffect(() => {
    if (!open) return;
    const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    items()[initialFocus.current < 0 ? items().length - 1 : 0]?.focus();
    const outside = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("focusin", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className={styles.root} ref={root}>
    <TooltipButton ref={trigger} type="button" aria-label={label} tooltip={label} aria-haspopup="menu" aria-expanded={open}
      onClick={() => { initialFocus.current = 0; setOpen((value) => !value); }}
      onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); initialFocus.current = event.key === "ArrowUp" ? -1 : 0; setOpen(true); } }}><MoreHorizontal size={18} aria-hidden="true" /></TooltipButton>
    {open && <div ref={menu} role="menu" aria-label={label} className={styles.menu} onKeyDown={(event) => {
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (current + 1) % items.length : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
      if (next !== null) { event.preventDefault(); items[next]?.focus(); }
    }}>
      {actions.map((action, index) => <button key={action.label} type="button" role="menuitem" tabIndex={-1} disabled={action.disabled}
        className={`${action.danger ? styles.danger : ""} ${action.danger && !actions[index - 1]?.danger ? styles.dangerStart : ""}`}
        onClick={() => { setOpen(false); trigger.current?.focus(); void action.onSelect(); }}>{action.label}</button>)}
    </div>}
  </div>;
}
