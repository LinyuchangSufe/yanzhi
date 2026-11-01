import type { ChatContext, ChatContextInput, ChatStreamEvent, PaperChatConfiguration, PaperChatConversation, PaperChatMessage } from "./types";
import { chatProgressSchema, type ChatProgress } from "../ai/chat-progress";

/**
 * Adapts Papernook's ChatPanel append/reload lifecycle to local persisted chats.
 * Upstream Copyright (c) 2026 Andres Romero, MIT; see ../../../LICENSE.
 * Keeping transport outside React lets reading/tab navigation leave it running.
 */
export interface ChatRun {
  conversationId: string | null;
  attachmentId: string;
  message: string;
  assistantId: string | null;
  stopping: boolean;
  optimisticVisible: boolean;
  model: string;
  contexts: ChatContext[];
  startedAt?: string;
  progress?: ChatProgress | null;
  replay?: ChatReplay;
}
interface ChatReplay {
  sourceConversationId: string;
  sourceMessageId: string;
  kind: "retry" | "edit";
}
export interface PaperChatModelOption { id: string; label: string }
type ModelPreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface ChatClientState {
  conversations: PaperChatConversation[];
  activeId: string | null;
  draft: string;
  draftContexts: ChatContext[];
  loading: boolean;
  loaded: boolean;
  error: string;
  running: ChatRun | null;
  configuration: PaperChatConfiguration | null;
  modelOverride: string;
  modelNotice: string;
  modelOptions: PaperChatModelOption[];
  modelOptionsLoading: boolean;
  modelOptionsWarning: string;
}
export const EMPTY_CHAT_STATE: ChatClientState = {
  conversations: [], activeId: null, draft: "", draftContexts: [], loading: false,
  loaded: false, error: "", running: null,
  configuration: null, modelOverride: "", modelNotice: "", modelOptions: [],
  modelOptionsLoading: false, modelOptionsWarning: "",
};
export interface PaperChatActivity {
  paperId: string;
  paperTitle: string;
  conversationId: string | null;
  stopping: boolean;
  startedAt?: string;
  progress?: ChatProgress | null;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "对话请求失败，请重试。";
}

/** Decode complete NDJSON records even when UTF-8 or JSON spans network chunks. */
export async function readChatEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatStreamEvent) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const line = (value: string) => {
    if (!value.trim()) return;
    let event: unknown;
    try { event = JSON.parse(value); }
    catch { throw new Error("对话响应格式不正确，已接收内容仍保留。"); }
    if (!event || typeof event !== "object" || !("type" in event) ||
      !["start", "progress", "delta", "done", "error"].includes(String(event.type))) {
      throw new Error("对话响应格式不正确，已接收内容仍保留。");
    }
    if (event.type === "progress" && !("progress" in event && chatProgressSchema.safeParse(event.progress).success))
      throw new Error("对话进度格式不正确，已接收内容仍保留。");
    onEvent(event as ChatStreamEvent);
  };
  try {
    for (;;) {
      const next = await reader.read();
      buffered += decoder.decode(next.value, { stream: !next.done });
      if (buffered.length > 4_000_000) throw new Error("对话响应过长，已接收内容仍保留。");
      let boundary: number;
      while ((boundary = buffered.indexOf("\n")) >= 0) {
        line(buffered.slice(0, boundary));
        buffered = buffered.slice(boundary + 1);
      }
      if (next.done) break;
    }
    line(buffered);
  } finally {
    reader.releaseLock();
  }
}

function upsertMessage(messages: PaperChatMessage[], message: PaperChatMessage) {
  return messages.some((item) => item.id === message.id)
    ? messages.map((item) => item.id === message.id ? message : item)
    : [...messages, message];
}

