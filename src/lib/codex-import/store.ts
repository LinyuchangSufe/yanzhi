import { createHash, randomUUID } from "node:crypto";
import type { KBStore } from "../db";
import { StoreError } from "../store-error";
import { externalDiscussionContextSchema, externalDiscussionSchema } from "./schemas";
import type { CodexHistory, ExternalDiscussion, ExternalDiscussionContext, ExternalMessage } from "./types";

const stamp = () => new Date().toISOString();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const codexHistoryHash = (history: CodexHistory): string => digest({ threadId: history.thread.id, sourceId: history.source.id, turns: history.turns });
const contentHash = (threadId: string, selectedTurnIds: string[], messages: ExternalMessage[]) => digest({ threadId, selectedTurnIds, messages });
function retainedHistory(old: ExternalDiscussion) {
  if (old.history.length >= 200) throw new StoreError("此资料已保留 200 次修订，请另行导入后续内容；原快照保持不变", 422);
  return [...old.history, { revision: old.revision, hash: old.hash, title: old.title, messages: old.messages, sourceUpdatedAt: old.sourceUpdatedAt, capturedAt: old.refreshedAt, ...(old.turnStatuses ? { turnStatuses: old.turnStatuses } : {}) }];
}

export function initCodexImportSchema(store: KBStore): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS external_discussions (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    selection_key TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
    UNIQUE(source_id,thread_id,selection_key)
  );`);
}
function parseRow(row: Record<string, unknown>): ExternalDiscussion {
  return externalDiscussionSchema.parse(JSON.parse(String(row.data)));
}
export function externalDiscussionSnapshot(store: KBStore): ExternalDiscussion[] {
  return store.db.prepare("SELECT data FROM external_discussions ORDER BY rowid DESC").all().map(parseRow);
}
export function requireExternalDiscussion(store: KBStore, id: string): ExternalDiscussion {
  const row = store.db.prepare("SELECT data FROM external_discussions WHERE id=?").get(id);
  if (!row) throw new StoreError("已导入的讨论不存在", 404);
  return parseRow(row);
}
function verifyContext(store: KBStore, context: ExternalDiscussionContext, allowDeleted = false): ExternalDiscussionContext {
  const value = externalDiscussionContextSchema.parse(context);
  for (const [key, table] of [["paperIds", "papers"], ["topicIds", "topics"], ["noteIds", "notes"]] as const) {
    for (const id of value[key]) {
      const row = store.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
      if (!row || (!allowDeleted && table === "papers" && row.deleted_at)) throw new StoreError("关联材料不存在或已移入回收站，请重新选择", 409);
    }
  }
  return value;
}
function checked(value: ExternalDiscussion): ExternalDiscussion {
  const record = externalDiscussionSchema.parse(value);
  if (record.hash !== contentHash(record.threadId, record.selectedTurnIds, record.messages) || record.history.some((version) => version.hash !== contentHash(record.threadId, record.selectedTurnIds, version.messages)))
    throw new StoreError("外部讨论内容校验未通过，未写入资料", 422);
  return record;
}
function put(store: KBStore, value: ExternalDiscussion, insert: boolean, expectedRevision?: number): ExternalDiscussion {
  const record = checked(value);
  if (insert) store.db.prepare("INSERT INTO external_discussions(id,source_id,thread_id,selection_key,revision,data) VALUES(?,?,?,?,?,?)")
    .run(record.id, record.source.id, record.threadId, digest([...record.selectedTurnIds].sort()), record.revision, JSON.stringify(record));
  else if (!store.db.prepare("UPDATE external_discussions SET revision=?,data=? WHERE id=? AND revision=?")
    .run(record.revision, JSON.stringify(record), record.id, expectedRevision ?? 0).changes) throw new StoreError("讨论资料已在另一处更新，请刷新后重试", 409);
  return record;
}
/** Called inside KBStore.importSnapshot's transaction after base entities exist. */
export function importExternalDiscussions(store: KBStore, snapshot: readonly ExternalDiscussion[]): void {
  const seen = new Set<string>();
  for (const item of snapshot) {
    const value = checked(item);
    if (seen.has(value.id)) throw new StoreError("备份中外部讨论 ID 重复", 422);
    seen.add(value.id); verifyContext(store, { paperIds: value.paperIds, topicIds: value.topicIds, noteIds: value.noteIds }, true); put(store, value, true);
  }
}
function selected(history: CodexHistory, ids: readonly string[]): { selectedTurnIds: string[]; messages: ExternalMessage[] } {
  if (!history.complete) throw new StoreError("会话未完整读取，请重试后再导入", 422);
  const requested = new Set(ids);
  if (!requested.size || requested.size !== ids.length) throw new StoreError("请选择有效且不重复的轮次", 422);
  const turns = history.turns.filter((turn) => requested.has(turn.id));
  if (turns.length !== requested.size || turns.some((turn) => !turn.messages.length)) throw new StoreError("所选轮次已不存在或没有可导入的公开正文，请重新预览", 409);
  return { selectedTurnIds: turns.map((turn) => turn.id), messages: turns.flatMap((turn) => turn.messages) };
}
function transaction<T>(store: KBStore, work: () => T): T {
  store.db.exec("BEGIN IMMEDIATE");
  try { const result = work(); store.db.exec("COMMIT"); return result; } catch (error) { store.db.exec("ROLLBACK"); throw error; }
}
export function saveCodexDiscussion(store: KBStore, history: CodexHistory, turnIds: string[], context: ExternalDiscussionContext): { discussion: ExternalDiscussion; reused: boolean } {
  const selection = selected(history, turnIds);
  return transaction(store, () => {
    const links = verifyContext(store, context);
    const row = store.db.prepare("SELECT data FROM external_discussions WHERE source_id=? AND thread_id=? AND selection_key=?")
      .get(history.source.id, history.thread.id, digest([...selection.selectedTurnIds].sort()));
    if (row) {
      const old = parseRow(row);
      const merged = { paperIds: [...new Set([...old.paperIds, ...links.paperIds])], topicIds: [...new Set([...old.topicIds, ...links.topicIds])], noteIds: [...new Set([...old.noteIds, ...links.noteIds])] };
      const changed = JSON.stringify(merged) !== JSON.stringify({ paperIds: old.paperIds, topicIds: old.topicIds, noteIds: old.noteIds });
      return { discussion: changed ? put(store, { ...old, ...merged, revision: old.revision + 1, history: retainedHistory(old) }, false, old.revision) : old, reused: true };
    }
    const now = stamp();
    const record: ExternalDiscussion = { id: randomUUID(), title: history.thread.title || "Codex 讨论", threadId: history.thread.id,
      sourceHref: `codex://threads/${encodeURIComponent(history.thread.id)}`, source: history.source, ...selection, ...links,
      revision: 1, hash: contentHash(history.thread.id, selection.selectedTurnIds, selection.messages), importedAt: now, refreshedAt: now, sourceUpdatedAt: history.thread.updatedAt, history: [],
      turnStatuses: Object.fromEntries(history.turns.filter((turn) => selection.selectedTurnIds.includes(turn.id)).map((turn) => [turn.id, turn.status])) };
    return { discussion: put(store, record, true), reused: false };
  });
}
export function refreshCodexDiscussion(store: KBStore, id: string, revision: number, history: CodexHistory): { discussion: ExternalDiscussion; changed: boolean } {
  return transaction(store, () => {
    const old = requireExternalDiscussion(store, id);
    if (old.revision !== revision) throw new StoreError("讨论资料已更新，请重新打开后刷新", 409);
    if (history.thread.id !== old.threadId || history.source.id !== old.source.id) throw new StoreError("当前 Codex 主机或资料目录与导入来源不同，请恢复原来的 Codex profile 后重试", 409);
    const selection = selected(history, old.selectedTurnIds);
    // Keep the original selection order stable even if a provider changes its page ordering.
    const messages = old.selectedTurnIds.flatMap((turnId) => selection.messages.filter((message) => message.turnId === turnId));
    const hash = contentHash(old.threadId, old.selectedTurnIds, messages);
    const turnStatuses = Object.fromEntries(history.turns.filter((turn) => old.selectedTurnIds.includes(turn.id)).map((turn) => [turn.id, turn.status]));
    const changed = hash !== old.hash || history.thread.title !== old.title || JSON.stringify(turnStatuses) !== JSON.stringify(old.turnStatuses);
    const now = stamp();
    const record: ExternalDiscussion = { ...old, title: history.thread.title || old.title, messages, hash, revision: old.revision + 1,
      refreshedAt: now, sourceUpdatedAt: history.thread.updatedAt,
      history: retainedHistory(old), turnStatuses };
    return { discussion: put(store, record, false, revision), changed };
  });
}
export function linkExternalDiscussion(store: KBStore, id: string, revision: number, context: ExternalDiscussionContext): ExternalDiscussion {
  return transaction(store, () => { const old = requireExternalDiscussion(store, id); if (old.revision !== revision) throw new StoreError("资料关联已在另一处更新，请刷新后重试", 409); return put(store, { ...old, ...verifyContext(store, context), revision: revision + 1, history: retainedHistory(old) }, false, revision); });
}
/** The owning KB mutation already holds the transaction. No source content is removed. */
export function detachExternalDiscussionEntity(store: KBStore, kind: "paper" | "note" | "topic", id: string): void {
  const field = kind === "paper" ? "paperIds" : kind === "topic" ? "topicIds" : "noteIds";
  for (const old of externalDiscussionSnapshot(store)) {
    if (!old[field].includes(id)) continue;
    put(store, { ...old, [field]: old[field].filter((value) => value !== id), revision: old.revision + 1, history: retainedHistory(old) }, false, old.revision);
  }
}
export function resolveExternalDiscussionSource(store: KBStore, input: { discussionId: string; revision?: number; messageIds?: string[] }) {
  const discussion = requireExternalDiscussion(store, input.discussionId);
  const version = input.revision === undefined || input.revision === discussion.revision ? discussion : discussion.history.find((item) => item.revision === input.revision);
  if (!version) throw new StoreError("所引用的讨论修订不存在，请重新选择资料", 409);
  const ids = input.messageIds;
  const messages = ids ? version.messages.filter((message) => ids.includes(message.id)) : version.messages;
  if (ids && (!ids.length || new Set(ids).size !== ids.length || messages.length !== ids.length || new Set(messages.map((message) => message.id)).size !== messages.length)) throw new StoreError("所选讨论消息不完整或标识重复，请重新选择", 422);
  return { discussionId: discussion.id, revision: version.revision, title: version.title, sourceHref: discussion.sourceHref, hash: version.hash, messages,
    text: [Object.values(version.turnStatuses ?? {}).some((status) => status !== "completed") ? "来源说明：部分所选轮次在读取时尚未完整结束，以下只包含当时已公开的文本。" : "",
      ...messages.map((message) => `${message.role === "user" ? "用户" : "AI"}：${message.text}`)].filter(Boolean).join("\n\n") };
}
