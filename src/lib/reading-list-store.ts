import type { DatabaseSync } from "node:sqlite";
import { StoreError } from "./store-error";
import type { Paper, ReadingListOperation, ReadingStatus } from "./types";

/** One-time additive migration: preserve the old unread queue without changing progress. */
export function initializeReadingList(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const exists = db
      .prepare("PRAGMA table_info(papers)")
      .all()
      .some((column) => column.name === "in_reading_list");
    if (!exists) {
      db.exec(
        "ALTER TABLE papers ADD COLUMN in_reading_list INTEGER NOT NULL DEFAULT 0 CHECK(in_reading_list IN (0,1))",
      );
      db.exec(
        "UPDATE papers SET in_reading_list=1 WHERE reading_status='unread'",
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

interface ReadingListInput {
  papers: Pick<Paper, "id" | "revision">[];
  operation: ReadingListOperation;
}
interface StoredReadingState {
  reading_status: ReadingStatus;
  in_reading_list: number;
  revision: number;
  deleted_at: string | null;
}

function nextState(
  current: StoredReadingState,
  operation: ReadingListOperation,
) {
  let readingStatus = current.reading_status;
  let inReadingList = !!current.in_reading_list;
  switch (operation) {
    case "add":
      // Membership actions preserve legacy reading progress for old clients/backups.
      inReadingList = true;
      break;
    case "remove":
      inReadingList = false;
      break;
    case "read":
      readingStatus = "read";
      inReadingList = false;
      break;
    case "reading":
      readingStatus = "reading";
      inReadingList = true;
      break;
    case "unread":
      readingStatus = "unread";
      break;
  }
  return { readingStatus, inReadingList };
}

/** Called inside KBStore.dispatch's transaction. Validate every record before any write. */
export function applyReadingList(
  db: DatabaseSync,
  input: ReadingListInput,
  updatedAt: string,
): number {
  const lookup = db.prepare(
    "SELECT reading_status,in_reading_list,revision,deleted_at FROM papers WHERE id=?",
  );
  const planned = input.papers.map((paper) => {
    const current = lookup.get(paper.id) as unknown as
      StoredReadingState | undefined;
    if (!current)
      throw new StoreError("文献不存在，请重新加载列表。", 404, {
        id: paper.id,
      });
    if (current.deleted_at)
      throw new StoreError("文献已在回收站，请先恢复后修改阅读清单。", 409, {
        id: paper.id,
        trashed: true,
      });
    if (current.revision !== paper.revision)
      throw new StoreError(
        "文献已在其他窗口更新，本次批量操作未保存，请重新加载后重试。",
        409,
        { id: paper.id },
      );
    return { ...paper, current, ...nextState(current, input.operation) };
  });
  const update = db.prepare(
    "UPDATE papers SET reading_status=?,in_reading_list=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
  );
  let changed = 0;
  for (const entry of planned) {
    if (
      entry.readingStatus === entry.current.reading_status &&
      entry.inReadingList === !!entry.current.in_reading_list
    )
      continue;
    const result = update.run(
      entry.readingStatus,
      Number(entry.inReadingList),
      updatedAt,
      entry.id,
      entry.revision,
    );
    if (!result.changes)
      throw new StoreError("文献已在其他窗口更新，本次批量操作未保存。", 409, {
        id: entry.id,
      });
    changed++;
  }
  return changed;
}
