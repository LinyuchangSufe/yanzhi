import type { IdeaConversation, IdeaMessage, IdeaSourceInput, IdeaSourceSnapshot, IdeaSummary } from "../../lib/idea-lab/types";
import type { PaperChatConfiguration } from "../../lib/paper-chat/types";
import type { KBState } from "../../lib/types";
import { chatProgressSchema, type ChatProgress } from "../../lib/ai/chat-progress";
import { materialAdditionError, prepareIdeaMaterials, type SelectedIdeaMaterial } from "./idea-materials";

export interface IdeaUsage { historyMessages: number; historyCharacters: number; sourceCount: number; sourceCharacters: number }
interface Composer { draft: string; materials: SelectedIdeaMaterial[]; includeCurrentNote: boolean }
interface SendIntent extends Composer { conversationId: string; requestId: string; model: string; provider: string; preferenceKey: string }
interface IdeaModelOption { id: string; label: string }
export interface IdeaClientState extends Composer {
  loaded: boolean; loading: boolean; conversations: IdeaConversation[]; summaries: IdeaSummary[];
  configuration: PaperChatConfiguration | null; activeId: string; summaryId: string;
  running: boolean; summarizing: boolean; error: string; notice: string; storageError: string;
  usage: IdeaUsage | null; failed: SendIntent | null;
  modelOverride: string; modelNotice: string; modelOptions: IdeaModelOption[]; modelOptionsLoading: boolean; modelOptionsWarning: string;
  progress: ChatProgress | null; runStartedAt: string | null; runFinishedAt: string | null; runModel: string;
}

/** Failed turns retain their user record, but do not form completed discussion context. */
export function ideaCompletedTurns(messages: readonly IdeaMessage[]): IdeaMessage[] {
  const complete = new Set(messages.filter((message) => message.role === "assistant" && message.status === "completed" && message.body.trim())
    .map((message) => message.requestId));
  const questions = new Set(messages.filter((message) => message.role === "user" && message.status === "completed" && message.body.trim())
    .map((message) => message.requestId));
  return messages.filter((message) => complete.has(message.requestId) && questions.has(message.requestId) && message.status === "completed" && message.body.trim());
}
export function ideaDiscussionSources(messages: readonly IdeaMessage[]): IdeaSourceSnapshot[] {
  const sources = new Map<string, IdeaSourceSnapshot>();
  for (const message of ideaCompletedTurns(messages)) for (const source of message.sources) sources.set(source.id, source);
  return [...sources.values()];
}
export function ideaDiscussionIsLong(messages: readonly IdeaMessage[]): boolean {
  const complete = ideaCompletedTurns(messages);
  return complete.length >= 40 || complete.reduce((size, message) => size + message.body.length +
    (message.role === "user" ? message.sources.reduce((sum, source) => sum + source.text.length, 0) : 0), 0) >= 48000;
}
const label = (text: string) => text.replace(/[\r\n]+/g, " ").replace(/[\\\[\]]/g, "\\$&");
export function ideaSummaryHandoff(summary: IdeaSummary, question: string): string {
  const cited = new Set(summary.sections.flatMap((section) => section.sourceIds));
  return [`基于阶段小结《${summary.title}》（${summary.createdAt.slice(0, 10)}）继续讨论。`,
    "以下是上一阶段的 AI 辅助整理，判断与推测仍需核验。此轮只提供小结；来源链接用于定位，不代表重新读取原文。",
    ...summary.sections.map((section) => `## ${section.title}\n\n${section.body}`),
    ...summary.sources.filter((source) => cited.has(source.id)).map((source) => `- 来源定位：[${label(source.title)}](${source.sourceHref})`),
    `## 我接下来想讨论\n\n${question.trim() || "请基于小结继续推敲，优先指出待验证事项和下一步。"}`].join("\n\n");
}
type StreamEvent =
  | { type: "start"; conversationId: string; conversation: IdeaConversation; userMessage: IdeaMessage; assistantMessage: IdeaMessage; usage?: IdeaUsage }
  | { type: "delta"; text: string }
  | { type: "progress"; progress: ChatProgress }
  | { type: "done"; conversationId: string; message: IdeaMessage }
  | { type: "error"; message: string; status: number; conversationId?: string; messageRecord?: IdeaMessage };
