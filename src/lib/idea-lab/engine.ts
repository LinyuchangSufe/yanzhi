import { randomUUID } from "node:crypto";
import { z } from "zod";
import { aiConfiguration } from "../ai";
import { requestStreamingAI, requestStructuredAI } from "../ai/request";
import type { ChatProgress } from "../ai/chat-progress";
import { createLiteratureTools, literatureToolInstructions, type LiteratureLookup } from "../ai/literature-tools";
import { getStore, type KBStore } from "../db";
import { StoreError } from "../store-error";
import { assertIdeaSourcesAvailable, completedIdeaMessages, IDEA_HISTORY_LIMIT, ideaHistory, ideaUserContent, resolveIdeaSources } from "./context";
import { ideaSendRequestSchema, ideaSummaryRequestSchema, ideaSummarySectionSchema } from "./schemas";
import { beginIdeaTurn, expireIdeaLeases, ideaConversationSnapshot, ideaSummarySnapshot, requireIdeaConversation, requireIdeaNote, saveIdeaSummary, updateIdeaMessage } from "./store";
import { ideaLiteratureLinks, ideaSummaryOutputSchema, ideaSummaryPrompt, ideaSystemPrompt, verifyIdeaLinks } from "./prompt";
import type { IdeaConversation, IdeaMessage, IdeaSourceInput, IdeaSourceSnapshot, IdeaSummary } from "./types";

export interface IdeaUsage { historyMessages: number; historyCharacters: number; sourceCount: number; sourceCharacters: number }
export type IdeaChatStreamEvent =
  | { type: "start"; conversationId: string; conversation: IdeaConversation; userMessage: IdeaMessage; assistantMessage: IdeaMessage; usage: IdeaUsage; reused?: boolean }
  | { type: "delta"; text: string }
  | { type: "progress"; progress: ChatProgress }
  | { type: "done"; conversationId: string; message: IdeaMessage }
  | { type: "error"; message: string; status: number; conversationId?: string; messageRecord?: IdeaMessage };

const active = new WeakMap<KBStore, Set<string>>();
function lock(store: KBStore, noteId: string) {
  const notes = active.get(store) ?? new Set<string>();
  if (notes.has(noteId)) throw new StoreError("这个想法已有 AI 请求正在运行，请停止或等待完成", 409);
  if (notes.size >= 2) throw new StoreError("已有两个想法请求正在运行，请等待完成后重试", 409);
  notes.add(noteId); active.set(store, notes);
  return () => { notes.delete(noteId); };
}
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new StoreError("本次请求已停止，原笔记和讨论记录保留", 499);
}
function problem(error: unknown, signal?: AbortSignal): StoreError {
  if (signal?.aborted) return new StoreError("本次请求已停止", 499);
  return error instanceof StoreError ? error : new StoreError("模型请求失败或返回无效内容，请在原位置重试", 502);
}
function mergeSources(messages: readonly IdeaMessage[]): IdeaSourceSnapshot[] {
  const sources = new Map<string, IdeaSourceSnapshot>();
  for (const message of messages) for (const source of message.sources) {
    const previous = sources.get(source.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(source)) throw new StoreError("讨论来源快照存在冲突，请重新加载", 409);
    sources.set(source.id, source);
  }
  return [...sources.values()];
}
function sourceInputs(input: z.infer<typeof ideaSendRequestSchema>): IdeaSourceInput[] {
  return [...input.sources, ...(input.includeCurrentNote ? [{ type: "note" as const, id: input.noteId,
    revision: input.revision, field: "body" as const }] : [])];
}
function sameSelection(inputs: readonly IdeaSourceInput[], sources: readonly IdeaSourceSnapshot[]) {
  return inputs.length === sources.length && inputs.every((input, index) => {
    const source = sources[index];
    return source.type === input.type && source.entityId === input.id && source.field === input.field &&
      source.revision === input.revision && source.evidenceId === input.evidenceId && source.start === (input.start ?? 0) &&
      (input.end === undefined || source.end === input.end);
  });
}

