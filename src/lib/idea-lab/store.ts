import { randomUUID } from "node:crypto";
import type { KBStore } from "../db";
import type { KBState, Note } from "../types";
import { StoreError } from "../store-error";
import { ideaConversationSchema, ideaMessageSchema, ideaSourceSnapshotSchema, ideaSummarySchema } from "./schemas";
import type { IdeaConversation, IdeaMessage, IdeaSourceSnapshot, IdeaSummary } from "./types";
import { verifyIdeaLinks, ideaLiteratureLinks } from "./prompt";
import { assertExternalIdeaSource } from "./context";
import { guideEvidenceProblem } from "./source-details";

const stamp = () => new Date().toISOString();

export function initializeIdeaLab(store: KBStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS idea_lab_conversations (
      id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id),
      title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idea_lab_conversations_note ON idea_lab_conversations(note_id,updated_at);
    CREATE TABLE IF NOT EXISTS idea_lab_messages (
      id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id),
      conversation_id TEXT NOT NULL REFERENCES idea_lab_conversations(id),
      request_id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), lease_expires_at TEXT NOT NULL DEFAULT '',
      UNIQUE(note_id,request_id,role)
    );
    CREATE INDEX IF NOT EXISTS idea_lab_messages_conversation ON idea_lab_messages(conversation_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idea_lab_one_pending ON idea_lab_messages(conversation_id) WHERE status='pending';
    CREATE UNIQUE INDEX IF NOT EXISTS idea_lab_note_pending ON idea_lab_messages(note_id) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS idea_lab_summaries (
      id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id),
      conversation_id TEXT NOT NULL REFERENCES idea_lab_conversations(id), request_id TEXT NOT NULL,
      created_at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(note_id,request_id)
    );
    CREATE INDEX IF NOT EXISTS idea_lab_summaries_note ON idea_lab_summaries(note_id,created_at);
  `);
}

export function requireIdeaNote(store: KBStore, noteId: string): Note {
  const row = store.db.prepare("SELECT * FROM notes WHERE id=?").get(noteId);
  if (!row) throw new StoreError("想法不存在", 404);
  if (row.purpose !== "idea") throw new StoreError("此记录不是独立想法", 422);
  return { id: String(row.id), title: String(row.title), body: String(row.body), purpose: "idea",
    revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function messages(store: KBStore, conversationId: string): IdeaMessage[] {
  return store.db.prepare("SELECT data FROM idea_lab_messages WHERE conversation_id=? ORDER BY rowid").all(conversationId)
    .map((row) => ideaMessageSchema.parse(JSON.parse(String(row.data))));
}
function fromRow(store: KBStore, row: Record<string, unknown>): IdeaConversation {
  return ideaConversationSchema.parse({ id: row.id, noteId: row.note_id, title: row.title,
    createdAt: row.created_at, updatedAt: row.updated_at, messages: messages(store, String(row.id)) });
}
export function ideaConversationSnapshot(store: KBStore, noteId?: string): IdeaConversation[] {
  return store.db.prepare(`SELECT * FROM idea_lab_conversations ${noteId ? "WHERE note_id=?" : ""} ORDER BY updated_at DESC,rowid DESC`)
    .all(...(noteId ? [noteId] : [])).map((row) => fromRow(store, row));
}
export function ideaSummarySnapshot(store: KBStore, noteId?: string): IdeaSummary[] {
  return store.db.prepare(`SELECT data FROM idea_lab_summaries ${noteId ? "WHERE note_id=?" : ""} ORDER BY created_at DESC,rowid DESC`)
    .all(...(noteId ? [noteId] : [])).map((row) => ideaSummarySchema.parse(JSON.parse(String(row.data))));
}
export function requireIdeaConversation(store: KBStore, noteId: string, id: string): IdeaConversation {
  requireIdeaNote(store, noteId);
  const row = store.db.prepare("SELECT * FROM idea_lab_conversations WHERE id=? AND note_id=?").get(id, noteId);
  if (!row) throw new StoreError("讨论不属于当前想法或已不存在", 404);
  return fromRow(store, row);
}
export function requireIdeaSummary(store: KBStore, noteId: string, id: string): IdeaSummary {
  requireIdeaNote(store, noteId);
  const row = store.db.prepare("SELECT data FROM idea_lab_summaries WHERE id=? AND note_id=?").get(id, noteId);
  if (!row) throw new StoreError("整理稿不属于当前想法或已不存在", 404);
  return ideaSummarySchema.parse(JSON.parse(String(row.data)));
}
function putMessage(store: KBStore, noteId: string, input: IdeaMessage): void {
  const value = ideaMessageSchema.parse(input);
  store.db.prepare("INSERT INTO idea_lab_messages(id,note_id,conversation_id,request_id,role,status,data,lease_expires_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(value.id, noteId, value.conversationId, value.requestId, value.role, value.status, JSON.stringify(value),
      value.status === "pending" ? new Date(Date.now() + 300000).toISOString() : "");
}
export function expireIdeaLeases(store: KBStore): void {
  const now = stamp();
  for (const row of store.db.prepare("SELECT data FROM idea_lab_messages WHERE status='pending' AND lease_expires_at<?").all(now)) {
    const message = ideaMessageSchema.parse(JSON.parse(String(row.data)));
    const failed = ideaMessageSchema.parse({ ...message, status: "failed", updatedAt: now, error: message.body.trim()
      ? "上次讨论已中断，已收到的部分正文已保留，请重新发送或重试。" : "上次讨论已中断，本次尚未收到正文；提问和笔记保留。",
      ...(message.progress ? { progress: { ...message.progress, processRunning: message.provider === "codex" ? false : null } } : {}) });
    // Another process may have renewed the lease after this reader selected the row.
    const result = store.db.prepare("UPDATE idea_lab_messages SET status='failed',data=?,lease_expires_at='' WHERE id=? AND status='pending' AND lease_expires_at<?")
      .run(JSON.stringify(failed), message.id, now);
    if (result.changes) store.db.prepare("UPDATE idea_lab_conversations SET updated_at=? WHERE id=?").run(now, message.conversationId);
  }
}

export interface BeginIdeaTurnInput {
  noteId: string; conversationId?: string; requestId: string; message: string;
  sources: IdeaSourceSnapshot[]; provider: string; model: string;
  expectedLastMessageId?: string | null;
  expectedNoteRevision?: number;
}
export function beginIdeaTurn(store: KBStore, input: BeginIdeaTurnInput): {
  conversation: IdeaConversation; userMessage: IdeaMessage; assistantMessage: IdeaMessage; reused: boolean;
} {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const normalizedSources = input.sources.map((source) => ideaSourceSnapshotSchema.parse(source));
    const owner = requireIdeaNote(store, input.noteId);
    expireIdeaLeases(store);
    const old = store.db.prepare("SELECT data FROM idea_lab_messages WHERE note_id=? AND request_id=? AND role='user'")
      .get(input.noteId, input.requestId);
    if (old) {
      const userMessage = ideaMessageSchema.parse(JSON.parse(String(old.data)));
      const conversation = requireIdeaConversation(store, input.noteId, userMessage.conversationId);
      const assistantMessage = conversation.messages.find((message) => message.requestId === input.requestId && message.role === "assistant");
      if (!assistantMessage || userMessage.body !== input.message || userMessage.provider !== input.provider || userMessage.model !== input.model ||
          JSON.stringify(userMessage.sources) !== JSON.stringify(normalizedSources) ||
          (input.conversationId && input.conversationId !== conversation.id))
        throw new StoreError("请求 ID 已用于不同的提问或资料，请重新发送", 409);
      store.db.exec("COMMIT");
      return { conversation, userMessage, assistantMessage, reused: true };
    }
    if (input.expectedNoteRevision !== undefined && owner.revision !== input.expectedNoteRevision)
      throw new StoreError("工作笔记已更新，请保存并重新选择资料后发送", 409);
    if (store.db.prepare("SELECT id FROM idea_lab_messages WHERE note_id=? AND status='pending'").get(input.noteId))
      throw new StoreError("当前想法已有回复正在生成，请停止或等待完成", 409);
    const now = stamp();
    let conversation: IdeaConversation;
    if (input.conversationId) {
      conversation = requireIdeaConversation(store, input.noteId, input.conversationId);
      if (input.expectedLastMessageId !== undefined && (conversation.messages.at(-1)?.id ?? null) !== input.expectedLastMessageId)
        throw new StoreError("讨论已在其他窗口更新，请刷新后发送", 409);
    } else {
      conversation = { id: randomUUID(), noteId: input.noteId, title: input.message.slice(0, 120),
        createdAt: now, updatedAt: now, messages: [] };
      store.db.prepare("INSERT INTO idea_lab_conversations(id,note_id,title,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(conversation.id, conversation.noteId, conversation.title, now, now);
    }
    if (conversation.messages.some((message) => message.status === "pending"))
      throw new StoreError("此讨论已有回复正在生成，请停止或等待完成", 409);
    const base = { conversationId: conversation.id, requestId: input.requestId, sources: normalizedSources,
      provider: input.provider, model: input.model, error: "", createdAt: now, updatedAt: now };
    const userMessage: IdeaMessage = { ...base, id: randomUUID(), role: "user", body: input.message, status: "completed" };
    const assistantMessage: IdeaMessage = { ...base, id: randomUUID(), role: "assistant", body: "", status: "pending",
      progress: { startedAt: now, phase: "starting", lastActivityAt: null, heartbeatAt: now, processRunning: null } };
    putMessage(store, input.noteId, userMessage); putMessage(store, input.noteId, assistantMessage);
    store.db.prepare("UPDATE idea_lab_conversations SET updated_at=? WHERE id=?").run(now, conversation.id);
    store.db.exec("COMMIT");
    return { conversation, userMessage, assistantMessage, reused: false };
  } catch (error) { store.db.exec("ROLLBACK"); throw error; }
}

export function updateIdeaMessage(store: KBStore, input: IdeaMessage): IdeaMessage {
  const value = ideaMessageSchema.parse({ ...input, updatedAt: stamp() });
  const row = store.db.prepare("SELECT data FROM idea_lab_messages WHERE id=? AND conversation_id=? AND status='pending'").get(value.id, value.conversationId);
  if (!row) throw new StoreError("讨论状态已改变，请刷新", 409);
  const old = ideaMessageSchema.parse(JSON.parse(String(row.data)));
  if (value.role !== "assistant" || old.requestId !== value.requestId || old.provider !== value.provider ||
      old.createdAt !== value.createdAt || JSON.stringify(old.sources) !== JSON.stringify(value.sources))
    throw new StoreError("回复不能修改原提问或来源快照", 409);
  const result = store.db.prepare("UPDATE idea_lab_messages SET status=?,data=?,lease_expires_at=? WHERE id=? AND conversation_id=? AND status='pending'")
    .run(value.status, JSON.stringify(value), value.status === "pending" ? new Date(Date.now() + 300000).toISOString() : "", value.id, value.conversationId);
  if (!result.changes) throw new StoreError("讨论状态已改变，请刷新", 409);
  store.db.prepare("UPDATE idea_lab_conversations SET updated_at=? WHERE id=?").run(value.updatedAt, value.conversationId);
  return value;
}

/** Completed snapshots are immutable; new user writing never changes a previous summary. */
export function saveIdeaSummary(store: KBStore, input: IdeaSummary): IdeaSummary {
  const value = ideaSummarySchema.parse(input);
  const note = requireIdeaNote(store, value.noteId);
  const conversation = requireIdeaConversation(store, value.noteId, value.conversationId);
  if (value.baseRevision > note.revision) throw new StoreError("整理稿的原稿修订号无效", 409);
  for (const message of value.messages) {
    const saved = conversation.messages.find((item) => item.id === message.id);
    if (!saved || JSON.stringify(saved) !== JSON.stringify(message)) throw new StoreError("整理稿引用了不属于此讨论的消息", 409);
  }
  verifySummarySources(value);
  const old = store.db.prepare("SELECT data FROM idea_lab_summaries WHERE note_id=? AND request_id=?").get(value.noteId, value.requestId);
  if (old) {
    const existing = ideaSummarySchema.parse(JSON.parse(String(old.data)));
    if (existing.conversationId !== value.conversationId || JSON.stringify(existing.messageIds) !== JSON.stringify(value.messageIds) ||
        (existing.requestedModel ?? existing.model) !== (value.requestedModel ?? value.model) || existing.provider !== value.provider)
      throw new StoreError("请求 ID 已用于不同的整理内容", 409);
    return existing;
  }
  if (value.applications.length) throw new StoreError("新整理稿不能自带采纳记录", 422);
  store.db.prepare("INSERT INTO idea_lab_summaries(id,note_id,conversation_id,request_id,created_at,data) VALUES(?,?,?,?,?,?)")
    .run(value.id, value.noteId, value.conversationId, value.requestId, value.createdAt, JSON.stringify(value));
  return value;
}

function verifyHistoricalSources(store: KBStore, values: IdeaSourceSnapshot[], state: KBState): void {
  for (const source of values) {
    if (source.type === "externalDiscussion") {
      try { assertExternalIdeaSource(store, source); }
      catch { throw new StoreError("备份讨论中的外部资料与原讨论修订、来源或完成状态不匹配", 422); }
      continue;
    }
    if (source.type !== "annotation" && source.type !== "guideEvidence") continue;
    const attachment = store.db.prepare("SELECT paper_id,sha256 FROM attachments WHERE id=?").get(source.attachmentId!);
    if (!attachment || attachment.paper_id !== source.paperId || attachment.sha256 !== source.attachmentSha256)
      throw new StoreError("备份讨论中的原文资料与附件不匹配", 422);
    if (source.type === "guideEvidence") {
      const guide = state.aiContents.find((item) => item.id === source.guideId);
      const evidence = guide?.guideData?.evidence.find((item) => item.id === source.evidenceId);
      // Deleted source records remain readable historical snapshots, as for deleted annotations.
      if (guide && (!evidence || guideEvidenceProblem(state, guide, evidence, true) || evidence.paperId !== source.paperId ||
          evidence.attachmentId !== source.attachmentId || evidence.attachmentSha256 !== source.attachmentSha256 ||
          evidence.pageIndex !== source.pageIndex || evidence.pageLabel !== source.pageLabel || evidence.quote.slice(source.start, source.end) !== source.text))
        throw new StoreError("备份讨论中的导读原句与证据、页码或来源不一致", 422);
      continue;
    }
    const annotation = store.db.prepare("SELECT paper_id,attachment_id,page_index FROM annotations WHERE id=?").get(source.entityId);
    if (annotation && (annotation.paper_id !== source.paperId || annotation.attachment_id !== source.attachmentId || annotation.page_index !== source.pageIndex))
      throw new StoreError("备份讨论中的批注来源归属不一致", 422);
  }
}

function verifySummarySources(value: IdeaSummary): void {
  const originals = value.messages.flatMap((message) => message.sources);
  if (value.sources.some((source) => !originals.some((original) => JSON.stringify(source) === JSON.stringify(original))))
    throw new StoreError("整理稿新增了所选讨论中不存在的资料快照", 422);
  verifyIdeaLinks([value.title, ...value.sections.flatMap((section) => [section.title, section.body])], value.sources,
    [...value.messages.filter((message) => message.role === "user").map((message) => message.body), ...ideaLiteratureLinks(value.messages)]);
}

export function importIdeaLab(store: KBStore, conversations: IdeaConversation[], summaries: IdeaSummary[]): void {
  const sourceState = store.snapshot();
  const ids = new Set<string>(), requestOwners = new Set<string>();
  const add = (id: string) => { if (ids.has(id)) throw new StoreError("备份想法讨论包含重复 ID", 422); ids.add(id); };
  for (const input of conversations) {
    const value = ideaConversationSchema.parse(input);
    requireIdeaNote(store, value.noteId); add(value.id);
    store.db.prepare("INSERT INTO idea_lab_conversations(id,note_id,title,created_at,updated_at) VALUES(?,?,?,?,?)")
      .run(value.id, value.noteId, value.title, value.createdAt, value.updatedAt);
    for (const original of value.messages) {
      add(original.id); verifyHistoricalSources(store, original.sources, sourceState);
      if (original.role === "user") {
        const key = `${value.noteId}:${original.requestId}`;
        if (requestOwners.has(key)) throw new StoreError("备份想法讨论请求 ID 重复", 422);
        requestOwners.add(key);
      }
      const message = original.status === "pending" ? { ...original, status: "failed" as const, error: "备份时回复尚未完成，请重新发送。",
        ...(original.progress ? { progress: { ...original.progress, processRunning: original.provider === "codex" ? false : null } } : {}) } : original;
      putMessage(store, value.noteId, message);
    }
  }
  for (const input of summaries) {
    const value = ideaSummarySchema.parse(input);
    const note = requireIdeaNote(store, value.noteId); add(value.id);
    const conversation = requireIdeaConversation(store, value.noteId, value.conversationId);
    if (value.baseRevision > note.revision) throw new StoreError("备份整理稿的原稿修订号无效", 422);
    verifyHistoricalSources(store, value.sources, sourceState);
    verifySummarySources(value);
    for (const message of value.messages) {
      const saved = conversation.messages.find((item) => item.id === message.id);
      if (!saved || JSON.stringify(saved) !== JSON.stringify(message)) throw new StoreError("备份整理稿引用了不属于此讨论的消息", 422);
    }
    for (const application of value.applications)
      if (!store.db.prepare("SELECT id FROM notes WHERE id=?").get(application.targetNoteId))
        throw new StoreError("备份整理稿采纳目标不存在", 422);
    store.db.prepare("INSERT INTO idea_lab_summaries(id,note_id,conversation_id,request_id,created_at,data) VALUES(?,?,?,?,?,?)")
      .run(value.id, value.noteId, value.conversationId, value.requestId, value.createdAt, JSON.stringify(value));
  }
}