type Transport = typeof fetch;
const empty = (): IdeaClientState => ({ draft: "", materials: [], includeCurrentNote: false, loaded: false, loading: false,
  conversations: [], summaries: [], configuration: null, activeId: "", summaryId: "", running: false, summarizing: false,
  error: "", notice: "", storageError: "", usage: null, failed: null,
  modelOverride: "", modelNotice: "", modelOptions: [], modelOptionsLoading: false, modelOptionsWarning: "",
  progress: null, runStartedAt: null, runFinishedAt: null, runModel: "" });
const clients = new Map<string, IdeaDiscussionClient>();
const activityListeners = new Set<() => void>();
let activities: { noteId: string; kind: "discussion" | "summary" }[] = [];
export const getIdeaActivities = () => activities;
export const subscribeIdeaActivities = (listener: () => void) => { activityListeners.add(listener); return () => { activityListeners.delete(listener); }; };
const serverActivities: typeof activities = [];
export const getServerIdeaActivities = () => serverActivities;
function refreshActivities() {
  activities = [...clients.values()].filter((client) => client.getSnapshot().running || client.getSnapshot().summarizing)
    .map((client) => ({ noteId: client.noteId, kind: client.getSnapshot().running ? "discussion" : "summary" }));
  for (const listener of activityListeners) listener();
}
function combineMessages(previous: IdeaMessage[], incoming: IdeaMessage[]) {
  const updates = new Map(incoming.map((message) => [message.id, message]));
  return [...previous.map((message) => updates.get(message.id) ?? message), ...incoming.filter((message) => !previous.some((item) => item.id === message.id))];
}
async function jsonResponse<T>(response: Response): Promise<T> {
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(value && typeof value === "object" && "error" in value ? String(value.error) : `请求失败（${response.status}）`);
  return value as T;
}