export async function runIdeaChat(raw: z.input<typeof ideaSendRequestSchema>, emit: (event: IdeaChatStreamEvent) => void,
  signal?: AbortSignal, store = getStore(), dependencies: { literatureLookup?: LiteratureLookup } = {}): Promise<void> {
  const input = ideaSendRequestSchema.parse(raw);
  requireIdeaNote(store, input.noteId); cancelled(signal); expireIdeaLeases(store);
  const inputs = sourceInputs(input);
  const oldConversation = ideaConversationSnapshot(store, input.noteId).find((conversation) =>
    conversation.messages.some((message) => message.requestId === input.requestId));
  if (oldConversation) {
    const userMessage = oldConversation.messages.find((message) => message.requestId === input.requestId && message.role === "user")!;
    const assistantMessage = oldConversation.messages.find((message) => message.requestId === input.requestId && message.role === "assistant")!;
    if (userMessage.body !== input.message || !sameSelection(inputs, userMessage.sources) ||
        (input.model !== undefined && input.model !== userMessage.model) ||
        (input.conversationId && input.conversationId !== oldConversation.id)) throw new StoreError("请求 ID 已用于不同的提问或资料，请重新发送", 409);
    if (assistantMessage.status === "pending") throw new StoreError("该请求仍在生成，请等待完成或返回原讨论停止", 409);
    emit({ type: "start", conversationId: oldConversation.id, conversation: oldConversation, userMessage, assistantMessage,
      usage: { historyMessages: oldConversation.messages.length, historyCharacters: 0,
        sourceCount: userMessage.sources.length, sourceCharacters: userMessage.sources.reduce((sum, source) => sum + source.text.length, 0) }, reused: true });
    if (assistantMessage.status === "completed") emit({ type: "done", conversationId: oldConversation.id, message: assistantMessage });
    else emit({ type: "error", message: assistantMessage.error || "上次请求未完成，请使用新的请求重试", status: 409,
      conversationId: oldConversation.id, messageRecord: assistantMessage });
    return;
  }
  const release = lock(store, input.noteId);
  let assistant: IdeaMessage | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatError: unknown;
  let literature: ReturnType<typeof createLiteratureTools> | undefined;
  const runtimeAbort = new AbortController();
  const requestSignal = AbortSignal.any([runtimeAbort.signal, ...(signal ? [signal] : [])]);
  try {
    const note = requireIdeaNote(store, input.noteId);
    if (note.revision !== input.revision) throw new StoreError("工作笔记已更新，请先保存再发送", 409);
    const defaults = aiConfiguration();
    const config = { ...defaults, model: input.model ?? defaults.model };
    if (!config.configured) throw new StoreError(config.message, 422);
    const previous = input.conversationId ? requireIdeaConversation(store, input.noteId, input.conversationId) : undefined;
    const history = ideaHistory(previous?.messages ?? []);
    const sources = resolveIdeaSources(store, inputs);
    const historyMessages = completedIdeaMessages(previous?.messages ?? []);
    const allSources = [...mergeSources(historyMessages), ...sources];
    assertIdeaSourcesAvailable(store, allSources);
    const userContent = ideaUserContent(input.message, sources);
    if (history.characters + userContent.length > IDEA_HISTORY_LIMIT + 36000)
      throw new StoreError("本次讨论与资料过长，请减少资料或新建讨论；没有截断材料", 413);
    cancelled(signal);
    const turn = beginIdeaTurn(store, { ...input, sources, provider: config.provider, model: config.model,
      expectedNoteRevision: input.revision, expectedLastMessageId: input.conversationId ? previous?.messages.at(-1)?.id ?? null : undefined });
    assistant = turn.assistantMessage;
    emit({ type: "start", conversationId: turn.conversation.id, ...turn,
      usage: { historyMessages: history.messages.length, historyCharacters: history.characters,
        sourceCount: sources.length, sourceCharacters: sources.reduce((sum, source) => sum + source.text.length, 0) } });
    if (turn.reused) {
      if (assistant.status === "completed") emit({ type: "done", conversationId: assistant.conversationId, message: assistant });
      else emit({ type: "error", message: assistant.error || "该请求尚未完成，请刷新后重试", status: 409,
        conversationId: assistant.conversationId, messageRecord: assistant });
      return;
    }
    let progressSavedAt = 0;
    const reportProgress = (progress?: ChatProgress, force = false) => {
      if (!assistant || assistant.status !== "pending") return;
      const previous = assistant.progress!;
      const at = new Date().toISOString();
      assistant = { ...assistant, progress: { ...(progress ?? previous), startedAt: assistant.createdAt,
        lastActivityAt: progress?.lastActivityAt ?? previous.lastActivityAt, heartbeatAt: at } };
      if (force || previous.phase !== assistant.progress!.phase || Date.now() - progressSavedAt >= 1000) {
        assistant = updateIdeaMessage(store, assistant); progressSavedAt = Date.now();
        emit({ type: "progress", progress: assistant.progress! });
      }
    };
    heartbeat = setInterval(() => {
      try { reportProgress(undefined, true); }
      catch (error) { heartbeatError = error; runtimeAbort.abort(); }
    }, 10000);
    heartbeat.unref?.();
    let lastSaved = 0;
    literature = config.provider === "codex" ? createLiteratureTools(store, { noteId: input.noteId }, dependencies.literatureLookup) : undefined;
    const response = await requestStreamingAI(config, [{ role: "system", content: `${ideaSystemPrompt}${literature ? `\n${literatureToolInstructions}` : ""}\n当前想法标题（只提供标题，不代表读取正文）：${JSON.stringify(note.title)}` },
      ...history.messages, { role: "user", content: userContent }], (delta) => {
      cancelled(signal); assistant!.body += delta;
      if (literature?.sources().length) assistant!.literatureSources = literature.sources();
      reportProgress({ ...assistant!.progress!, phase: "responding", lastActivityAt: new Date().toISOString() });
      if (assistant!.body.length > 100000) throw new StoreError("回复过长，已保留部分内容", 502);
      if (Date.now() - lastSaved >= 250) { assistant = updateIdeaMessage(store, assistant!); lastSaved = Date.now(); }
      emit({ type: "delta", text: delta });
    }, requestSignal, reportProgress, literature?.tools);
    cancelled(signal); requireIdeaNote(store, input.noteId); assertIdeaSourcesAvailable(store, allSources);
    if (assistant.body !== response.text) throw new StoreError("流式回复与最终正文不一致，未标记完成", 502);
    verifyIdeaLinks([response.text], allSources,
      [...historyMessages.filter((message) => message.role === "user").map((message) => message.body), input.message,
        ...ideaLiteratureLinks(historyMessages), ...(literature?.markdown() ?? [])]);
    const citationSources = [...new Set([...(literature?.sources() ?? []),
      ...historyMessages.flatMap(message => message.literatureSources ?? []).filter(url => response.text.includes(url))])];
    if (citationSources.length > 40) throw new StoreError("本轮文献引用超过 40 项，请缩小范围后重试；原讨论保留", 413);
    assistant = updateIdeaMessage(store, { ...assistant, status: "completed", model: response.model,
      ...(citationSources.length ? { literatureSources: citationSources } : {}),
      progress: { ...assistant.progress!, heartbeatAt: new Date().toISOString(), processRunning: assistant.provider === "codex" ? false : null } });
    emit({ type: "done", conversationId: assistant.conversationId, message: assistant });
  } catch (error) {
    const failure = problem(heartbeatError ?? error, signal);
    if (!assistant || assistant.status !== "pending") throw failure;
    const reason = failure.message.replace(/[，；。]?已(?:保存|保留)(?:收到的)?部分(?:正文|内容)[。；]?/g, "");
    const message = `${reason}；${assistant.body.trim() ? "已收到的部分正文已保留" : "本次尚未收到正文"}，提问和笔记保留。`;
    assistant = updateIdeaMessage(store, { ...assistant, status: failure.status === 499 ? "cancelled" : "failed", error: message,
      ...(literature?.sources().length ? { literatureSources: literature.sources() } : {}),
      progress: { ...assistant.progress!, heartbeatAt: new Date().toISOString(), processRunning: assistant.provider === "codex" ? false : null } });
    emit({ type: "error", message, status: failure.status, conversationId: assistant.conversationId, messageRecord: assistant });
  } finally { if (heartbeat) clearInterval(heartbeat); release(); }
}

