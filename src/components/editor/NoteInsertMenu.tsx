"use client";

import { ChevronDown, ImagePlus, Library, Plus, Sigma } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import TooltipButton from "../TooltipButton";
import styles from "../styles/NoteEditor.module.css";

export default function NoteInsertMenu({ open, onOpenChange, disabled, mathDisabled, onMath, onImage, onReference }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  mathDisabled: boolean;
  onMath: () => void;
  onImage: () => void;
  onReference: () => void;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const change = useRef(onOpenChange); change.current = onOpenChange;
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) change.current(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault(); change.current(false); trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const choose = (action: () => void) => { onOpenChange(false); action(); };
  return <div className={styles.insertMenu}>
    <TooltipButton ref={trigger} type="button" aria-label="插入内容" aria-expanded={open} aria-controls={id}
      title="插入公式、图片或文献引用" disabled={disabled} onClick={() => onOpenChange(!open)}>
      <Plus size={16} aria-hidden="true" />插入<ChevronDown size={13} aria-hidden="true" />
    </TooltipButton>
    {open && <div ref={panel} id={id} className={styles.insertDropdown} role="region" aria-label="插入内容选项">
      <TooltipButton type="button" disabled={mathDisabled} aria-label="插入行内公式" aria-keyshortcuts="Control+M"
        title="插入行内公式：$…$（Control + M）" onClick={() => choose(onMath)}><Sigma size={16} />公式 <kbd>Ctrl + M</kbd></TooltipButton>
      <TooltipButton type="button" disabled={disabled} aria-label="插入图片" title="插入图片，也可粘贴或拖入"
        onClick={() => choose(onImage)}><ImagePlus size={16} />图片</TooltipButton>
      <TooltipButton type="button" disabled={disabled} aria-label="引用文献" title="引用文献：输入 [[ 搜索文献库"
        onClick={() => choose(onReference)}><Library size={16} />引用文献</TooltipButton>
    </div>}
  </div>;
}
