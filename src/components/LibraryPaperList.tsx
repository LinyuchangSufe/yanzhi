"use client";

import { useEffect, useState } from "react";
import { visibleSelection } from "../lib/reading-list-ui";
import type { WorkspaceController } from "./Workspace";
import baseStyles from "./Workspace.module.css";
import styles from "./styles/LibraryPaperList.module.css";

/** Selection belongs to one visible list, never to hidden or filtered records. */
export default function LibraryPaperList({ c }: { c: WorkspaceController }) {
  const { visiblePapers, section, topicFilter, tagFilter, missingOnly, sort, busy } = c;
  const scope = JSON.stringify([section, topicFilter, tagFilter, missingOnly, sort]);
  const [selection, setSelection] = useState<{ scope: string; ids: string[] }>({ scope, ids: [] });
  const visibleIds = visiblePapers.map((paper) => paper.id).join(",");
  useEffect(() => {
    const visible = new Set(visibleIds.split(","));
    setSelection((previous) => {
      const ids = previous.ids.filter((id) => visible.has(id));
      return ids.length === previous.ids.length ? previous : { ...previous, ids };
    });
  }, [visibleIds]);
  const selected = visibleSelection(visiblePapers, selection.scope === scope ? selection.ids : []);
  const ids = new Set(selected.map((paper) => paper.id));
  const selectable = visiblePapers.slice(0, 500);
  const all = selectable.length > 0 && selectable.every((paper) => ids.has(paper.id));
  const clear = () => setSelection({ scope, ids: [] });
  const toggle = (id: string) => setSelection({ scope, ids: ids.has(id)
    ? selected.filter((paper) => paper.id !== id).map((paper) => paper.id)
    : selected.length < 500 ? [...ids, id] : [...ids] });
  const apply = async (operation: "add" | "remove") => {
    const changing = selected.filter((paper) => operation === "add" ? !paper.inReadingList : paper.inReadingList);
    if (await c.changeReadingList(changing, operation)) clear();
  };

  return <div className={baseStyles.paperList}>
    {selected.length > 0 && <div className={styles.selectionBar} role="region" aria-label="已选文献操作">
      <strong role="status">已选 {selected.length} 篇</strong>
      {visiblePapers.length > 500 && <span>每次最多 500 篇</span>}
      {selected.some((paper) => !paper.inReadingList) && <button disabled={busy} onClick={() => void apply("add")}>加入待阅读</button>}
      {selected.some((paper) => paper.inReadingList) && <button disabled={busy} onClick={() => void apply("remove")}>移出待阅读</button>}
      <button className={styles.clear} disabled={busy} onClick={clear}>取消选择</button>
    </div>}
    <div className={`${baseStyles.listHeader} ${styles.listHeader}`}>
      <label className={styles.selectAll} title="只选择当前筛选下显示的文献，每次最多 500 篇">
        <input ref={(element) => {
          if (element) element.indeterminate = selected.length > 0 && !all;
        }} type="checkbox" aria-label={visiblePapers.length > 500 ? "选择当前显示的前 500 篇文献" : "全选当前显示的文献"} checked={all} disabled={busy}
          onChange={(event) => setSelection({ scope, ids: event.target.checked ? selectable.map((paper) => paper.id) : [] })} />
        <span>文献</span>
      </label>
      <span className={styles.columnHint}>最近修改</span>
    </div>
    {visiblePapers.map((paper) => c.paperRow(paper, undefined, {
      checked: ids.has(paper.id), disabled: !ids.has(paper.id) && selected.length >= 500, onToggle: () => toggle(paper.id),
    }))}
  </div>;
}