const summaryOutput = z.object({ title: z.string().trim().min(1).max(300),
  sections: z.array(ideaSummarySectionSchema).min(1).max(8) }).strict();

export async function summarizeIdea(raw: z.input<typeof ideaSummaryRequestSchema>, signal?: AbortSignal,
  store = getStore()): Promise<IdeaSummary> {
  const input = ideaSummaryRequestSchema.parse(raw);
  const note = requireIdeaNote(store, input.noteId);
  const conversation = requireIdeaConversation(store, input.noteId, input.conversationId);
  const selectedIds = new Set(input.messageIds);
  const messages = conversation.messages.filter((message) => selectedIds.has(message.id));
  if (messages.length !== input.messageIds.length || messages.some((message) => message.status !== "completed" || !message.body.trim()))
    throw new StoreError("只能整理当前讨论中已完成的提问或回复", 409);
  const messageIds = messages.map((message) => message.id);
  const existing = ideaSummarySnapshot(store, input.noteId).find((summary) => summary.requestId === input.requestId);
  if (existing) {
    if (existing.conversationId !== input.conversationId || JSON.stringify(existing.messageIds) !== JSON.stringify(messageIds) ||
        (input.model !== undefined && input.model !== (existing.requestedModel ?? existing.model)))
      throw new StoreError("请求 ID 已用于不同的整理内容，请重新生成", 409);
    return existing;
  }
  if (note.revision !== input.revision) throw new StoreError("工作笔记已更新，请保存后再整理", 409);
  const release = lock(store, input.noteId);
  try {
    cancelled(signal);
    if (conversation.messages.some((message) => message.status === "pending")) throw new StoreError("请先等待讨论完成或停止后再整理", 409);
    const sources = mergeSources(messages);
    assertIdeaSourcesAvailable(store, sources);
    if (JSON.stringify({ messages, sources }).length > 120000) throw new StoreError("选中的讨论内容过长，请减少消息后整理；没有截断内容", 413);
    const defaults = aiConfiguration();
    const config = { ...defaults, model: input.model ?? defaults.model };
    if (!config.configured) throw new StoreError(config.message, 422);
    const response = await requestStructuredAI(config, ideaSummaryPrompt(note.title, messages, sources), ideaSummaryOutputSchema, signal);
    cancelled(signal); requireIdeaNote(store, input.noteId); assertIdeaSourcesAvailable(store, sources);
    let result: z.infer<typeof summaryOutput>;
    try { result = summaryOutput.parse(JSON.parse(response.text) as unknown); }
    catch { throw new StoreError("AI 整理格式无效，未保存整理稿；原笔记和讨论保留", 502); }
    const available = new Set(sources.map((source) => source.id));
    if (new Set(result.sections.map((section) => section.id)).size !== result.sections.length ||
        result.sections.some((section) => new Set(section.sourceIds).size !== section.sourceIds.length || section.sourceIds.some((id) => !available.has(id))))
      throw new StoreError("AI 整理引用了未提供或重复的来源，未保存整理稿", 502);
    verifyIdeaLinks([result.title, ...result.sections.flatMap((section) => [section.title, section.body])], sources,
    [...messages.filter((message) => message.role === "user").map((message) => message.body), ...ideaLiteratureLinks(messages)]);
    return saveIdeaSummary(store, { id: randomUUID(), requestId: input.requestId, noteId: note.id,
      conversationId: conversation.id, title: result.title, sections: result.sections,
      messageIds, messages, sources, baseRevision: input.revision,
      provider: config.provider, model: response.model, requestedModel: config.model, createdAt: new Date().toISOString(), applications: [] });
  } catch (error) { throw problem(error, signal); }
  finally { release(); }
}
