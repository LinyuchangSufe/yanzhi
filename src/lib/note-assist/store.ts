import { randomUUID } from "node:crypto";
import type { KBStore } from "../db";
import type { Note } from "../types";
import { StoreError } from "../store-error";
import { sourceLinks } from "../source-links";
import {
  assertSafeInsertion,
  buildRevisedText,
  validateEdits,
  noteMarkupReferences,
} from "./patches";
import {
  noteAssistanceSchema,
  noteRevisionSchema,
  noteAssistApplySchema,
  noteRevisionRestoreSchema,
} from "./schemas";
import type { NoteAssistance, NoteRevision } from "./types";

export function initializeNoteAssistance(store: KBStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS note_assists (
      id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id),
      created_at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
    );
    CREATE INDEX IF NOT EXISTS note_assists_note ON note_assists(note_id,created_at);
    CREATE TABLE IF NOT EXISTS note_revisions (
      id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id),
      note_revision INTEGER NOT NULL CHECK(note_revision>0),
      created_at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
    );
    CREATE INDEX IF NOT EXISTS note_revisions_note ON note_revisions(note_id,created_at);
  `);
}
function currentNote(store: KBStore, id: string): Note {
  const row = store.db
    .prepare(
      "SELECT id,title,body,purpose,revision,created_at,updated_at FROM notes WHERE id=?",
    )
    .get(id);
  if (!row) throw new StoreError("笔记不存在", 404);
  return {
    id: String(row.id),
    title: String(row.title),
    body: String(row.body),
    purpose: row.purpose as Note["purpose"],
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
export function noteAssistanceSnapshot(store: KBStore): NoteAssistance[] {
  return store.db
    .prepare("SELECT data FROM note_assists ORDER BY created_at DESC,id DESC")
    .all()
    .map((row) => noteAssistanceSchema.parse(JSON.parse(String(row.data))));
}
export function noteRevisionSnapshot(store: KBStore): NoteRevision[] {
  return store.db
    .prepare("SELECT data FROM note_revisions ORDER BY created_at DESC,id DESC")
    .all()
    .map((row) => noteRevisionSchema.parse(JSON.parse(String(row.data))));
}
export function captureNoteRevision(
  store: KBStore,
  note: Note,
  reason: NoteRevision["reason"],
): NoteRevision {
  const current = currentNote(store, note.id);
  if (
    current.revision !== note.revision ||
    current.title !== note.title ||
    current.body !== note.body
  )
    throw new StoreError(
      "笔记已更新，请保存并重新读取后重试；当前正文未改变",
      409,
    );
  const previous = matchingRevisions(store, note.id, note.revision).find(
    (r) =>
      r.title === note.title && r.body === note.body && r.reason === reason,
  );
  if (previous) return previous;
  const record = noteRevisionSchema.parse({
    id: randomUUID(),
    noteId: note.id,
    noteRevision: note.revision,
    title: note.title,
    body: note.body,
    reason,
    createdAt: new Date().toISOString(),
  });
  // One conditional INSERT also protects against another local process updating between reads.
  const inserted = store.db
    .prepare(
      "INSERT INTO note_revisions(id,note_id,note_revision,created_at,data) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM notes WHERE id=? AND revision=? AND title=? AND body=?)",
    )
    .run(
      record.id,
      record.noteId,
      record.noteRevision,
      record.createdAt,
      JSON.stringify(record),
      note.id,
      note.revision,
      note.title,
      note.body,
    );
  if (!inserted.changes)
    throw new StoreError("笔记已更新，未保存过期快照", 409);
  return record;
}
function exists(
  store: KBStore,
  table:
    | "notes"
    | "papers"
    | "attachments"
    | "annotations"
    | "topics"
    | "ai_contents"
    | "tags"
    | "note_images",
  id: string,
): boolean {
  return !!store.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id);
}
function matchingRevisions(
  store: KBStore,
  noteId: string,
  revision: number,
): NoteRevision[] {
  return store.db
    .prepare(
      "SELECT data FROM note_revisions WHERE note_id=? AND note_revision=?",
    )
    .all(noteId, revision)
    .map((row) => noteRevisionSchema.parse(JSON.parse(String(row.data))));
}
function validateRecord(store: KBStore, record: NoteAssistance): void {
  const current = currentNote(store, record.noteId);
  if (
    record.baseRevision > current.revision ||
    record.lastAppliedRevision < record.baseRevision ||
    record.lastAppliedRevision > current.revision
  )
    throw new StoreError("AI 建议的笔记版本无效", 422);
  validateEdits(record.baseBody, record.selection, record.result.edits);
  buildRevisedText(record);
  if (record.mode === "advise" && record.result.edits.length)
    throw new StoreError("研究建议不得修改原稿", 422);
  if (
    !record.sources.some(
      (source) =>
        source.kind === "note" &&
        source.noteId === record.noteId &&
        source.text === (record.selection?.text ?? record.baseBody),
    )
  )
    throw new StoreError("AI 建议缺少与原稿一致的笔记来源", 422);
  if (
    new Set(record.paperIds).size !== record.paperIds.length ||
    new Set(record.ideaIds).size !== record.ideaIds.length
  )
    throw new StoreError("AI 建议包含重复上下文", 422);
  for (const id of record.paperIds)
    if (!exists(store, "papers", id))
      throw new StoreError("AI 建议文献来源不存在", 422);
  for (const id of record.ideaIds) {
    const idea = currentNote(store, id);
    if (idea.purpose !== "idea" || id === record.noteId)
      throw new StoreError("AI 建议想法来源无效", 422);
  }
  const sourceIds = new Set<string>();
  for (const source of record.sources) {
    if (sourceIds.has(source.id))
      throw new StoreError("AI 建议包含重复来源 ID", 422);
    sourceIds.add(source.id);
    if (source.noteId && !exists(store, "notes", source.noteId))
      throw new StoreError("AI 建议笔记来源不存在", 422);
    if (source.kind === "note" && source.noteId !== record.noteId)
      throw new StoreError("AI 原稿来源不属于当前笔记", 422);
    if (
      source.kind === "idea" &&
      (!source.noteId || !record.ideaIds.includes(source.noteId))
    )
      throw new StoreError("AI 想法来源未获选择", 422);
    if (
      (source.kind === "paper-abstract" || source.kind === "pdf-evidence") &&
      (!source.paperId || !record.paperIds.includes(source.paperId))
    )
      throw new StoreError("AI 文献来源未获选择", 422);
    if (source.attachmentId) {
      const attachment = store.db
        .prepare("SELECT paper_id,sha256 FROM attachments WHERE id=?")
        .get(source.attachmentId);
      if (
        !attachment ||
        attachment.paper_id !== source.paperId ||
        attachment.sha256 !== source.attachmentSha256 ||
        source.pageIndex === undefined
      )
        throw new StoreError("AI 证据与附件来源不一致", 422);
    } else if (source.kind === "pdf-evidence")
      throw new StoreError("AI PDF 证据缺少附件定位", 422);
  }
  for (const suggestion of record.result.suggestions) {
    if (suggestion.evidenceIds.some((id) => !sourceIds.has(id)))
      throw new StoreError("AI 建议引用了不存在的来源", 422);
    if (
      suggestion.basis === "literature" &&
      !suggestion.evidenceIds.some((id) =>
        record.sources.some(
          (s) =>
            s.id === id && ["paper-abstract", "pdf-evidence"].includes(s.kind),
        ),
      )
    )
      throw new StoreError("文献判断必须保留文献来源", 422);
  }
  const savedBase = matchingRevisions(
    store,
    record.noteId,
    record.baseRevision,
  ).some((r) => r.title === record.baseTitle && r.body === record.baseBody);
  if (!savedBase) throw new StoreError("AI 建议缺少对应的原稿快照", 422);
}
export function saveNoteAssistance(
  store: KBStore,
  input: NoteAssistance,
): NoteAssistance {
  const record = noteAssistanceSchema.parse(input);
  if (
    record.appliedEdits.length ||
    record.lastAppliedRevision !== record.baseRevision
  )
    throw new StoreError("新生成建议不得携带已采纳状态", 422);
  validateRecord(store, record);
  store.db
    .prepare(
      "INSERT INTO note_assists(id,note_id,created_at,data) VALUES(?,?,?,?)",
    )
    .run(record.id, record.noteId, record.createdAt, JSON.stringify(record));
  return record;
}
export function importNoteAssistance(
  store: KBStore,
  assists: NoteAssistance[],
  revisions: NoteRevision[],
): void {
  for (const value of revisions) {
    const r = noteRevisionSchema.parse(value);
    if (r.noteRevision > currentNote(store, r.noteId).revision)
      throw new StoreError("历史快照版本超出当前笔记", 422);
    store.db
      .prepare(
        "INSERT INTO note_revisions(id,note_id,note_revision,created_at,data) VALUES(?,?,?,?,?)",
      )
      .run(r.id, r.noteId, r.noteRevision, r.createdAt, JSON.stringify(r));
  }
  for (const value of assists) {
    const r = noteAssistanceSchema.parse(value);
    validateRecord(store, r);
    store.db
      .prepare(
        "INSERT INTO note_assists(id,note_id,created_at,data) VALUES(?,?,?,?)",
      )
      .run(r.id, r.noteId, r.createdAt, JSON.stringify(r));
  }
}
interface PreparedApply {
  update: { id: string; revision: number; body: string };
  assistance: NoteAssistance;
}
function assertFresh(note: Note, revision: number): void {
  if (note.revision !== revision)
    throw new StoreError(
      "笔记已在其他窗口更新，请重新加载后重试；当前正文未改变",
      409,
    );
}
function safeInsertedReferences(
  store: KBStore,
  body: string,
  record: NoteAssistance,
): void {
  const markup = noteMarkupReferences(body);
  if (markup.hasImages || markup.hasHtml)
    throw new StoreError(
      "AI 建议不能插入新图片或 HTML，请使用编辑器手动插图",
      422,
    );
  const allowed = new Set(
    record.sources.flatMap((source) => noteMarkupReferences(source.text).urls),
  );
  for (const source of record.sources) {
    if (source.paperId) allowed.add(`kb://paper/${source.paperId}`);
    if (source.noteId) allowed.add(`kb://note/${source.noteId}`);
    if (source.kind === "topic" && /^topic:[0-9a-f-]{36}$/i.test(source.id))
      allowed.add(`kb://topic/${source.id.slice(6)}`);
  }
  if (markup.urls.some((url) => !url.startsWith("#") && !allowed.has(url)))
    throw new StoreError(
      "AI 建议含未提供的来源链接，请重新生成或手动核对",
      422,
    );
  const tables = {
    paper: "papers",
    note: "notes",
    annotation: "annotations",
    topic: "topics",
    ai: "ai_contents",
    tag: "tags",
  } as const;
  for (const ref of sourceLinks(body))
    if (!exists(store, tables[ref.type], ref.id))
      throw new StoreError("建议含不存在的库内引用，请手动核对", 422);
}
/** Called inside KBStore.dispatch's existing transaction; never starts a nested transaction. */
export function prepareNoteAssistanceApply(
  store: KBStore,
  input: unknown,
): PreparedApply {
  const p = noteAssistApplySchema.parse(input);
  const note = currentNote(store, p.noteId);
  assertFresh(note, p.revision);
  const row = store.db
    .prepare("SELECT data FROM note_assists WHERE id=? AND note_id=?")
    .get(p.assistanceId, p.noteId);
  if (!row) throw new StoreError("此 AI 建议不属于当前笔记", 404);
  const assistance = noteAssistanceSchema.parse(JSON.parse(String(row.data)));
  let body: string;
  if (p.operation === "insert") {
    const suggestion = assistance.result.suggestions[p.suggestionIndex!];
    if (!suggestion) throw new StoreError("建议段落不存在", 404);
    const position = p.position ?? note.body.length;
    assertSafeInsertion(note.body, position);
    const content = `### ${suggestion.title}\n\n${suggestion.body}`;
    safeInsertedReferences(store, content, assistance);
    const left = note.body.slice(0, position),
      right = note.body.slice(position);
    body =
      left +
      (left && !left.endsWith("\n\n") ? "\n\n" : "") +
      content +
      (right && !right.startsWith("\n\n") ? "\n\n" : "") +
      right;
  } else {
    if (
      note.revision !== assistance.lastAppliedRevision ||
      note.title !== assistance.baseTitle ||
      note.body !== buildRevisedText(assistance)
    )
      throw new StoreError(
        "原稿在生成后已有新修改。为保护新输入，不能直接采纳这份改稿；可重新生成或手动合并",
        409,
      );
    const indices =
      p.operation === "all"
        ? assistance.result.edits.map((_, i) => i)
        : [p.editIndex!];
    if (indices.some((i) => !assistance.result.edits[i]))
      throw new StoreError("修改段落不存在", 404);
    const fresh = indices.filter((i) => !assistance.appliedEdits.includes(i));
    if (!fresh.length) throw new StoreError("这些修改已经采纳", 409);
    assistance.appliedEdits = [...assistance.appliedEdits, ...fresh].sort(
      (a, b) => a - b,
    );
    body = buildRevisedText(assistance);
  }
  if (body.length > 2_000_000)
    throw new StoreError("采纳后的笔记超过容量上限", 413);
  captureNoteRevision(store, note, "before-apply");
  return { update: { id: note.id, revision: note.revision, body }, assistance };
}
export function finalizeNoteAssistanceApply(
  store: KBStore,
  prepared: PreparedApply,
  updated: Note,
): void {
  const assistance = {
    ...prepared.assistance,
    lastAppliedRevision: updated.revision,
  };
  store.db
    .prepare("UPDATE note_assists SET data=? WHERE id=? AND note_id=?")
    .run(JSON.stringify(assistance), assistance.id, assistance.noteId);
}
export function prepareNoteRevisionRestore(
  store: KBStore,
  input: unknown,
): { id: string; revision: number; title: string; body: string } {
  const p = noteRevisionRestoreSchema.parse(input);
  const note = currentNote(store, p.noteId);
  assertFresh(note, p.revision);
  const row = store.db
    .prepare("SELECT data FROM note_revisions WHERE id=? AND note_id=?")
    .get(p.snapshotId, p.noteId);
  if (!row) throw new StoreError("此历史版本不属于当前笔记", 404);
  const snapshot = noteRevisionSchema.parse(JSON.parse(String(row.data)));
  // Historical human text may legitimately contain unresolved or since-deleted links.
  // Keep it verbatim; note.update indexes only existing entities and the renderer guards resources.
  captureNoteRevision(store, note, "before-restore");
  return {
    id: note.id,
    revision: note.revision,
    title: snapshot.title,
    body: snapshot.body,
  };
}
