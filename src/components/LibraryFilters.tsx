"use client";

import { ChevronDown, ListFilter, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceController } from "./Workspace";
import styles from "./styles/LibraryFilters.module.css";

/** Keep the library quiet while making every applied condition visible. */
export default function LibraryFilters({ c }: { c: WorkspaceController }) {
  const { state, topicFilter, tagFilter, missingOnly, sort,
    setTopicFilter, setTagFilter, setMissingOnly, setSort } = c;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const count = Number(Boolean(topicFilter)) + Number(Boolean(tagFilter)) + Number(missingOnly);
  const topicName = state.topics.find((topic) => topic.id === topicFilter)?.title || "研究问题";
  const tagName = state.tags.find((tag) => tag.id === tagFilter)?.name || "标签";
  const clearCondition = (update: () => void) => { update(); trigger.current?.focus(); };
  const clear = () => clearCondition(() => { setTopicFilter(""); setTagFilter(""); setMissingOnly(false); });

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return <div className={styles.toolbar}>
    <details ref={root} open={open} className={styles.root}
      onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary ref={trigger} className={styles.trigger}>
        <ListFilter size={16} aria-hidden="true" />
        筛选{count > 0 && <span className={styles.count}>{count}</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className={styles.panel} role="group" aria-label="文献筛选条件">
        <div className={styles.panelHeading}><strong>筛选文献</strong>
          <button type="button" disabled={!count} onClick={clear}>重置</button>
        </div>
        <label>研究问题
          <select aria-label="研究问题筛选" value={topicFilter} onChange={(event) => setTopicFilter(event.target.value)}>
            <option value="">全部研究问题</option>
            {state.topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.title}</option>)}
          </select>
        </label>
        <label>标签
          <select aria-label="标签筛选" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
            <option value="">全部标签</option>
            {state.tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
          </select>
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={missingOnly} onChange={(event) => setMissingOnly(event.target.checked)} />待补 PDF
        </label>
      </div>
    </details>
    <div className={styles.conditions} aria-label="已启用的筛选条件">
      {topicFilter && <button type="button" aria-label={`清除研究问题筛选：${topicName}`} onClick={() => clearCondition(() => setTopicFilter(""))}>
        {topicName}<X size={12} aria-hidden="true" />
      </button>}
      {tagFilter && <button type="button" aria-label={`清除标签筛选：${tagName}`} onClick={() => clearCondition(() => setTagFilter(""))}>
        #{tagName}<X size={12} aria-hidden="true" />
      </button>}
      {missingOnly && <button type="button" aria-label="清除待补 PDF 筛选" onClick={() => clearCondition(() => setMissingOnly(false))}>
        待补 PDF<X size={12} aria-hidden="true" />
      </button>}
    </div>
    <select aria-label="排序" className={styles.sort} value={sort}
      title={sort === "recent" ? "按本浏览器的打开记录排序；未打开的文献仍显示。" : undefined}
      onChange={(event) => setSort(event.target.value)}>
      <option value="newest">添加时间</option>
      <option value="recent">最近打开优先</option>
      <option value="updated">最近修改</option>
      <option value="title">标题 A–Z</option>
    </select>
  </div>;
}
