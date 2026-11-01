import { createHash, randomUUID } from "node:crypto";
import type { KBStore } from "../db";
import { StoreError } from "../store-error";
import { paperChatConversationSchema, paperChatMessageSchema, paperChatRenameSchema } from "./schemas";
import { resolveChatContexts } from "./references";
import type { PaperChatReplay } from "./schemas";
import type { ChatContextInput, ChatScope, PaperChatConversation, PaperChatMessage } from "./types";

export function initializePaperChat(store: KBStore) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS paper_chat_conversations (
      id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id),
      attachment_id TEXT NOT NULL REFERENCES attachments(id), attachment_sha256 TEXT NOT NULL,
      title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS paper_chat_paper ON paper_chat_conversations(paper_id,updated_at);
    CREATE TABLE IF NOT EXISTS paper_chat_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES paper_chat_conversations(id),
      role TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
      lease_expires_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS paper_chat_messages_conversation ON paper_chat_messages(conversation_id);
    CREATE UNIQUE INDEX IF NOT EXISTS paper_chat_one_pending ON paper_chat_messages(conversation_id) WHERE status='pending';
  `);
}
function messageRows(store: KBStore, conversationId: string): PaperChatMessage[] {
  return store.db.prepare("SELECT data FROM paper_chat_messages WHERE conversation_id=? ORDER BY rowid").all(conversationId)
    .map((row) => paperChatMessageSchema.parse(JSON.parse(String(row.data))));
}
function fromRow(store: KBStore, row: Record<string, unknown>): PaperChatConversation {
  return {id: String(row.id), paperId: String(row.paper_id), attachmentId: String(row.attachment_id),
    attachmentSha256: String(row.attachment_sha256), title: String(row.title), createdAt: String(row.created_at),
    updatedAt: String(row.updated_at), messages: messageRows(store, String(row.id))};
}
export function paperChatSnapshot(store: KBStore, paperId?: string): PaperChatConversation[] {
  return store.db.prepare(`SELECT * FROM paper_chat_conversations ${paperId ? "WHERE paper_id=?" : ""} ORDER BY updated_at DESC,rowid DESC`)
    .all(...(paperId ? [paperId] : [])).map((row) => fromRow(store, row));
}
export function renamePaperChat(store: KBStore, input: {paperId: string; conversationId: string; title: string}) {
  const renamed = paperChatRenameSchema.parse(input);
  requireChatPaper(store, renamed.paperId);
  const result = store.db.prepare("UPDATE paper_chat_conversations SET title=?,updated_at=? WHERE id=? AND paper_id=?")
    .run(renamed.title, new Date().toISOString(), renamed.conversationId, renamed.paperId);
  if (!result.changes) throw new StoreError("对话不属于当前文献或已不存在", 404);
  return fromRow(store, store.db.prepare("SELECT * FROM paper_chat_conversations WHERE id=? AND paper_id=?")
    .get(renamed.conversationId, renamed.paperId)!);
}
export function requireChatPaper(store: KBStore, paperId: string, attachmentId?: string) {
  const paper = store.db.prepare("SELECT id,title,authors,abstract,deleted_at FROM papers WHERE id=?").get(paperId);
  if (!paper) throw new StoreError("文献不存在", 404);
  if (paper.deleted_at) throw new StoreError("文献已在回收站，请先恢复后对话", 409);
  if (!attachmentId) return {paper, attachment: undefined};
  const attachment = store.db.prepare("SELECT id,paper_id,sha256 FROM attachments WHERE id=? AND paper_id=?").get(attachmentId, paperId);
  if (!attachment) throw new StoreError("对话附件与文献不匹配", 400);
  return {paper, attachment};
}
export function requireConversation(store: KBStore, paperId: string, attachmentId: string, id: string) {
  const {attachment} = requireChatPaper(store, paperId, attachmentId);
  const row = store.db.prepare("SELECT * FROM paper_chat_conversations WHERE id=? AND paper_id=? AND attachment_id=? AND attachment_sha256=?")
    .get(id, paperId, attachmentId, String(attachment!.sha256));
  if (!row) throw new StoreError("对话不属于当前文献或附件版本，请新建对话", 409);
  return fromRow(store, row);
}
/** A replay reads an immutable prefix; recheck its source after asynchronous PDF extraction. */
export function resolveChatReplay(store: KBStore, input: {
  paperId: string; attachmentId: string; message: string; replay: PaperChatReplay;
}) {
  const conversation = requireConversation(store, input.paperId, input.attachmentId, input.replay.sourceConversationId);
  if (conversation.messages.some((message) => message.status === "pending"))
    throw new StoreError("原对话已有回复正在生成，请停止或等待完成后再试", 409);
  const sourceIndex = conversation.messages.findIndex((message) => message.id === input.replay.sourceMessageId);
  const sourceMessage = conversation.messages[sourceIndex];
  if (!sourceMessage || sourceMessage.role !== "user") throw new StoreError("原提问不存在或不属于此对话", 409);
  if (input.replay.kind === "retry" && input.message.trim() !== sourceMessage.body.trim())
    throw new StoreError("重试内容与原提问不一致，请重新加载后再试", 409);
  if (conversation.messages.some((message) => message.scope &&
      (message.scope.attachmentId !== input.attachmentId || message.scope.attachmentSha256 !== conversation.attachmentSha256)))
    throw new StoreError("原对话消息与附件版本不匹配，请新建对话", 409);
  return {conversation, prefix: conversation.messages.slice(0, sourceIndex), model: sourceMessage.model, provider: sourceMessage.provider,
    message: input.replay.kind === "retry" ? sourceMessage.body : input.message,
    contexts: sourceMessage.contexts,
    fingerprint: createHash("sha256").update(JSON.stringify(conversation)).digest("hex")};
}
function putMessage(store: KBStore, message: PaperChatMessage) {
  paperChatMessageSchema.parse(message);
  store.db.prepare("INSERT INTO paper_chat_messages(id,conversation_id,role,status,data,lease_expires_at) VALUES(?,?,?,?,?,?)")
    .run(message.id, message.conversationId, message.role, message.status, JSON.stringify(message),
      message.status === "pending" ? new Date(Date.now() + 300000).toISOString() : "");
}
export function expirePaperChatLeases(store: KBStore) {
  const stamp = new Date().toISOString();
  const rows = store.db.prepare("SELECT data FROM paper_chat_messages WHERE status='pending' AND lease_expires_at<?").all(stamp);
  for (const row of rows) {
    const message = paperChatMessageSchema.parse(JSON.parse(String(row.data)));
    const failed: PaperChatMessage = {...message, status: "failed", error: message.body.trim()
      ? "上次对话已中断，已收到的部分正文已保留。" : "上次对话已中断，本次尚未收到正文；提问和笔记保留。", updatedAt: stamp,
      ...(message.progress ? {progress: {...message.progress, processRunning: message.provider === "codex" ? false : null}} : {})};
    store.db.prepare("UPDATE paper_chat_messages SET status='failed',data=?,lease_expires_at='' WHERE id=? AND status='pending' AND lease_expires_at<?")
      .run(JSON.stringify(failed), message.id, stamp);
  }
}
export function beginChatTurn(store: KBStore, input: {
  paperId: string; attachmentId: string; conversationId?: string; message: string;
  contexts?: ChatContextInput[];
  replay?: PaperChatReplay; expectedReplayFingerprint?: string;
  expectedLastMessageId?: string | null;
  expectedLastMessageStatus?: PaperChatMessage["status"] | null;
  provider: string; model: string; scope: ChatScope;
}) {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    if (input.replay && input.conversationId) throw new StoreError("重试或编辑提问必须创建新对话", 400);
    if (input.replay && input.contexts !== undefined) throw new StoreError("重试或编辑提问会沿用原引用，不能替换引用内容", 400);
    // A replay must not rewrite any part of its source, including an expired pending lease.
    if (!input.replay) expirePaperChatLeases(store);
    const {attachment} = requireChatPaper(store, input.paperId, input.attachmentId);
    if (input.scope.attachmentId !== input.attachmentId || input.scope.attachmentSha256 !== String(attachment!.sha256))
      throw new StoreError("对话附件版本已改变，请重新加载后再试", 409);
    const replay = input.replay ? resolveChatReplay(store, {...input, replay: input.replay}) : undefined;
    if (replay && replay.fingerprint !== input.expectedReplayFingerprint)
      throw new StoreError("原对话已在其他窗口更新，请重新加载后再试", 409);
    const message = replay?.message ?? input.message;
    // A replay uses immutable saved text even when its source note was edited or removed.
    const contexts = replay ? replay.contexts : resolveChatContexts(store, input.contexts);
    const stamp = new Date().toISOString();
    let conversation: PaperChatConversation;
    if (input.conversationId) {
      conversation = requireConversation(store, input.paperId, input.attachmentId, input.conversationId);
      if (input.expectedLastMessageId !== undefined && (conversation.messages.at(-1)?.id ?? null) !== input.expectedLastMessageId)
        throw new StoreError("对话已在其他窗口更新，请重新加载后再发送", 409);
      if (input.expectedLastMessageStatus !== undefined && (conversation.messages.at(-1)?.status ?? null) !== input.expectedLastMessageStatus)
        throw new StoreError("对话已在其他窗口更新，请重新加载后再发送", 409);
    }
    else {
      const suffix = input.replay ? input.replay.kind === "retry" ? " · 重试" : " · 已编辑" : "";
      conversation = {id: randomUUID(), paperId: input.paperId, attachmentId: input.attachmentId,
        attachmentSha256: String(attachment!.sha256), title: message.slice(0, 120 - suffix.length) + suffix,
        createdAt: stamp, updatedAt: stamp, messages: []};
      store.db.prepare("INSERT INTO paper_chat_conversations(id,paper_id,attachment_id,attachment_sha256,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .run(conversation.id, conversation.paperId, conversation.attachmentId, conversation.attachmentSha256, conversation.title, stamp, stamp);
      if (replay) {
        conversation.messages = replay.prefix.map((item) => ({...item, id: randomUUID(), conversationId: conversation.id}));
        for (const item of conversation.messages) putMessage(store, item);
      }
    }
    if (conversation.messages.some((message) => message.status === "pending")) throw new StoreError("此对话已有回复正在生成，请停止或等待完成后再试", 409);
    const base = {conversationId: conversation.id, provider: input.provider, model: input.model, createdAt: stamp, updatedAt: stamp, error: ""};
    const userMessage: PaperChatMessage = {...base, id: randomUUID(), role: "user", body: message, status: "completed", scope: null,
      ...(contexts?.length ? {contexts} : {})};
    const assistantMessage: PaperChatMessage = {...base, id: randomUUID(), role: "assistant", body: "", status: "pending", scope: input.scope,
      progress: {startedAt: stamp, phase: "starting", lastActivityAt: null, heartbeatAt: stamp, processRunning: null}};
    putMessage(store, userMessage); putMessage(store, assistantMessage);
    store.db.prepare("UPDATE paper_chat_conversations SET updated_at=? WHERE id=?").run(stamp, conversation.id);
    store.db.exec("COMMIT");
    return {conversation, userMessage, assistantMessage};
  } catch (error) { store.db.exec("ROLLBACK"); throw error; }
}
export function updateChatMessage(store: KBStore, message: PaperChatMessage) {
  const validated = paperChatMessageSchema.parse({...message, updatedAt: new Date().toISOString()});
  const result = store.db.prepare("UPDATE paper_chat_messages SET status=?,data=?,lease_expires_at=? WHERE id=? AND conversation_id=? AND status='pending'")
    .run(validated.status, JSON.stringify(validated), validated.status === "pending" ? new Date(Date.now() + 300000).toISOString() : "", validated.id, validated.conversationId);
  if (!result.changes) throw new StoreError("对话状态已改变，请重新加载", 409);
  store.db.prepare("UPDATE paper_chat_conversations SET updated_at=? WHERE id=?").run(validated.updatedAt, validated.conversationId);
  return validated;
}
export function importPaperChats(store: KBStore, conversations: PaperChatConversation[]) {
  const messageIds = new Set<string>();
  for (const input of conversations) {
    const conversation = paperChatConversationSchema.parse(input);
    // Archives may include trashed papers; verify ownership without requiring an active paper.
    const attachment = store.db.prepare("SELECT sha256 FROM attachments WHERE id=? AND paper_id=?")
      .get(conversation.attachmentId, conversation.paperId);
    if (!attachment || attachment.sha256 !== conversation.attachmentSha256) throw new StoreError("备份对话与附件版本不匹配");
    store.db.prepare("INSERT INTO paper_chat_conversations(id,paper_id,attachment_id,attachment_sha256,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(conversation.id, conversation.paperId, conversation.attachmentId, conversation.attachmentSha256, conversation.title, conversation.createdAt, conversation.updatedAt);
    for (const message of conversation.messages) {
      if (messageIds.has(message.id) || message.conversationId !== conversation.id ||
          (message.scope && (message.scope.attachmentId !== conversation.attachmentId || message.scope.attachmentSha256 !== conversation.attachmentSha256)))
        throw new StoreError("备份对话消息来源不一致");
      messageIds.add(message.id);
      putMessage(store, message.status === "pending" ? {...message, status: "failed", error: "备份时此回复尚未完成。",
        ...(message.progress ? {progress: {...message.progress, processRunning: message.provider === "codex" ? false : null}} : {})} : message);
    }
  }
}
