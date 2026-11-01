import type { KBStore } from "../db";
import { StoreError } from "../store-error";
import { researchItemRequestSchema, researchItemSchema } from "./schemas";
import { researchSourceKey, resolveResearchSource, resolveResearchSources, validateResearchSource } from "./sources";
import type { ResearchItem } from "./types";

export function initResearchItemSchema(store: KBStore) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS research_items (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL, archived_at TEXT, data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE INDEX IF NOT EXISTS research_items_topic ON research_items(topic_id, archived_at);`);
}
function requireTopic(store: KBStore, id: string) {
  if (!store.db.prepare("SELECT id FROM topics WHERE id=?").get(id)) throw new StoreError("研究问题不存在", 404);
}
export function researchItemsSnapshot(store: KBStore, topicId?: string): ResearchItem[] {
  return store.db.prepare(`SELECT data FROM research_items${topicId ? " WHERE topic_id=?" : ""} ORDER BY json_extract(data,'$.updatedAt') DESC,id DESC`).all(...(topicId ? [topicId] : []))
    .map(value => researchItemSchema.parse(JSON.parse(String(value.data))));
}
export function requireResearchItem(store: KBStore, id: string): ResearchItem {
  const value = store.db.prepare("SELECT data FROM research_items WHERE id=?").get(id);
  if (!value) throw new StoreError("待核验条目不存在", 404); return researchItemSchema.parse(JSON.parse(String(value.data)));
}
export function mutateResearchItem(store: KBStore, raw: unknown): ResearchItem {
  const input = researchItemRequestSchema.parse(raw);
  if (input.action === "preview") throw new StoreError("预览不会写入待核验清单", 400);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    let item: ResearchItem;
    if (input.action === "create") {
      requireTopic(store, input.topicId);
      const existing = store.db.prepare("SELECT data FROM research_items WHERE id=?").get(input.id);
      if (existing) {
        item = researchItemSchema.parse(JSON.parse(String(existing.data)));
        if (item.topicId !== input.topicId || item.title !== input.title || item.body !== input.body || item.nextAction !== input.nextAction || JSON.stringify(item.sourceRefs.map(source => source.input)) !== JSON.stringify(input.sourceRefs)) throw new StoreError("这个请求 ID 已用于不同的待核验条目", 409);
      } else {
        const at = new Date().toISOString();
        item = researchItemSchema.parse({ id: input.id, topicId: input.topicId, title: input.title, body: input.body, nextAction: input.nextAction,
          sourceRefs: resolveResearchSources(store, input.sourceRefs), resultRefs: [], resolution: "", status: "pending", revision: 1, createdAt: at, updatedAt: at, archivedAt: null });
        store.db.prepare("INSERT INTO research_items(id,topic_id,revision,archived_at,data) VALUES(?,?,?,?,?)").run(item.id, item.topicId, item.revision, null, JSON.stringify(item));
      }
    } else {
      const previous = requireResearchItem(store, input.id);
      if (previous.revision !== input.revision) throw new StoreError("待核验条目已在其他位置更新，请刷新后再修改；当前输入保留", 409);
      if (input.action === "update" && previous.archivedAt) throw new StoreError("请先恢复已归档条目再编辑", 409);
      if (input.action === "update" && input.topicId) requireTopic(store, input.topicId);
      const at = new Date().toISOString();
      const retained = new Map([...previous.sourceRefs, ...previous.resultRefs].map(source => [source.id, source]));
      const resolve = (values: Parameters<typeof resolveResearchSources>[1]) => values.map(value => { const saved = retained.get(researchSourceKey(value)); return saved ? validateResearchSource(store, saved) : resolveResearchSource(store, value); });
      const changes = input.action === "update" ? { ...input, ...(input.sourceRefs ? { sourceRefs: resolve(input.sourceRefs) } : {}), ...(input.resultRefs ? { resultRefs: resolve(input.resultRefs) } : {}) } : { archivedAt: input.action === "archive" ? at : null };
      const { action: _action, ...fields } = changes as typeof changes & { action?: string };
      item = researchItemSchema.parse({ ...previous, ...fields, revision: previous.revision + 1, updatedAt: at });
      const changed = store.db.prepare("UPDATE research_items SET topic_id=?,revision=?,archived_at=?,data=? WHERE id=? AND revision=?").run(item.topicId, item.revision, item.archivedAt, JSON.stringify(item), item.id, input.revision);
      if (changed.changes !== 1) throw new StoreError("待核验条目已更新，请刷新", 409);
    }
    store.db.exec("COMMIT"); return item;
  } catch (error) { store.db.exec("ROLLBACK"); throw error; }
}
/** Called after core entities and imported discussions are restored, inside the outer import transaction. */
export function importResearchItems(store: KBStore, snapshot: { researchItems?: ResearchItem[] }) {
  store.db.exec("SAVEPOINT research_items_import");
  try {
  const values = (snapshot.researchItems ?? []).map(value => researchItemSchema.parse(value));
  if (new Set(values.map(value => value.id)).size !== values.length) throw new StoreError("待核验条目 ID 重复", 400);
  for (const item of values) {
    requireTopic(store, item.topicId);
    for (const source of [...item.sourceRefs, ...item.resultRefs]) validateResearchSource(store, source);
  }
  for (const item of values) store.db.prepare("INSERT INTO research_items(id,topic_id,revision,archived_at,data) VALUES(?,?,?,?,?)").run(item.id, item.topicId, item.revision, item.archivedAt, JSON.stringify(item));
  store.db.exec("RELEASE research_items_import");
  } catch (error) { store.db.exec("ROLLBACK TO research_items_import; RELEASE research_items_import"); throw error; }
}
/** Includes archived items: restoring one must not lose its sources. */
export function researchItemReferences(store: KBStore, kind: string, id: string): string[] {
  const topicNoteId = kind === "topic" ? store.db.prepare("SELECT note_id FROM topics WHERE id=?").get(id)?.note_id : undefined;
  return researchItemsSnapshot(store).filter(item => (kind === "topic" && item.topicId === id) || [...item.sourceRefs, ...item.resultRefs].some(source => {
    const input = source.input;
    return (kind === "note" && (input.kind === "note" || input.kind === "noteSelection") && input.id === id) ||
      (kind === "topic" && (input.kind === "note" || input.kind === "noteSelection") && input.id === topicNoteId) ||
      (kind === "annotation" && input.kind === "annotation" && input.id === id) ||
      (kind === "ai" && (input.kind === "guideEvidence" || input.kind === "guideQuestion") && input.id === id) ||
      (kind === "externalDiscussion" && input.kind === "externalDiscussion" && input.id === id) ||
      (kind === "paper" && source.paperId === id) || (kind === "attachment" && source.attachmentId === id);
  })).map(item => item.id);
}
