"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import {
  matchingTagNames,
  normalizeTagNames,
  submittedTagNames,
  toggleTagName,
} from "../lib/tag-selection";
import styles from "./styles/TagPicker.module.css";

export default function TagPicker({
  existing,
  value,
  draft,
  onChange,
  onDraftChange,
  disabled = false,
}: {
  existing: string[];
  value: string[];
  draft: string;
  onChange: (value: string[]) => void;
  onDraftChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const selected = normalizeTagNames(value, existing);
  const options = matchingTagNames(existing, query);
  const commitDraft = () => {
    if (!draft.trim()) return;
    onChange(submittedTagNames(value, draft, existing));
    onDraftChange("");
  };

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  return (
    <div className={styles.picker} ref={root} role="group" aria-labelledby={`${id}-label`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          toggle.current?.focus();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}>
      <div className={styles.heading}>
        <span id={`${id}-label`}>标签</span>
        <button ref={toggle} type="button" className={styles.toggle}
          aria-expanded={open} aria-controls={`${id}-options`} disabled={disabled}
          onClick={() => {
            setQuery("");
            setOpen(!open);
          }}>
          选择已有标签 <ChevronDown size={13} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div id={`${id}-options`} className={styles.dropdown}>
          <input ref={search} type="search" aria-label="搜索已有标签"
            value={query} onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
            placeholder="搜索标签…" disabled={disabled} />
          <div className={styles.options} role="group" aria-label="已有标签">
            {options.map((name) => (
              <label key={name} className={styles.option}>
                <input type="checkbox" checked={selected.includes(name)} disabled={disabled}
                  onChange={() => onChange(toggleTagName(value, name, existing))} />
                <span>{name}</span>
              </label>
            ))}
            {!options.length && <p className={styles.empty}>
              {existing.length ? "没有匹配的标签，可在下方输入新标签。" : "暂无标签，可在下方输入第一个标签。"}
            </p>}
          </div>
        </div>
      )}
      {selected.length > 0 && (
        <div className={styles.selected} aria-label="已选标签">
          {selected.map((name) => (
            <button type="button" key={name} className={styles.chip} disabled={disabled}
              aria-label={`移除标签 ${name}`} onClick={() => onChange(toggleTagName(value, name, existing))}>
              <span>{name}</span><X size={12} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      <input className={styles.newTag} aria-label="新标签" aria-describedby={`${id}-hint`}
        value={draft} disabled={disabled} onChange={(event) => onDraftChange(event.target.value)}
        onBlur={commitDraft} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            commitDraft();
          }
        }} placeholder="输入新标签，按 Enter 添加；多个用逗号分隔" />
      <small id={`${id}-hint`} className={styles.hint}>勾选已有标签或手动输入；新标签随文献一起保存。</small>
    </div>
  );
}
