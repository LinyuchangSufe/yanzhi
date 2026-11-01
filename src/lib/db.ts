import { StoreError } from "./store-error";
import { initializePaperChat, paperChatSnapshot, importPaperChats } from "./paper-chat/store";
import { initializeIdeaLab, ideaConversationSnapshot, ideaSummarySnapshot, importIdeaLab } from "./idea-lab/store";
import { prepareIdeaSummaryApply, finalizeIdeaSummaryApply } from "./idea-lab/apply";
import { captureNoteRevision } from "./note-assist/store";
import { initializeReadingList, applyReadingList } from "./reading-list-store";
import { initializeResearchKnowledge, researchKnowledgeSnapshot, importExternalDiscussions, importResearchItems, protectResearchDeletion } from "./research-integration";
import { normalizeIdentifiers } from "./import/normalize-identifiers";
export { normalizeIdentifiers } from "./import/normalize-identifiers";
import { searchState } from "./search";
import {
  initializeNoteAssistance,
  noteAssistanceSnapshot,
  noteRevisionSnapshot,
  importNoteAssistance,
  prepareNoteAssistanceApply,
  finalizeNoteAssistanceApply,
  prepareNoteRevisionRestore,
} from "./note-assist/store";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { sourceLinks } from "./source-links";
import { aggregateTextSegments } from "./annotation-segments";
import { initializeNoteImages, noteImageSnapshot, importNoteImages } from "./note-images";
import { validateGuideSources } from "./guide/storage-validation";
import {
  actionSchemas,
  aiSchema,
  snapshotSchema,
  uuid,
  type Action,
} from "./validation";
import type {
  AIContent,
  Annotation,
  Attachment,
  EntityType,
  KBState,
  Note,
  Paper,
  Relation,
  Settings,
  Topic,
} from "./types";

export { StoreError } from "./store-error";
type Row = Record<string, unknown>;
const entityTables: Record<EntityType, string> = {
  paper: "papers",
  annotation: "annotations",
  note: "notes",
  topic: "topics",
  ai: "ai_contents",
  tag: "tags",
};
const jsonColumns = new Set([
  "authors",
  "rects",
  "source_page_indices",
  "scale",
  "guide_data",
  "text_segments",
]);
const toSnake = (key: string) =>
  key.replace(/[A-Z]/g, (s) => `_${s.toLowerCase()}`);
const toCamel = (key: string) =>
  key.replace(/_([a-z])/g, (_, s: string) => s.toUpperCase());
const now = () => new Date().toISOString();
function decode<T>(row: Row): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      toCamel(key),
      jsonColumns.has(key) && typeof value === "string"
        ? (JSON.parse(value) as unknown)
        : key === "in_reading_list"
          ? !!value
          : value,
    ]),
  ) as T;
}
function encode(value: unknown, key: string): SQLInputValue {
  if (jsonColumns.has(key)) return JSON.stringify(value);
  if (key === "in_reading_list" && typeof value === "boolean")
    return Number(value);
  if (value === null || typeof value === "string" || typeof value === "number")
    return value;
  throw new StoreError(`无效数据库字段 ${key}`);
}