export class PaperChatClient {
  private state: ChatClientState = { ...EMPTY_CHAT_STATE };
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private loading: Promise<void> | null = null;
  private selectionVersion = 0;
  private composerVersion = 0;
  private titleVersions = new Map<string, number>();
  private streamVersion = 0;
  private startedConversations = new Map<string, number>();
  private preferenceKey: string | null = null;
  private modelOptionsRequest: Promise<void> | null = null;
  paperTitle: string;

  constructor(readonly paperId: string, private request: typeof fetch = (input, init) => fetch(input, init),
    private storage?: ModelPreferenceStorage | null) {
    this.paperTitle = "论文对话";
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: Partial<ChatClientState>) {
    const previousRun = this.state.running;
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
    if (previousRun !== this.state.running) refreshActivities();
  }
  setDraft = (draft: string) => {
    this.composerVersion += 1;
    this.publish({ draft });
  };
  addContext = (context: ChatContext): boolean => this.addContexts([context]);
  addContexts = (selected: ChatContext[]): boolean => {
    if (!selected.length) return false;
    const contexts = [...this.state.draftContexts];
    for (const context of selected) {
      if (!context.text.trim() || context.text.length > 16_000) {
        this.publish({ error: "每条引用须包含正文，且不超过 16,000 个字符，请改选片段。" });
        return false;
      }
      if (contexts.some((item) => item.noteId === context.noteId && item.revision === context.revision &&
        (item.field || "body") === (context.field || "body") &&
        item.start === context.start && item.end === context.end)) {
        this.publish({ error: "这段内容已经在待发送引用中。" });
        return false;
      }
      contexts.push({ ...context });
    }
    if (contexts.length > 8 || contexts.reduce((total, item) => total + item.text.length, 0) > 24_000) {
      this.publish({ error: "每轮最多引用 8 项、共 24,000 个字符，请减少引用或改选片段。" });
      return false;
    }
    this.composerVersion += 1;
    this.publish({ draftContexts: contexts, error: "" });
    return true;
  };
  removeContext = (index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= this.state.draftContexts.length) return;
    this.composerVersion += 1;
    this.publish({ draftContexts: this.state.draftContexts.filter((_, itemIndex) => itemIndex !== index) });
  };
  clearContexts = () => {
    if (!this.state.draftContexts.length) return;
    this.composerVersion += 1;
    this.publish({ draftContexts: [] });
  };
  private preferenceStorage() {
    return this.storage === undefined ? typeof window === "undefined" ? null : window.localStorage : this.storage;
  }
  private configurationState(configuration: PaperChatConfiguration): Partial<ChatClientState> {
    const preferenceKey = `research-paper-chat-model:v1:${encodeURIComponent(this.paperId)}:${configuration.preferenceKey}`;
    if (preferenceKey === this.preferenceKey) return { configuration };
    this.preferenceKey = preferenceKey;
    let modelOverride = "";
    try {
      const saved = this.preferenceStorage()?.getItem(preferenceKey)?.trim() || "";
      if (saved.length <= 300 && !/[\u0000-\u001f\u007f]/.test(saved)) modelOverride = saved;
    } catch { /* A blocked browser store must not prevent chatting. */ }
    return { configuration, modelOverride, modelNotice: "", modelOptions: [], modelOptionsWarning: "" };
  }
  setModelOverride = (value: string): boolean => {
    const modelOverride = value.trim();
    if (modelOverride.length > 300 || /[\u0000-\u001f\u007f]/.test(modelOverride)) {
      this.publish({ modelNotice: "模型 ID 请使用 300 字符以内的单行文本。" });
      return false;
    }
    if (!this.state.configuration || !this.preferenceKey) {
      this.publish({ modelNotice: "请先加载 AI 配置后再调整模型。" });
      return false;
    }
    let modelNotice = "";
    try {
      const storage = this.preferenceStorage();
      if (modelOverride) storage?.setItem(this.preferenceKey, modelOverride);
      else storage?.removeItem(this.preferenceKey);
    } catch { modelNotice = "模型已应用；浏览器无法保存偏好，刷新后将恢复全局默认。"; }
    this.publish({ modelOverride, modelNotice });
    return true;
  };
  loadModelOptions = async (): Promise<void> => {
    if (this.modelOptionsRequest) return this.modelOptionsRequest;
    const preferenceKey = this.preferenceKey;
    this.publish({ modelOptionsLoading: true, modelOptionsWarning: "" });
    this.modelOptionsRequest = (async () => {
      try {
        const response = await this.request("/api/kb/chat/models", { cache: "no-store" });
        const result: { provider?: string; models?: PaperChatModelOption[]; warning?: string; error?: string } = await response.json();
        if (!response.ok) throw new Error(result.error || "暂时无法读取模型列表，可手动填写模型 ID。");
        if (!Array.isArray(result.models)) throw new Error("无法读取模型列表，可手动填写模型 ID。");
        if (preferenceKey !== this.preferenceKey) return;
        if (result.provider !== this.state.configuration?.provider) throw new Error("AI 配置已变化，请重新加载后选择模型。");
        const models = result.models.filter((item) => typeof item.id === "string" && item.id.length > 0 &&
          item.id.length <= 300 && typeof item.label === "string");
        this.publish({ modelOptions: models, modelOptionsWarning: result.warning || "" });
      } catch (error) {
        if (preferenceKey === this.preferenceKey) this.publish({ modelOptionsWarning: errorText(error) });
      } finally {
        this.modelOptionsRequest = null;
        this.publish({ modelOptionsLoading: false });
      }
    })();
    return this.modelOptionsRequest;
  };
  renameConversation = async (conversationId: string, value: string): Promise<string> => {
    const title = value.trim();
    if (!title || title.length > 120) return "名称请填写 1–120 个字符。";
    if (!this.state.conversations.some((item) => item.id === conversationId)) return "此对话已不存在，请刷新后重试。";
    try {
      const response = await this.request("/api/kb/chat", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperId: this.paperId, conversationId, title }),
      });
      const result: { conversation?: PaperChatConversation; error?: string } = await response.json();
      if (!response.ok) throw new Error(result.error || "重命名失败，请重试。");
      const renamed = result.conversation;
      if (!renamed || renamed.id !== conversationId || renamed.paperId !== this.paperId || typeof renamed.title !== "string")
        throw new Error("重命名结果不一致，请重试。");
      this.titleVersions.set(conversationId, (this.titleVersions.get(conversationId) || 0) + 1);
      // A rename response can contain older messages than the active stream.
      this.publish({ conversations: this.state.conversations.map((item) => item.id === conversationId
        ? { ...item, title: renamed.title, updatedAt: item.updatedAt > renamed.updatedAt ? item.updatedAt : renamed.updatedAt }
        : item) });
      return "";
    } catch (error) { return errorText(error); }
  };
  select = (id: string | null) => {
    this.selectionVersion += 1;
    this.publish({ activeId: id, error: "", ...(this.state.running && !this.state.running.assistantId
      ? { running: { ...this.state.running, optimisticVisible: false } } : {}) });
  };
  newConversation = () => {
    this.selectionVersion += 1;
    this.composerVersion += 1;
    this.publish({ activeId: null, draft: "", draftContexts: [], error: "", ...(this.state.running && !this.state.running.assistantId
      ? { running: { ...this.state.running, optimisticVisible: false } } : {}) });
  };
  revealRunning = () => {
    if (!this.state.running) return false;
    this.selectionVersion += 1;
    this.publish({ activeId: this.state.running.conversationId,
      running: { ...this.state.running, optimisticVisible: true } });
    return true;
  };
  private replaceMessage(message: PaperChatMessage) {
    this.publish({ conversations: this.state.conversations.map((conversation) =>
      conversation.id === message.conversationId
        ? { ...conversation, updatedAt: message.updatedAt,
          messages: upsertMessage(conversation.messages, message) }
        : conversation),
    });
  }
  private finishMessage(status: "cancelled" | "failed", error = "") {
    const run = this.state.running;
    if (!run?.assistantId) return;
    const message = this.state.conversations.find((item) => item.id === run.conversationId)
      ?.messages.find((item) => item.id === run.assistantId);
    if (message?.status === "pending") this.replaceMessage({ ...message, status, error });
  }
  load = async (refresh = false): Promise<void> => {
    if (this.loading) return this.loading;
    if (this.state.loaded && !refresh) return;
    this.publish({ loading: true });
    const selectionVersion = this.selectionVersion;
    const titleVersions = new Map(this.titleVersions);
    const streamVersion = this.streamVersion;
    this.loading = (async () => {
      try {
        const response = await this.request(`/api/kb/chat?paperId=${encodeURIComponent(this.paperId)}`, { cache: "no-store" });
        const result: { conversations?: PaperChatConversation[]; configuration?: PaperChatConfiguration; error?: string } = await response.json();
        if (!response.ok) throw new Error(result.error || "无法加载对话历史。");
        if (!Array.isArray(result.conversations)) throw new Error("无法读取对话历史。");
        const conversations = result.conversations.map((conversation) => {
          const local = this.state.conversations.find((item) => item.id === conversation.id);
          const messages = conversation.messages.map((message) => {
            const previous = local?.messages.find((item) => item.id === message.id);
            // A concurrent GET may observe the server just before abort is persisted.
            return previous && message.status === "pending" &&
              (previous.status !== "pending" || this.state.running?.assistantId === previous.id)
              ? previous : message;
          });
          // Opening model settings can refresh history before the server's first
          // messages have reached the GET snapshot. Keep the live stream intact.
          if (local && this.state.running?.conversationId === local.id) {
            for (const message of local.messages) {
              if (!messages.some((item) => item.id === message.id)) messages.push(message);
            }
          }
          return { ...conversation,
            ...(local && (this.titleVersions.get(local.id) || 0) > (titleVersions.get(local.id) || 0)
              ? { title: local.title } : {}),
            messages };
        });
        // Never let an older history response erase a stream that just started.
        for (const local of this.state.conversations) {
          if (!conversations.some((item) => item.id === local.id) &&
            (this.state.running?.conversationId === local.id ||
              (this.startedConversations.get(local.id) || 0) > streamVersion)) conversations.unshift(local);
        }
        this.publish({ conversations, loaded: true,
          ...(result.configuration ? this.configurationState(result.configuration) : {}),
          ...(!this.state.loaded && selectionVersion === this.selectionVersion && !this.state.activeId
            ? { activeId: conversations[0]?.id || null } : {}),
        });
      } catch (error) {
        this.publish({ error: errorText(error) });
      } finally {
        this.loading = null;
        this.publish({ loading: false });
      }
    })();
    return this.loading;
  };
  send = async (attachmentId: string, text = this.state.draft): Promise<boolean> => {
    const conversation = this.state.conversations.find((item) => item.id === this.state.activeId);
    return this.submit(attachmentId, text, conversation);
  };
  private replaySource(messageId: string, role: "user" | "assistant") {
    if (this.controller || this.state.running || this.state.loading) return null;
    const conversation = this.state.conversations.find((item) => item.id === this.state.activeId && item.paperId === this.paperId);
    const index = conversation?.messages.findIndex((item) => item.id === messageId &&
      item.conversationId === conversation.id && item.role === role &&
      (role === "user" ? item.status === "completed" : item.status !== "pending")) ?? -1;
    if (!conversation || index < 0) {
      this.publish({ error: "此消息不在当前对话中，请重新选择后重试。" });
      return null;
    }
    return { conversation, index };
  }
  retryReply = async (assistantMessageId: string): Promise<boolean> => {
    const source = this.replaySource(assistantMessageId, "assistant");
    if (!source) return false;
    const question = source.conversation.messages.slice(0, source.index).reverse().find((item) =>
      item.role === "user" && item.conversationId === source.conversation.id);
    if (!question || question.status !== "completed") {
      this.publish({ error: "找不到这条回复对应的提问，请重新加载对话。" });
      return false;
    }
    return this.submit(source.conversation.attachmentId, question.body, source.conversation, {
      sourceConversationId: source.conversation.id, sourceMessageId: question.id, kind: "retry",
    });
  };
  editQuestion = async (userMessageId: string, text: string): Promise<boolean> => {
    const source = this.replaySource(userMessageId, "user");
    if (!source) return false;
    return this.submit(source.conversation.attachmentId, text, source.conversation, {
      sourceConversationId: source.conversation.id, sourceMessageId: userMessageId, kind: "edit",
    });
  };
  private submit = async (attachmentId: string, text: string, conversation?: PaperChatConversation,
    replay?: ChatReplay): Promise<boolean> => {
    const message = text.trim();
    if (!message || this.controller || this.state.running || this.state.loading) return false;
    if (!attachmentId) {
      this.publish({ error: "请先添加或选择这篇文献的 PDF。" });
      return false;
    }
    const conversationId = conversation?.id || null;
    const sourceAttachmentId = conversation?.attachmentId || attachmentId;
    const original = replay?.kind === "retry" ? conversation?.messages.find((item) => item.id === replay.sourceMessageId) : undefined;
    if (original && this.state.configuration && original.provider !== this.state.configuration.provider) {
      this.publish({ error: "模型服务已切换，请重新选择模型后作为新问题发送；原提问和资料仍保留。" }); return false;
    }
    const modelOverride = original?.model || this.state.modelOverride;
    const titleVersion = conversationId ? this.titleVersions.get(conversationId) || 0 : 0;
    const controller = new AbortController();
    this.controller = controller;
    const composerVersion = this.composerVersion;
    const contexts = (replay ? conversation?.messages.find((item) => item.id === replay.sourceMessageId)?.contexts || []
      : this.state.draftContexts).map((context) => ({ ...context }));
    const contextInputs: ChatContextInput[] = contexts.map(({ noteId, revision, field, mode, start, end }) => ({
      noteId, revision, mode, ...(field ? { field } : {}), ...(mode === "excerpt" ? { start, end } : {}),
    }));
    this.publish({ ...(!replay ? { draft: "", draftContexts: [] } : {}), error: "", running: {
      conversationId, attachmentId: sourceAttachmentId,
      message, assistantId: null, stopping: false, optimisticVisible: true,
      model: modelOverride || this.state.configuration?.model || "",
      contexts,
      startedAt: new Date().toISOString(), progress: null,
      ...(replay ? { replay } : {}),
    } });
    let terminal = false;
    let started = false;
    try {
      const response = await this.request("/api/kb/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperId: this.paperId,
          attachmentId: sourceAttachmentId,
          ...(replay ? { replay } : conversationId ? { conversationId } : {}),
          ...(modelOverride ? { model: modelOverride } : {}),
          ...(!replay && contextInputs.length ? { contexts: contextInputs } : {}), message }), signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error || `对话请求失败（${response.status}）。`);
      }
      await readChatEvents(response.body, (event) => {
        if (controller.signal.aborted) return;
        if (event.type === "start") {
          if (event.conversation.paperId !== this.paperId ||
            event.conversation.id !== event.conversationId ||
            event.conversation.attachmentId !== sourceAttachmentId ||
            (replay && event.conversationId === replay.sourceConversationId)) throw new Error("对话来源不一致，请重试。");
          started = true;
          this.startedConversations.set(event.conversationId, ++this.streamVersion);
          const local = this.state.conversations.find((item) => item.id === event.conversationId);
          const updated = { ...event.conversation,
            ...(local && (this.titleVersions.get(local.id) || 0) > titleVersion ? { title: local.title } : {}),
            messages: upsertMessage(upsertMessage(event.conversation.messages,
              event.userMessage), event.assistantMessage) };
          this.publish({ conversations: [updated, ...this.state.conversations.filter((item) => item.id !== updated.id)],
            ...(this.state.running?.optimisticVisible ? { activeId: updated.id } : {}),
            running: { ...this.state.running!, conversationId: updated.id, assistantId: event.assistantMessage.id,
              contexts: event.userMessage.contexts || [], startedAt: event.assistantMessage.createdAt,
              progress: event.assistantMessage.progress ?? null },
          });
        } else if (event.type === "progress") {
          const run = this.state.running;
          if (!run?.assistantId) throw new Error("对话进度顺序不正确。");
          const assistant = this.state.conversations.find((item) => item.id === run.conversationId)?.messages.find((item) => item.id === run.assistantId);
          if (!assistant) throw new Error("对话进度来源不一致。");
          this.replaceMessage({ ...assistant, progress: event.progress });
          this.publish({ running: { ...run, progress: event.progress } });
        } else if (event.type === "delta") {
          const run = this.state.running;
          const assistant = this.state.conversations.find((item) => item.id === run?.conversationId)
            ?.messages.find((item) => item.id === run?.assistantId);
          if (!assistant || typeof event.text !== "string") throw new Error("对话响应顺序不正确。");
          this.replaceMessage({ ...assistant, body: assistant.body + event.text });
        } else if (event.type === "done") {
          if (event.message.id !== this.state.running?.assistantId ||
            event.conversationId !== this.state.running?.conversationId) throw new Error("对话结果不一致。");
          this.replaceMessage(event.message);
          terminal = true;
        } else {
          terminal = true;
          if (event.messageRecord) this.replaceMessage(event.messageRecord);
          this.finishMessage("failed", event.message);
          this.publish({ error: event.message });
        }
      });
      if (!terminal && !controller.signal.aborted) throw new Error("连接已中断，已接收的内容保留，可以继续提问。");
    } catch (error) {
      if (controller.signal.aborted) this.finishMessage("cancelled");
      else {
        this.finishMessage("failed", errorText(error));
        this.publish({ error: errorText(error) });
        controller.abort();
      }
    } finally {
      this.controller = null;
      // A validation error may arrive as a successful HTTP response carrying an
      // NDJSON error event. Restore the complete unsent turn in either case,
      // while preserving a newer composer draft or a deliberately new chat.
      const restore = !replay && !started && composerVersion === this.composerVersion;
      this.publish({ running: null, ...(restore ? { draft: text, draftContexts: contexts } : {}) });
      // Reload terminal timestamps and any partial answer saved by cancellation.
      if (started) await this.load(true);
    }
    return replay ? started : true;
  };
  stop = () => {
    if (!this.controller || !this.state.running) return;
    this.finishMessage("cancelled");
    this.publish({ running: { ...this.state.running, stopping: true } });
    this.controller.abort();
  };
}

const clients = new Map<string, PaperChatClient>();
const activityListeners = new Set<() => void>();
const NO_ACTIVITIES: PaperChatActivity[] = [];
let activities = NO_ACTIVITIES;
function refreshActivities() {
  activities = [...clients.values()].flatMap((client) => {
    const run = client.getSnapshot().running;
    return run ? [{ paperId: client.paperId, paperTitle: client.paperTitle,
      conversationId: run.conversationId, stopping: run.stopping, startedAt: run.startedAt, progress: run.progress }] : [];
  });
  for (const listener of activityListeners) listener();
}
export function getPaperChatClient(paperId: string) {
  let client = clients.get(paperId);
  if (!client) {
    client = new PaperChatClient(paperId);
    clients.set(paperId, client);
  }
  return client;
}
export const getPaperChatActivities = () => activities;
export const getServerPaperChatActivities = () => NO_ACTIVITIES;
export const subscribePaperChatActivities = (listener: () => void) => {
  activityListeners.add(listener);
  return () => { activityListeners.delete(listener); };
};