/** The controller outlives a mounted idea page, so navigation never cancels a turn. */
export class IdeaDiscussionClient {
  private state = empty();
  private serverState = this.state;
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private summaryController: AbortController | null = null;
  private composerVersion = 0;
  private draftVersion = 0;
  private includeVersion = 0;
  private loadedDraft = false;
  private selectionChosen = false;
  private loading: Promise<void> | null = null;
  private serial = 0;
  private preferenceKey = "";
  private modelOptionsRequest: Promise<void> | null = null;
  private modelOptionsVersion = 0;
  constructor(readonly noteId: string, private transport: Transport = (...args) => fetch(...args), private storage?: Storage | null,
    private modelStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null) {}
  getSnapshot = () => this.state;
  getServerSnapshot = () => this.serverState;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(value: Partial<IdeaClientState>) {
    const busy = this.state.running || this.state.summarizing;
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
    if (busy !== (this.state.running || this.state.summarizing)) refreshActivities();
  }
  private getStorage() { return this.storage === undefined ? typeof window === "undefined" ? null : window.sessionStorage : this.storage; }
  private getModelStorage() { return this.modelStorage === undefined ? typeof window === "undefined" ? null : window.localStorage : this.modelStorage; }
  private configurationState(configuration: PaperChatConfiguration): Partial<IdeaClientState> {
    const preferenceKey = `research-idea-chat-model:v1:${encodeURIComponent(this.noteId)}:${configuration.preferenceKey}`;
    if (preferenceKey === this.preferenceKey) return { configuration };
    this.preferenceKey = preferenceKey; this.modelOptionsRequest = null; this.modelOptionsVersion++;
    let modelOverride = "";
    try {
      const saved = this.getModelStorage()?.getItem(preferenceKey)?.trim() || "";
      if (saved.length <= 300 && !/[\u0000-\u001f\u007f]/.test(saved)) modelOverride = saved;
    } catch { /* An unavailable browser store must not prevent a discussion. */ }
    return { configuration, modelOverride, modelNotice: "", modelOptions: [], modelOptionsLoading: false, modelOptionsWarning: "" };
  }
  setModelOverride = (value: string): boolean => {
    const modelOverride = value.trim();
    if (modelOverride.length > 300 || /[\u0000-\u001f\u007f]/.test(modelOverride)) {
      this.publish({ modelNotice: "模型 ID 请使用 300 字符以内的单行文本。" }); return false;
    }
    if (!this.state.configuration || !this.preferenceKey) { this.publish({ modelNotice: "请先加载 AI 配置后再调整模型。" }); return false; }
    let modelNotice = "";
    try {
      const storage = this.getModelStorage();
      if (modelOverride) storage?.setItem(this.preferenceKey, modelOverride); else storage?.removeItem(this.preferenceKey);
    } catch { modelNotice = "模型已应用；浏览器无法保存偏好，刷新后将恢复全局默认。"; }
    this.publish({ modelOverride, modelNotice }); return true;
  };
  loadModelOptions = (): Promise<void> => {
    if (this.modelOptionsRequest) return this.modelOptionsRequest;
    const preferenceKey = this.preferenceKey, version = ++this.modelOptionsVersion;
    this.publish({ modelOptionsLoading: true, modelOptionsWarning: "" });
    this.modelOptionsRequest = Promise.resolve().then(async () => {
      try {
        const response = await this.transport("/api/kb/chat/models", { cache: "no-store" });
        const result: { provider?: string; models?: IdeaModelOption[]; warning?: string; error?: string } = await response.json();
        if (preferenceKey !== this.preferenceKey || version !== this.modelOptionsVersion) return;
        if (!response.ok) throw new Error(result.error || "暂时无法读取模型列表，可手动填写模型 ID。");
        if (result.provider !== this.state.configuration?.provider) throw new Error("AI 配置已变化，请重新加载后选择模型。");
        if (!Array.isArray(result.models)) throw new Error("无法读取模型列表，可手动填写模型 ID。");
        const seen = new Set<string>();
        const models = result.models.filter((item) => {
          if (!item || typeof item.id !== "string" || !item.id.trim() || item.id.length > 300 || /[\u0000-\u001f\u007f]/.test(item.id) ||
            typeof item.label !== "string" || seen.has(item.id)) return false;
          seen.add(item.id); return true;
        });
        this.publish({ modelOptions: models, modelOptionsWarning: result.warning || "" });
      } catch (error) {
        if (preferenceKey === this.preferenceKey && version === this.modelOptionsVersion)
          this.publish({ modelOptionsWarning: error instanceof Error ? error.message : "模型列表读取失败，可手动填写模型 ID。" });
      } finally {
        if (version === this.modelOptionsVersion) { this.modelOptionsRequest = null; this.publish({ modelOptionsLoading: false }); }
      }
    });
    return this.modelOptionsRequest;
  };
  persist = (): boolean => {
    try {
      const storage = this.getStorage();
      if (!storage) return !this.state.draft && !this.state.materials.length;
      const value = { draft: this.state.draft, materials: this.state.materials, includeCurrentNote: this.state.includeCurrentNote, activeId: this.state.activeId };
      if (value.draft || value.materials.length || value.includeCurrentNote || this.selectionChosen || value.activeId) storage.setItem(`research-idea-composer:${this.noteId}`, JSON.stringify(value));
      else storage.removeItem(`research-idea-composer:${this.noteId}`);
      if (this.state.storageError) this.publish({ storageError: "" });
      return true;
    } catch {
      if (!this.state.draft && !this.state.materials.length) return true;
      this.publish({ storageError: "本窗口无法保存讨论草稿，请先复制输入；暂时不要关闭页面。" }); return false;
    }
  };
  private restoreDraft() {
    if (this.loadedDraft) return;
    this.loadedDraft = true;
    try {
      const raw = this.getStorage()?.getItem(`research-idea-composer:${this.noteId}`);
      if (!raw) return;
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || !("draft" in value) || typeof value.draft !== "string" ||
          !("materials" in value) || !Array.isArray(value.materials) || value.materials.length > 8) return;
      const materials = value.materials.filter((item: unknown): item is SelectedIdeaMaterial => Boolean(item && typeof item === "object" &&
        "key" in item && typeof item.key === "string" && "text" in item && typeof item.text === "string" &&
        "title" in item && typeof item.title === "string" && "input" in item && item.input && typeof item.input === "object"));
      this.publish({ draft: value.draft.slice(0, 12000), materials,
        includeCurrentNote: "includeCurrentNote" in value && value.includeCurrentNote === true });
      if ("activeId" in value && typeof value.activeId === "string") {
        this.selectionChosen = true; this.publish({ activeId: value.activeId });
      }
    } catch { this.publish({ storageError: "讨论草稿暂时无法恢复，请检查浏览器存储。" }); }
  }
  setDraft = (draft: string) => { this.composerVersion++; this.draftVersion++; this.publish({ draft }); this.persist(); };
  setIncludeNote = (includeCurrentNote: boolean) => { this.composerVersion++; this.includeVersion++; this.publish({ includeCurrentNote }); this.persist(); };
  addMaterial = (material: SelectedIdeaMaterial): boolean => {
    const error = materialAdditionError(this.state.materials, material);
    if (error) { this.publish({ error }); return false; }
    this.composerVersion++; this.publish({ materials: [...this.state.materials, { ...material, input: { ...material.input } }], error: "" }); this.persist(); return true;
  };
  removeMaterial = (key: string) => {
    this.composerVersion++; this.publish({ materials: this.state.materials.filter((item) => item.key !== key) }); this.persist();
  };
  chooseConversation = (activeId: string) => {
    if (this.state.running || this.state.summarizing) return;
    this.selectionChosen = true; this.publish({ activeId, error: "", notice: "", usage: null, failed: null }); this.persist();
  };
  startFromSummary = (summary: IdeaSummary): boolean => {
    if (this.state.running || this.state.summarizing) return false;
    if (summary.noteId !== this.noteId || !this.state.summaries.some((item) => item.id === summary.id)) {
      this.publish({ error: "这份小结不属于当前想法，请重新打开整理稿。" }); return false;
    }
    const draft = ideaSummaryHandoff(summary, this.state.draft);
    if (draft.length > 12000) {
      this.publish({ error: "小结与后续问题超过 12,000 字符，请先精简后再开启新讨论；原输入和讨论保留。" }); return false;
    }
    this.composerVersion++; this.draftVersion++; this.selectionChosen = true;
    this.publish({ activeId: "", draft, failed: null, error: "", usage: null,
      notice: "已用阶段小结准备新讨论，原讨论保留。检查后点击发送；已有草稿和待发资料已保留。" });
    this.persist(); return true;
  };
  prepareFromSources = (state: KBState, sources: readonly IdeaSourceInput[], prompt?: string): boolean => {
    this.restoreDraft();
    try {
      if (!state.notes.some((note) => note.id === this.noteId && note.purpose === "idea")) throw new Error("请先选择或创建一个想法，再继续推敲资料。");
      const materials = prepareIdeaMaterials(state, this.noteId, sources, this.state.materials);
      const question = prompt?.trim() || "请基于这些资料，帮我梳理问题、证据之间的联系和下一步值得验证的方向。";
      const draft = !this.state.draft.trim() ? question : this.state.draft.trim() === question ? this.state.draft : `${this.state.draft}\n\n${question}`;
      if (draft.length > 12000) throw new Error("已有草稿与后续问题超过 12,000 字符，请先精简；原草稿和资料保留。");
      const noteLength = this.state.includeCurrentNote ? state.notes.find((note) => note.id === this.noteId)!.body.length : 0;
      if (materials.length + Number(this.state.includeCurrentNote) > 8 || materials.reduce((sum, item) => sum + item.text.length, noteLength) > 24000)
        throw new Error("资料与工作笔记超过本次 8 项或 24,000 字符上限，请先减少待发送资料；原草稿保留。");
      this.composerVersion++; this.draftVersion++;
      this.publish({ draft, materials, error: "", notice: "已准备好资料和问题，请核对后发送；已有草稿和对话保留。" });
      return this.persist();
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : "资料交接失败，请重新预览；原草稿保留。" }); return false;
    }
  };
  chooseSummary = (summaryId: string) => this.publish({ summaryId });
  clearError = () => this.publish({ error: "" });
  clearNotice = () => this.publish({ notice: "" });
  load = (force = false): Promise<void> => {
    this.restoreDraft();
    if (this.loading) return this.loading;
    if ((this.state.loaded && !force) || this.state.running || this.state.summarizing) return Promise.resolve();
    this.publish({ loading: true });
    this.loading = (async () => {
      try {
        const data = await jsonResponse<{ conversations: IdeaConversation[]; summaries: IdeaSummary[]; configuration: PaperChatConfiguration }>(
          await this.transport(`/api/kb/idea-lab?noteId=${encodeURIComponent(this.noteId)}`, { cache: "no-store" }));
        this.publish({ conversations: data.conversations, summaries: data.summaries, ...this.configurationState(data.configuration),
          activeId: (this.state.loaded || this.selectionChosen) && !this.state.activeId ? "" : data.conversations.some((item) => item.id === this.state.activeId) ? this.state.activeId : data.conversations[0]?.id ?? "",
          summaryId: data.summaries.some((item) => item.id === this.state.summaryId) ? this.state.summaryId : data.summaries[0]?.id ?? "", loaded: true,
          error: this.state.failed ? this.state.error : "" });
      } catch (error) { this.publish({ error: error instanceof Error ? error.message : "读取想法讨论失败，请重试。" }); }
      finally { this.loading = null; this.publish({ loading: false }); }
    })();
    return this.loading;
  };
  private putConversation(conversation: IdeaConversation) {
    this.publish({ conversations: [conversation, ...this.state.conversations.filter((item) => item.id !== conversation.id)] });
  }
  private updateMessage(conversationId: string, message: IdeaMessage) {
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (conversation) this.putConversation({ ...conversation, updatedAt: message.updatedAt,
      messages: combineMessages(conversation.messages, [message]) });
  }
  send = async (prepare: () => Promise<number>, retry = false): Promise<void> => {
    if (this.state.running || this.state.summarizing) return;
    const intent: SendIntent = retry && this.state.failed ? { ...this.state.failed, requestId: crypto.randomUUID() } : {
      draft: this.state.draft, materials: this.state.materials.map((item) => ({ ...item, input: { ...item.input } })),
      includeCurrentNote: this.state.includeCurrentNote, conversationId: this.state.activeId, requestId: crypto.randomUUID(),
      model: this.state.modelOverride || this.state.configuration?.model || "", preferenceKey: this.state.configuration?.preferenceKey || "",
      provider: this.state.configuration?.provider || "",
    };
    if (!intent.draft.trim()) return;
    const sameComposer = this.state.draft === intent.draft && this.state.includeCurrentNote === intent.includeCurrentNote &&
      JSON.stringify(this.state.materials.map((item) => item.input)) === JSON.stringify(intent.materials.map((item) => item.input));
    const composerVersion = this.composerVersion;
    const draftVersion = this.draftVersion, includeVersion = this.includeVersion;
    const sentMaterials = new Set(this.state.materials.filter((material) => intent.materials.some((sent) =>
      sent.key === material.key && JSON.stringify(sent.input) === JSON.stringify(material.input))));
    const token = ++this.serial;
    const controller = new AbortController(); this.controller = controller;
    let liveMessage: IdeaMessage | null = null, conversationId = intent.conversationId, completed = false, started = false;
    let streamInterrupted = false, serverError = false;
    this.publish({ running: true, error: "", notice: "", failed: null, progress: null,
      runStartedAt: new Date().toISOString(), runFinishedAt: null, runModel: intent.model });
    try {
      if (retry && ((intent.preferenceKey && intent.preferenceKey !== this.state.configuration?.preferenceKey) ||
          (intent.provider && intent.provider !== this.state.configuration?.provider)))
        throw new Error("AI 服务配置已变化。请恢复原服务后重试，或将原提问作为新请求发送；原模型与草稿保留。");
      const revision = await prepare();
      if (controller.signal.aborted) throw new Error("讨论已停止。");
      const response = await this.transport("/api/kb/idea-lab", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ action: "send", noteId: this.noteId, ...(conversationId ? { conversationId } : {}),
          requestId: intent.requestId, message: intent.draft, sources: intent.materials.map((item) => item.input), includeCurrentNote: intent.includeCurrentNote, revision,
          ...(intent.model ? { model: intent.model } : {}) }) });
      if (!response.ok) { serverError = true; await jsonResponse(response); }
      if (!response.body) throw new Error("没有收到讨论响应，请重试。");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      const consume = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line) as StreamEvent;
        if (event.type === "start") {
          if (!event.conversation || !event.userMessage || !event.assistantMessage) throw new Error("讨论响应格式异常。");
          started = true; conversationId = event.conversationId; liveMessage = event.assistantMessage;
          this.putConversation({ ...event.conversation, messages: combineMessages(event.conversation.messages, [event.userMessage, event.assistantMessage]) });
          this.publish({ activeId: conversationId, usage: event.usage ?? null, runStartedAt: event.assistantMessage.createdAt,
            ...(event.assistantMessage.progress ? { progress: event.assistantMessage.progress } : {}), runModel: event.assistantMessage.model || intent.model });
          // Consume the sent fields independently: typing the next question must not reattach old materials.
          this.publish({
            ...(draftVersion === this.draftVersion && this.state.draft === intent.draft ? { draft: "" } : {}),
            materials: this.state.materials.filter((material) => !sentMaterials.has(material)),
            ...(intent.includeCurrentNote && includeVersion === this.includeVersion ? { includeCurrentNote: false } : {}),
          });
          this.persist();
        } else if (event.type === "progress") {
          const parsed = chatProgressSchema.safeParse(event.progress);
          if (!parsed.success) throw new Error("运行进度格式异常，已收到的回复仍保留。");
          this.publish({ progress: parsed.data });
          if (liveMessage) { liveMessage = { ...liveMessage, progress: parsed.data }; this.updateMessage(conversationId, liveMessage); }
        } else if (event.type === "delta") {
          if (!liveMessage || typeof event.text !== "string") throw new Error("讨论响应顺序异常。");
          liveMessage = { ...liveMessage, body: liveMessage.body + event.text }; this.updateMessage(conversationId, liveMessage);
        } else if (event.type === "done") {
          completed = true; liveMessage = event.message; this.updateMessage(event.conversationId, event.message);
          this.publish({ failed: null, progress: null, runFinishedAt: event.message.updatedAt });
        } else if (event.type === "error") {
          serverError = true;
          if (event.messageRecord) { liveMessage = event.messageRecord; this.updateMessage(event.conversationId ?? conversationId, event.messageRecord); }
          throw new Error(event.message || "讨论生成失败，请重试。");
        } else throw new Error("讨论响应格式异常。");
      };
      try {
        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try { chunk = await reader.read(); } catch (error) { streamInterrupted = true; throw error; }
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
          for (const line of lines) consume(line);
          if (buffer.length > 1_000_000) throw new Error("讨论响应过长，请停止后重试。");
        }
        buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
      } finally { await reader.cancel().catch(() => {}); }
      if (!completed) { streamInterrupted = true; throw new Error("连接中断。"); }
    } catch (error) {
      if (token !== this.serial) return;
      const partial = liveMessage as IdeaMessage | null;
      const retained = partial?.body.trim() ? "已收到的部分正文保留，提问和笔记保留。" : "本次尚未收到正文，提问和笔记保留。";
      const localInterruption = !serverError && (controller.signal.aborted || streamInterrupted);
      const interruption = `${controller.signal.aborted ? "讨论已停止" : "连接中断"}，${retained}${controller.signal.aborted ? "" : "可重试原提问。"}`;
      if (partial && partial.status === "pending") this.updateMessage(conversationId, { ...partial,
        status: controller.signal.aborted ? "cancelled" : "failed", updatedAt: new Date().toISOString(),
        error: localInterruption ? interruption : "回复未完成。" });
      if ((!retry || sameComposer) && composerVersion === this.composerVersion) {
        this.publish({ draft: intent.draft, materials: intent.materials, includeCurrentNote: intent.includeCurrentNote }); this.persist();
      }
      this.publish({ error: localInterruption ? interruption : error instanceof Error ? error.message : "讨论失败，请重试。",
        failed: { ...intent, conversationId: started ? conversationId : intent.conversationId } });
    } finally {
      if (token === this.serial) { this.controller = null; this.publish({ running: false, progress: null, runFinishedAt: this.state.runFinishedAt || new Date().toISOString() }); }
    }
  };
  stop = () => { this.controller?.abort(); this.summaryController?.abort(); };
  summarize = async (messageIds: string[], prepare: () => Promise<number>): Promise<IdeaSummary | null> => {
    if (this.state.running || this.state.summarizing || !this.state.activeId || !messageIds.length) return null;
    if (messageIds.length > 100) {
      this.publish({ error: "这段讨论较长，请用‘选择整理范围’分阶段整理，每次最多 100 条消息；没有截断讨论。" }); return null;
    }
    const conversationId = this.state.activeId;
    const model = this.state.modelOverride || this.state.configuration?.model || "";
    const controller = new AbortController(); this.summaryController = controller;
    this.publish({ summarizing: true, error: "", notice: "", progress: null,
      runStartedAt: new Date().toISOString(), runFinishedAt: null, runModel: model });
    try {
      const revision = await prepare();
      if (controller.signal.aborted) throw new Error("整理已取消。");
      const { summary } = await jsonResponse<{ summary: IdeaSummary }>(await this.transport("/api/kb/idea-lab", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ action: "summarize", noteId: this.noteId, conversationId, messageIds, revision, requestId: crypto.randomUUID(), ...(model ? { model } : {}) }),
      }));
      this.publish({ summaries: [summary, ...this.state.summaries.filter((item) => item.id !== summary.id)], summaryId: summary.id,
        notice: "阶段整理稿已保存，预览确认后即可写入工作笔记。" }); return summary;
    } catch (error) { this.publish({ error: controller.signal.aborted ? "整理已取消，讨论与笔记保留。" : error instanceof Error ? error.message : "整理失败，请重试。" }); return null; }
    finally { this.summaryController = null; this.publish({ summarizing: false, progress: null, runFinishedAt: new Date().toISOString() }); }
  };
}
export function ideaDiscussionClient(noteId: string) {
  let client = clients.get(noteId);
  if (!client) { client = new IdeaDiscussionClient(noteId); clients.set(noteId, client); }
  return client;
}