export class KBStore {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(this.dataDir, "attachments"), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(path.join(this.dataDir, "notes"), {
      recursive: true,
      mode: 0o700,
    });
    this.db = new DatabaseSync(path.join(this.dataDir, "knowledge.sqlite"));
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
    const candidates = [
      "migrations/001.sql",
      "local/migrations/001.sql",
      "app/local/migrations/001.sql",
    ].map((p) => path.resolve(p));
    const migration = candidates.find(existsSync);
    if (!migration)
      throw new StoreError("缺少 migrations/001.sql，请从项目根目录启动", 500);
    this.db.exec(readFileSync(migration, "utf8"));
    // Additive migration: old libraries and old backups keep all existing data.
    if (
      !this.db
        .prepare("PRAGMA table_info(papers)")
        .all()
        .some((column) => column.name === "deleted_at")
    )
      this.db.exec(
        "ALTER TABLE papers ADD COLUMN deleted_at TEXT DEFAULT NULL",
      );
    initializeReadingList(this.db);
    const settingsColumns = this.db
      .prepare("PRAGMA table_info(settings)")
      .all();
    if (!settingsColumns.some((column) => column.name === "codex_model"))
      this.db.exec(
        "ALTER TABLE settings ADD COLUMN codex_model TEXT NOT NULL DEFAULT ''",
      );
    const aiColumns = this.db.prepare("PRAGMA table_info(ai_contents)").all();
    if (!aiColumns.some((column) => column.name === "guide_data"))
      this.db.exec(
        "ALTER TABLE ai_contents ADD COLUMN guide_data TEXT DEFAULT NULL",
      );
    const annotationColumns = this.db
      .prepare("PRAGMA table_info(annotations)")
      .all();
    if (!annotationColumns.some((column) => column.name === "text_segments"))
      this.db.exec(
        "ALTER TABLE annotations ADD COLUMN text_segments TEXT DEFAULT NULL",
      );
    initializeNoteImages(this);
    initializeNoteAssistance(this);
    initializePaperChat(this);
    initializeIdeaLab(this);
    initializeResearchKnowledge(this);
    // SQLite is authoritative. Recreate human-readable mirrors after a crash/restore.
    for (const note of this.all<Note>("notes")) this.writeNote(note);
  }
  close() {
    this.db.close();
  }
  private all<T>(table: string): T[] {
    return this.db
      .prepare(`SELECT * FROM ${table}`)
      .all()
      .map((row) => decode<T>(row as Row));
  }
  private get<T>(table: string, id: string): T {
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new StoreError("对象不存在或已移除", 404, { id });
    return decode<T>(row as Row);
  }
  private insert(table: string, data: Row) {
    const keys = Object.keys(data).map(toSnake);
    this.db
      .prepare(
        `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
      )
      .run(
        ...Object.entries(data).map(([key, value]) =>
          encode(value, toSnake(key)),
        ),
      );
  }
  private update(table: string, id: string, revision: number, data: Row) {
    const entries = Object.entries(data).filter(
      ([key]) => key !== "id" && key !== "revision",
    );
    const result = this.db
      .prepare(
        `UPDATE ${table} SET ${entries.map(([key]) => `${toSnake(key)}=?`).join(",")},revision=revision+1 WHERE id=? AND revision=?`,
      )
      .run(
        ...entries.map(([key, value]) => encode(value, toSnake(key))),
        id,
        revision,
      );
    if (!result.changes) {
      this.get(table, id);
      throw new StoreError(
        "内容已在其他窗口更新，请重新加载后合并。当前输入尚未保存。",
        409,
        { id },
      );
    }
  }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private writeNote(note: Note) {
    const target = path.join(this.dataDir, "notes", `${note.id}.md`);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temp,
        `<!-- kb-note:${note.id} revision:${note.revision} purpose:${note.purpose} -->\n# ${note.title}\n\n${note.body}\n`,
        { mode: 0o600 },
      );
      renameSync(temp, target);
    } catch (error) {
      if (existsSync(temp)) unlinkSync(temp);
      throw error;
    }
  }
  private entity(type: EntityType, id: string) {
    return this.get(entityTables[type], id);
  }
  private relation(
    fromType: EntityType,
    fromId: string,
    toType: EntityType,
    toId: string,
    purpose: Relation["purpose"] = "manual",
  ) {
    this.entity(fromType, fromId);
    this.entity(toType, toId);
    const found = this.db
      .prepare(
        "SELECT * FROM relations WHERE from_type=? AND from_id=? AND to_type=? AND to_id=? AND purpose=?",
      )
      .get(fromType, fromId, toType, toId, purpose);
    if (found) return decode<Relation>(found as Row);
    const relation: Relation = {
      id: randomUUID(),
      fromType,
      fromId,
      toType,
      toId,
      purpose,
      createdAt: now(),
    };
    this.insert("relations", relation as unknown as Row);
    return relation;
  }
  private syncReferences(note: Note) {
    this.db
      .prepare(
        "DELETE FROM relations WHERE from_type='note' AND from_id=? AND purpose='reference'",
      )
      .run(note.id);
    for (const { type, id } of sourceLinks(note.body)) {
      // Keep unresolved links readable in Markdown; index real source objects only.
      const found = this.db
        .prepare(`SELECT id FROM ${entityTables[type]} WHERE id=?`)
        .get(id);
      if (found) this.relation("note", note.id, type, id, "reference");
    }
  }
  private createNote(input: {
    title: string;
    body: string;
    purpose: Note["purpose"];
    paperIds?: string[];
    topicIds?: string[];
  }) {
    const stamp = now();
    const note: Note = {
      id: randomUUID(),
      title: input.title,
      body: input.body,
      purpose: input.purpose,
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.insert("notes", note as unknown as Row);
    for (const paperId of input.paperIds ?? [])
      this.relation("note", note.id, "paper", paperId);
    for (const topicId of input.topicIds ?? [])
      this.relation("note", note.id, "topic", topicId);
    this.syncReferences(note);
    this.writeNote(note);
    return note;
  }
  private setTags(paperId: string, names: string[]) {
    this.db
      .prepare(
        "DELETE FROM relations WHERE from_type='paper' AND from_id=? AND to_type='tag' AND purpose='tag'",
      )
      .run(paperId);
    for (const name of new Set(names)) {
      const found = this.db
        .prepare("SELECT * FROM tags WHERE name=? COLLATE NOCASE")
        .get(name);
      const tag = found
        ? decode<{ id: string; name: string }>(found as Row)
        : { id: randomUUID(), name };
      if (!found) this.insert("tags", tag);
      this.relation("paper", paperId, "tag", tag.id, "tag");
    }
  }
  snapshot(query?: string): KBState {
    const row = this.db
      .prepare("SELECT * FROM settings WHERE id=1")
      .get() as Row;
    const settings = decode<Settings & { id: number }>(row);
    const { id: _settingsId, ...settingsData } = settings;
    const state: KBState = {
      papers: this.all<Paper>("papers").sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
      attachments: this.all<Omit<Attachment, "status">>("attachments").map(
        (a) => ({
          ...a,
          status: existsSync(path.join(this.dataDir, a.relativePath))
            ? ("available" as const)
            : ("missing" as const),
        }),
      ),
      annotations: this.all("annotations"),
      notes: this.all("notes"),
      noteImages: noteImageSnapshot(this),
      noteAssists: noteAssistanceSnapshot(this),
      noteRevisions: noteRevisionSnapshot(this),
      chatConversations: paperChatSnapshot(this),
      ideaConversations: ideaConversationSnapshot(this),
      ideaSummaries: ideaSummarySnapshot(this),
      ...researchKnowledgeSnapshot(this),
      topics: this.all("topics"),
      aiContents: this.all("ai_contents"),
      tags: this.all("tags"),
      relations: this.all("relations"),
      readingPositions: this.all("reading_positions"),
      settings: settingsData,
    };
    if (query !== undefined) state.searchResults = searchState(state, query);
    return state;
  }
  dispatch(action: Action, payload: unknown): unknown {
    if (!(action in actionSchemas)) throw new StoreError("不支持的操作");
    // Validate before opening a transaction; no free-form SQL is accepted.
    const validated = actionSchemas[action].parse(payload);
    const oldNotes = new Map(
      this.all<Note>("notes").map((note) => [note.id, note]),
    );
    try {
      return this.transaction(() => this.mutate(action, validated));
    } catch (error) {
      // Rollback exported mirrors as well when a transaction fails after a write.
      for (const note of oldNotes.values()) this.writeNote(note);
      throw error;
    }
  }
  private mutate(action: Action, payload: unknown): unknown {
    switch (action) {
      case "paper.create": {
        const p = actionSchemas[action].parse(payload);
        const ids = normalizeIdentifiers(p);
        const duplicate = this.db
          .prepare(
            "SELECT id,deleted_at FROM papers WHERE (doi != '' AND doi=?) OR (arxiv_id != '' AND arxiv_id=?)",
          )
          .get(ids.doi, ids.arxivId);
        if (duplicate)
          throw new StoreError(
            duplicate.deleted_at
              ? "这篇文献已在回收站，请先恢复已有记录。"
              : "这篇文献已存在，请打开已有记录补充附件。",
            409,
            { existingPaperId: duplicate.id, trashed: !!duplicate.deleted_at },
          );
        const stamp = now();
        const paper: Paper = {
          id: randomUUID(),
          title: p.title,
          authors: p.authors ?? [],
          year: p.year ?? null,
          abstract: p.abstract ?? "",
          sourceUrl: p.sourceUrl ?? "",
          ...ids,
          readingStatus: p.readingStatus ?? "unread",
          inReadingList:
            p.readingStatus === "read" ? false : (p.inReadingList ?? false),
          deletedAt: null,
          revision: 1,
          createdAt: stamp,
          updatedAt: stamp,
        };
        this.insert("papers", paper as unknown as Row);
        this.setTags(paper.id, p.tags ?? []);
        this.createNote({
          title: `${paper.title} · 研究笔记`,
          body: "",
          purpose: "paper",
          paperIds: [paper.id],
        });
        return paper;
      }
      case "paper.update": {
        const { id, revision, tags, ...changes } =
          actionSchemas[action].parse(payload);
        const old = this.get<Paper>("papers", id);
        if (old.deletedAt)
          throw new StoreError("文献已在回收站，请先恢复后编辑。", 409, {
            existingPaperId: id,
            trashed: true,
          });
        const ids = normalizeIdentifiers({ ...old, ...changes });
        if (changes.readingStatus === "read") changes.inReadingList = false;
        else if (
          changes.inReadingList === true &&
          old.readingStatus === "read" &&
          !changes.readingStatus
        )
          changes.readingStatus = "unread";
        const duplicate = this.db
          .prepare(
            "SELECT id,deleted_at FROM papers WHERE id != ? AND ((doi != '' AND doi=?) OR (arxiv_id != '' AND arxiv_id=?))",
          )
          .get(id, ids.doi, ids.arxivId);
        if (duplicate)
          throw new StoreError(
            duplicate.deleted_at
              ? "标识与回收站中的文献重复，请先恢复已有记录。"
              : "标识与已有文献重复",
            409,
            {
              existingPaperId: duplicate.id,
              trashed: !!duplicate.deleted_at,
            },
          );
        this.update("papers", id, revision, {
          ...changes,
          ...ids,
          updatedAt: now(),
        });
        if (tags) this.setTags(id, tags);
        return this.get<Paper>("papers", id);
      }
      case "paper.reading-list": {
        const input = actionSchemas[action].parse(payload);
        const changed = applyReadingList(this.db, input, now());
        return {
          papers: input.papers.map((paper) =>
            this.get<Paper>("papers", paper.id),
          ),
          changed,
        };
      }
      case "paper.trash":
      case "paper.restore": {
        const { id, revision } = actionSchemas[action].parse(payload);
        const paper = this.get<Paper>("papers", id);
        const trash = action === "paper.trash";
        if (trash === !!paper.deletedAt)
          throw new StoreError(
            trash ? "文献已在回收站。" : "文献已恢复，请重新加载列表。",
            409,
            { id },
          );
        const stamp = now();
        this.update("papers", id, revision, {
          deletedAt: trash ? stamp : null,
          updatedAt: stamp,
        });
        return this.get<Paper>("papers", id);
      }
      case "note.create":
        return this.createNote(actionSchemas[action].parse(payload));
      case "idea.summary.apply": {
        const prepared = prepareIdeaSummaryApply(this, payload);
        if (prepared.existing) return prepared.existing;
        let note: Note;
        if (prepared.update) {
          captureNoteRevision(this, this.get<Note>("notes", prepared.update.id), "before-apply");
          note = this.mutate("note.update", prepared.update) as Note;
        } else if (prepared.create) note = this.createNote(prepared.create);
        else throw new StoreError("没有可采纳的整理内容", 422);
        try { finalizeIdeaSummaryApply(this, prepared, note); }
        catch (error) {
          if (prepared.create) { try { unlinkSync(path.join(this.dataDir, "notes", `${note.id}.md`)); } catch {} }
          throw error;
        }
        return note;
      }
      case "note.assist.apply": {
        const prepared = prepareNoteAssistanceApply(this, payload);
        const updated = this.mutate("note.update", prepared.update) as Note;
        finalizeNoteAssistanceApply(this, prepared, updated);
        return updated;
      }
      case "note.revision.restore":
        return this.mutate(
          "note.update",
          prepareNoteRevisionRestore(this, payload),
        );
      case "note.update": {
        const { id, revision, ...changes } =
          actionSchemas[action].parse(payload);
        this.update("notes", id, revision, { ...changes, updatedAt: now() });
        const note = this.get<Note>("notes", id);
        this.syncReferences(note);
        this.writeNote(note);
        return note;
      }
      case "topic.create": {
        const p = actionSchemas[action].parse(payload);
        const stamp = now();
        const note = this.createNote({
          title: `${p.title} · 综合笔记`,
          body: "",
          purpose: "topic",
        });
        const topic: Topic = {
          id: randomUUID(),
          title: p.title,
          description: p.description,
          noteId: note.id,
          revision: 1,
          createdAt: stamp,
          updatedAt: stamp,
        };
        this.insert("topics", topic as unknown as Row);
        this.relation("note", note.id, "topic", topic.id);
        return topic;
      }
      case "topic.update": {
        const { id, revision, ...changes } =
          actionSchemas[action].parse(payload);
        this.update("topics", id, revision, { ...changes, updatedAt: now() });
        return this.get<Topic>("topics", id);
      }
      case "topic.delete": {
        const { id } = actionSchemas[action].parse(payload);
        const topic = this.get<Topic>("topics", id);
        protectResearchDeletion(this, "topic", id);
        this.db
          .prepare(
            "DELETE FROM relations WHERE (from_type='topic' AND from_id=?) OR (to_type='topic' AND to_id=?)",
          )
          .run(id, id);
        this.db.prepare("DELETE FROM topics WHERE id=?").run(id);
        const note = this.get<Note>("notes", topic.noteId);
        this.update("notes", note.id, note.revision, {
          purpose: "idea",
          updatedAt: now(),
        });
        this.writeNote(this.get<Note>("notes", note.id));
        return { id, noteId: note.id };
      }
      case "annotation.create": {
        const p = actionSchemas[action].parse(payload);
        this.requireAttachment(p.paperId, p.attachmentId);
        const stamp = now();
        const annotation: Annotation = {
          id: randomUUID(),
          paperId: p.paperId,
          attachmentId: p.attachmentId,
          kind: p.kind,
          pageIndex: p.pageIndex,
          pageLabel: p.pageLabel ?? String(p.pageIndex + 1),
          rects: p.rects,
          selectedText: p.selectedText ?? "",
          textSegments: p.textSegments ?? null,
          comment: p.comment ?? "",
          color: p.color ?? "#f8df72",
          revision: 1,
          createdAt: stamp,
          updatedAt: stamp,
        };
        if (annotation.textSegments)
          Object.assign(
            annotation,
            aggregateTextSegments(annotation.textSegments),
          );
        this.insert("annotations", annotation as unknown as Row);
        return annotation;
      }
      case "annotation.update": {
        const { id, revision, ...changes } =
          actionSchemas[action].parse(payload);
        const current = this.get<Annotation>("annotations", id);
        const effective = { ...current, ...changes };
        if (effective.textSegments) {
          if (effective.kind !== "highlight")
            throw new StoreError("只有文字高亮可以包含多个文字选段");
          Object.assign(changes, aggregateTextSegments(effective.textSegments));
        }
        this.update("annotations", id, revision, {
          ...changes,
          updatedAt: now(),
        });
        return this.get<Annotation>("annotations", id);
      }
      case "annotation.delete": {
        const { id } = actionSchemas[action].parse(payload);
        this.get("annotations", id);
        protectResearchDeletion(this, "annotation", id);
        const refs = this.db
          .prepare(
            "SELECT from_id FROM relations WHERE to_type='annotation' AND to_id=? AND purpose='reference'",
          )
          .all(id);
        if (refs.length)
          throw new StoreError(
            "批注已被笔记引用，请先移除引用后再删除。",
            409,
            { noteIds: refs.map((r) => r.from_id) },
          );
        this.db
          .prepare(
            "DELETE FROM relations WHERE (from_type='annotation' AND from_id=?) OR (to_type='annotation' AND to_id=?)",
          )
          .run(id, id);
        this.db.prepare("DELETE FROM annotations WHERE id=?").run(id);
        return { id };
      }
      case "link.set": {
        const p = actionSchemas[action].parse(payload);
        return this.relation(p.fromType, p.fromId, p.toType, p.toId, p.purpose);
      }
      case "link.unset": {
        const p = actionSchemas[action].parse(payload);
        this.db
          .prepare(
            "DELETE FROM relations WHERE from_type=? AND from_id=? AND to_type=? AND to_id=? AND purpose=?",
          )
          .run(p.fromType, p.fromId, p.toType, p.toId, p.purpose);
        return p;
      }
      case "settings.update": {
        const p = actionSchemas[action].parse(payload);
        const entries = Object.entries(p);
        if (entries.length)
          this.db
            .prepare(
              `UPDATE settings SET ${entries.map(([key]) => `${toSnake(key)}=?`).join(",")} WHERE id=1`,
            )
            .run(...entries.map(([key, value]) => encode(value, toSnake(key))));
        return this.snapshot().settings;
      }
      case "reading.set": {
        const p = actionSchemas[action].parse(payload);
        this.requireAttachment(p.paperId, p.attachmentId);
        this.db
          .prepare(
            "INSERT INTO reading_positions(attachment_id,paper_id,page_index,scale,rotation,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(attachment_id) DO UPDATE SET page_index=excluded.page_index,scale=excluded.scale,rotation=excluded.rotation,updated_at=excluded.updated_at",
          )
          .run(
            p.attachmentId,
            p.paperId,
            p.pageIndex,
            JSON.stringify(p.scale),
            p.rotation,
            now(),
          );
        return p;
      }
    }
  }
  private requireAttachment(paperId: string, attachmentId: string) {
    const attachment = this.get<Attachment>("attachments", attachmentId);
    if (attachment.paperId !== paperId)
      throw new StoreError("附件不属于当前文献");
    return attachment;
  }
  addAttachment(
    paperId: string,
    filename: string,
    bytes: Uint8Array,
  ): Attachment {
    uuid.parse(paperId);
    const paper = this.get<Paper>("papers", paperId);
    if (paper.deletedAt)
      throw new StoreError("文献已在回收站，请先恢复后添加附件。", 409, {
        existingPaperId: paperId,
        trashed: true,
      });
    if (
      bytes.byteLength < 5 ||
      bytes.byteLength > 100 * 1024 * 1024 ||
      Buffer.from(bytes).subarray(0, 5).toString() !== "%PDF-"
    )
      throw new StoreError("附件必须是100 MiB以内的有效PDF文件");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.db
      .prepare("SELECT * FROM attachments WHERE sha256=?")
      .get(sha256);
    if (existing) {
      const attachment = decode<Omit<Attachment, "status">>(existing as Row);
      const owner = this.get<Paper>("papers", attachment.paperId);
      if (owner.deletedAt)
        throw new StoreError(
          "相同 PDF 已在回收站中的文献里，请先恢复已有记录。",
          409,
          {
            existingPaperId: owner.id,
            attachmentId: attachment.id,
            trashed: true,
          },
        );
      if (attachment.paperId !== paperId)
        throw new StoreError("相同PDF已在另一篇文献中，请使用已有档案。", 409, {
          existingPaperId: attachment.paperId,
          attachmentId: attachment.id,
        });
      const target = path.join(this.dataDir, attachment.relativePath);
      if (!existsSync(target)) this.atomicFile(target, bytes);
      else if (
        createHash("sha256").update(readFileSync(target)).digest("hex") !==
        sha256
      )
        throw new StoreError(
          "原附件内容已在外部改变，请先移走损坏文件，再上传相同原件恢复。",
          409,
        );
      return { ...attachment, status: "available" };
    }
    const id = randomUUID();
    const relativePath = `attachments/${id}.pdf`;
    const target = path.join(this.dataDir, relativePath);
    const attachment: Omit<Attachment, "status"> = {
      id,
      paperId,
      relativePath,
      filename: path.basename(filename).slice(0, 255) || "paper.pdf",
      mimeType: "application/pdf",
      sha256,
      createdAt: now(),
    };
    this.atomicFile(target, bytes);
    try {
      this.transaction(() =>
        this.insert("attachments", attachment as unknown as Row),
      );
    } catch (error) {
      unlinkSync(target);
      throw error;
    }
    return { ...attachment, status: "available" };
  }
  private atomicFile(target: string, bytes: Uint8Array) {
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, bytes, { mode: 0o600 });
      renameSync(temp, target);
    } catch (error) {
      if (existsSync(temp)) unlinkSync(temp);
      throw error;
    }
  }
  attachmentPath(id: string): string {
    uuid.parse(id);
    const attachment = this.get<Attachment>("attachments", id);
    const resolved = path.resolve(this.dataDir, attachment.relativePath);
    const prefix = path.join(this.dataDir, "attachments") + path.sep;
    if (!resolved.startsWith(prefix)) throw new StoreError("附件路径无效", 400);
    if (!existsSync(resolved))
      throw new StoreError(
        "PDF文件缺失，请重新上传相同文件恢复原有定位。",
        404,
      );
    if (
      !realpathSync(resolved).startsWith(
        realpathSync(path.join(this.dataDir, "attachments")) + path.sep,
      )
    )
      throw new StoreError("拒绝读取数据目录外的附件", 400);
    if (
      createHash("sha256").update(readFileSync(resolved)).digest("hex") !==
      attachment.sha256
    )
      throw new StoreError(
        "PDF指纹已改变，拒绝将旧批注定位到不同内容。请恢复原附件。",
        409,
      );
    return resolved;
  }
  saveAI(input: Omit<AIContent, "id" | "createdAt">): AIContent {
    const p = this.validatedAI(aiSchema.parse(input));
    const paper = this.get<Paper>("papers", p.paperId);
    if (paper.deletedAt)
      throw new StoreError("文献已在回收站，请先恢复后生成 AI 内容。", 409, {
        existingPaperId: paper.id,
        trashed: true,
      });
    if (p.sourceAttachmentId)
      this.requireAttachment(p.paperId, p.sourceAttachmentId);
    const content: AIContent = { ...p, id: randomUUID(), createdAt: now() };
    this.transaction(() =>
      this.insert("ai_contents", content as unknown as Row),
    );
    return content;
  }
  private validatedAI<T extends Pick<AIContent, "guideData">>(content: T): T {
    try {
      return validateGuideSources(
        content,
        (id) => this.get<Paper>("papers", id),
        (id) => this.get<Attachment>("attachments", id),
      );
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError(
        error instanceof Error ? error.message : "导读来源无效",
      );
    }
  }
  /** Restore is intentionally limited to a new empty library. IDs are never remapped. */
  importSnapshot(input: KBState): void {
    const state = snapshotSchema.parse(input);
    for (const table of Object.values(entityTables).concat(
      "attachments",
      "reading_positions",
      "note_images",
      "note_assists",
      "note_revisions",
      "paper_chat_messages",
      "paper_chat_conversations",
      "idea_lab_messages", "idea_lab_conversations", "idea_lab_summaries",
      "external_discussions", "research_items",
    )) {
      if (
        Number(
          this.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()
            ?.count,
        ) > 0
      )
        throw new StoreError("只能恢复到全新的空数据目录", 409);
    }
    const ids = new Set<string>();
    for (const entries of [
      state.papers,
      state.attachments,
      state.annotations,
      state.notes,
      state.noteImages,
      state.noteAssists,
      state.noteRevisions,
      state.chatConversations,
      state.chatConversations.flatMap((conversation) => conversation.messages),
      state.ideaConversations,
      state.ideaConversations.flatMap((conversation) => conversation.messages),
      state.ideaSummaries,
      state.externalDiscussions,
      state.researchItems,
      state.topics,
      state.aiContents,
      state.tags,
      state.relations,
    ])
      for (const entity of entries) {
        if (ids.has(entity.id)) throw new StoreError("备份包含重复ID");
        ids.add(entity.id);
      }
    for (const paper of state.papers) {
      // Restores validate the saved identifiers, never enrich them from URLs.
      // Older versions legitimately saved publisher URLs with an empty DOI.
      const normalized = normalizeIdentifiers({
        doi: paper.doi,
        arxivId: paper.arxivId,
        arxivVersion: paper.arxivVersion,
      });
      if (
        normalized.doi !== paper.doi ||
        normalized.arxivId !== paper.arxivId ||
        normalized.arxivVersion !== paper.arxivVersion
      )
        throw new StoreError("备份包含未规范化的文献标识");
    }
    this.transaction(() => {
      for (const [table, rows] of [
        ["papers", state.papers],
        ["notes", state.notes],
        ["topics", state.topics],
        ["tags", state.tags],
      ] as const)
        for (const entity of rows) this.insert(table, entity as unknown as Row);
      importNoteImages(this, state.noteImages);
      for (const attachment of state.attachments) {
        const { status: _status, ...entry } = attachment;
        uuid.parse(path.basename(entry.relativePath, ".pdf"));
        if (path.basename(entry.relativePath) !== `${entry.id}.pdf`)
          throw new StoreError("备份附件路径与ID不一致");
        this.get("papers", entry.paperId);
        this.insert("attachments", entry);
      }
      importNoteAssistance(this, state.noteAssists, state.noteRevisions);
      importPaperChats(this, state.chatConversations);
      for (const annotation of state.annotations) {
        this.requireAttachment(annotation.paperId, annotation.attachmentId);
        this.insert("annotations", annotation as unknown as Row);
      }
      for (const content of state.aiContents) {
        this.get("papers", content.paperId);
        if (content.sourceAttachmentId)
          this.requireAttachment(content.paperId, content.sourceAttachmentId);
        this.insert("ai_contents", this.validatedAI(content) as unknown as Row);
      }
      for (const topic of state.topics) {
        const note = this.get<Note>("notes", topic.noteId);
        if (note.purpose !== "topic")
          throw new StoreError("主题综合笔记用途无效");
      }
      importExternalDiscussions(this, state.externalDiscussions);
      importIdeaLab(this, state.ideaConversations, state.ideaSummaries);
      importResearchItems(this, state);
      for (const relation of state.relations) {
        this.entity(relation.fromType, relation.fromId);
        this.entity(relation.toType, relation.toId);
        if (
          relation.purpose === "reference" &&
          (relation.fromType !== "note" ||
            !sourceLinks(this.get<Note>("notes", relation.fromId).body).some(
              (link) =>
                link.type === relation.toType && link.id === relation.toId,
            ))
        )
          throw new StoreError("反向引用与笔记正文不一致");
        this.insert("relations", relation as unknown as Row);
      }
      for (const position of state.readingPositions) {
        this.requireAttachment(position.paperId, position.attachmentId);
        this.insert("reading_positions", position as unknown as Row);
      }
      const entries = Object.entries(state.settings);
      this.db
        .prepare(
          `UPDATE settings SET ${entries.map(([key]) => `${toSnake(key)}=?`).join(",")} WHERE id=1`,
        )
        .run(...entries.map(([key, value]) => encode(value, toSnake(key))));
      // Validate the index is complete as well as free from fabricated backlinks.
      for (const note of state.notes) {
        for (const { type, id } of sourceLinks(note.body)) {
          if (
            this.db
              .prepare(`SELECT id FROM ${entityTables[type]} WHERE id=?`)
              .get(id) &&
            !state.relations.some(
              (r) =>
                r.fromType === "note" &&
                r.fromId === note.id &&
                r.toType === type &&
                r.toId === id &&
                r.purpose === "reference",
            )
          )
            throw new StoreError("备份缺少笔记引用索引");
        }
        this.writeNote(note);
      }
      const fk = this.db.prepare("PRAGMA foreign_key_check").all();
      if (fk.length) throw new StoreError("备份存在无效外键");
    });
  }
}

const globalStore = globalThis as typeof globalThis & {
  __localKBStores?: Map<string, KBStore>;
};
export function getStore(): KBStore {
  const dataDir = path.resolve(
    process.env.KB_DATA_DIR || path.join(process.cwd(), "data"),
  );
  globalStore.__localKBStores ??= new Map();
  let store = globalStore.__localKBStores.get(dataDir);
  if (!store) {
    store = new KBStore(dataDir);
    globalStore.__localKBStores.set(dataDir, store);
  }
  return store;
}
