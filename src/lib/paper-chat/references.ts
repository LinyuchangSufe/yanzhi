import type { KBStore } from "../db";
import { StoreError } from "../store-error";
import { chatContextInputSchema, chatContextSchema } from "./schemas";
import type { ChatContext, ChatContextInput } from "./types";

export const CHAT_CONTEXT_COUNT_LIMIT = 8;
export const CHAT_CONTEXT_ITEM_LIMIT = 16000;
export const CHAT_CONTEXT_TOTAL_LIMIT = 24000;

/** Resolve only the explicitly selected saved text, inside the turn's transaction. */
export function resolveChatContexts(store: KBStore, inputs: ChatContextInput[] = []): ChatContext[] {
  if (inputs.length > CHAT_CONTEXT_COUNT_LIMIT) throw new StoreError("每轮最多引用 8 项内容", 400);
  let total = 0;
  const selected = new Set<string>();
  return inputs.map((raw) => {
    const input = chatContextInputSchema.parse(raw);
    const note = store.db.prepare("SELECT id,title,body,purpose,revision FROM notes WHERE id=?").get(input.noteId);
    if (!note) throw new StoreError("引用的记录已被移除，请重新选择", 409);
    const topic = note.purpose === "topic"
      ? store.db.prepare("SELECT id,title,description,revision FROM topics WHERE note_id=? ORDER BY rowid LIMIT 1").get(input.noteId) : undefined;
    const field = input.field ?? "body";
    if (field === "description" && !topic) throw new StoreError("研究问题已被移除，请重新选择", 409);
    const revision = field === "description" ? topic!.revision : note.revision;
    if (revision !== input.revision) throw new StoreError("引用的记录已更新，请重新选择内容后发送", 409);
    const body = String(field === "description" ? topic!.description : note.body);
    if (input.mode === "full" && !body.trim()) throw new StoreError("引用内容不能为空，请选择有正文的记录或片段", 400);
    const start = input.mode === "full" ? 0 : input.start!;
    const end = input.mode === "full" ? body.length : input.end!;
    if (end > body.length || start >= end || splitsSurrogate(body, start) || splitsSurrogate(body, end))
      throw new StoreError("引用片段范围已失效，请重新选择", 400);
    const text = body.slice(start, end);
    if (!text.trim()) throw new StoreError("引用内容不能为空，请选择有正文的记录或片段", 400);
    if (text.length > CHAT_CONTEXT_ITEM_LIMIT) throw new StoreError("单项引用最多 16000 字，请改为选择片段", 400);
    total += text.length;
    if (total > CHAT_CONTEXT_TOTAL_LIMIT) throw new StoreError("本轮引用总共最多 24000 字，请减少引用内容", 400);
    const key = `${input.noteId}:${field}:${start}:${end}`;
    if (selected.has(key)) throw new StoreError("同一段内容已经引用，请移除重复项", 400);
    selected.add(key);
    return chatContextSchema.parse({noteId: input.noteId, ...(topic ? {topicId: String(topic.id)} : {}),
      title: String(topic?.title ?? note.title), purpose: note.purpose, revision: input.revision,
      mode: input.mode, field, text, start, end, sourceHref: topic ? `kb://topic/${topic.id}` : `kb://note/${input.noteId}`});
  });
}

function splitsSurrogate(text: string, offset: number) {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** This exact saved snapshot is also used in history, retry and edited branches. */
export function buildChatUserContent(body: string, contexts: ChatContext[] = []) {
  if (!contexts.length) return body;
  return JSON.stringify({question: body, personalReferences: contexts.map((item, index) => ({
    label: `个人引用 ${index + 1}`, title: item.title,
    kind: item.field === "description" ? "问题描述" : item.purpose === "topic" ? "研究问题笔记" : item.purpose === "idea" ? "想法" : "笔记",
    source: item.sourceHref, revision: item.revision, extent: item.mode === "full" ? "全文" : "选定片段",
    text: item.text,
  }))}, null, 2);
}
