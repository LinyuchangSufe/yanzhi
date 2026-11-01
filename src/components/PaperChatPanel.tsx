"use client";

import { ArrowDown, Check, Copy, Ellipsis, FileText, LoaderCircle, MessageCircle, NotebookPen, Pencil, Plus, RotateCcw, Send, Square, X } from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  EMPTY_CHAT_STATE, getPaperChatActivities, getPaperChatClient,
  getServerPaperChatActivities, subscribePaperChatActivities,
} from "../lib/paper-chat/client";
import type { ChatScope, PaperChatMessage } from "../lib/paper-chat/types";
import { aiErrorRecovery } from "../lib/ai-error-recovery";
import Markdown from "./Markdown";
import TooltipButton from "./TooltipButton";
import { ChatContextPicker } from "./ChatContextPicker";
import { ChatContextReferences } from "./ChatContextReferences";
import ChatRunStatus from "./ai/ChatRunStatus";
import ChatHeader from "./chat/ChatHeader";
import ChatModelPicker from "./chat/ChatModelPicker";
import { useChatPopover } from "./chat/useChatPopover";
import { createPortal } from "react-dom";
import styles from "./PaperChatPanel.module.css";

interface Props {
  paperId: string;
  paperTitle?: string;
  attachmentId?: string;
  attachmentName?: string;
  attachments?: { id: string; filename: string; status: string }[];
  disabled?: boolean;
  onInsert: (text: string) => void;
  onNavigate?: (href: string) => void;
  onSettings?: () => void;
  onFindPaper?: (query?: string) => void;
}

export function usePaperChatActivities() {
  return useSyncExternalStore(subscribePaperChatActivities, getPaperChatActivities, getServerPaperChatActivities);
}

function pageRange(indices: number[]) {
  const pages = [...new Set(indices)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const first = pages[i];
    let last = first;
    while (pages[i + 1] === last + 1) last = pages[++i];
    ranges.push(first === last ? `${first + 1}` : `${first + 1}–${last + 1}`);
  }
  return ranges.join("、");
}

function ActionButton({ label, hint, children, disabled = false, type = "button", withText = false, onClick }: {
  label: string; hint?: string; children: ReactNode; disabled?: boolean; end?: boolean;
  type?: "button" | "submit"; withText?: boolean; onClick?: () => void;
}) {
  return <TooltipButton type={type} className={`${styles.messageAction} ${withText ? styles.messageActionText : ""}`} aria-label={label}
      tooltip={hint ? `${label}：${hint}` : label} disabled={disabled} onClick={onClick}>
      {children}
    </TooltipButton>;
}

const Question = memo(function Question({ message, replayDisabled, onEdit, onNavigate }: {
  message: PaperChatMessage; replayDisabled: boolean;
  onEdit: (id: string, text: string) => Promise<boolean>;
  onNavigate: Props["onNavigate"];
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(message.body);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const editorId = useId();
  const editor = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  useEffect(() => {
    if (editing && editor.current) {
      editor.current.focus();
      editor.current.setSelectionRange(editor.current.value.length, editor.current.value.length);
    }
  }, [editing]);
  const cancel = () => {
    if (saving) return;
    setEditing(false); setNotice("");
    requestAnimationFrame(() => editButton.current?.querySelector("button")?.focus());
  };
  const save = async () => {
    if (replayDisabled || submitting.current || !text.trim()) return;
    submitting.current = true; setSaving(true); setNotice("");
    try {
      if (await onEdit(message.id, text)) setEditing(false);
      else setNotice("未发送成功，修改内容已保留。");
    } catch { setNotice("未发送成功，修改内容已保留。"); }
    finally { submitting.current = false; setSaving(false); }
  };
  return <article className={styles.userMessage} data-message-role="user" aria-label="我的提问">
    {editing ? <form className={styles.questionEditor} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label htmlFor={editorId} className={styles.srOnly}>编辑历史提问</label>
      <textarea id={editorId} ref={editor} value={text} maxLength={12000} rows={4}
        disabled={saving || replayDisabled} onChange={(event) => { setText(event.target.value); setNotice(""); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.preventDefault(); cancel(); }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
        }} />
      <p className={styles.editHint}>修改后从此处开启新对话，原对话保留。{Boolean(message.contexts?.length) && "沿用此提问当时的引用快照。"}</p>
      <div className={styles.editFooter}>
        <span>⌘ / Ctrl + Enter 发送</span>
        <div className={styles.editActions}>
          <ActionButton label="取消编辑" onClick={cancel} disabled={saving} end><X size={15} aria-hidden="true" /></ActionButton>
          <ActionButton label={saving ? "正在发送" : "发送修改"} type="submit" disabled={replayDisabled || saving || !text.trim()} end>
            {saving ? <LoaderCircle size={15} className={styles.spin} aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
          </ActionButton>
        </div>
      </div>
      {notice && <p className={styles.messageError} role="status">{notice}</p>}
    </form> : <>
      <div className={styles.user}><p>{message.body}</p></div>
      <div className={styles.questionActions} ref={editButton}>
        <ActionButton label="编辑提问" hint="修改后从此处开启新对话，原对话保留。" disabled={replayDisabled} end
          onClick={() => { setText(message.body); setNotice(""); setEditing(true); }}><Pencil size={15} aria-hidden="true" /></ActionButton>
      </div>
    </>}
    {Boolean(message.contexts?.length) && <div className={styles.questionContexts}><ChatContextReferences contexts={message.contexts!} onNavigate={onNavigate} /></div>}
  </article>;
});

function ScopeDetails({ scope, message }: { scope: ChatScope; message: PaperChatMessage }) {
  return <details className={styles.scope}>
    <summary>实际读取：{scope.truncated ? "部分正文" : "PDF 正文文本"} · {scope.pageIndices.length} / {scope.totalPages} 页</summary>
    <p>物理页 {pageRange(scope.pageIndices) || "无可解析文本"} · {scope.characterCount.toLocaleString("zh-CN")} 字符<br />
      带入 {scope.historyMessages} 条历史消息{scope.historyTruncated ? "（历史已截取）" : ""}<br />
      {message.provider}{message.model ? ` · ${message.model}` : ""}</p>
    {scope.truncated && <p>受上下文长度限制，仅使用上述范围；未读取的部分不作为结论依据。</p>}
  </details>;
}

const Reply = memo(function Reply({ message, paperId, attachmentId, onInsert, onNavigate, onFindPaper, replayDisabled, onRetry }: {
  message: PaperChatMessage; paperId: string; attachmentId: string;
  onInsert: Props["onInsert"]; onNavigate: Props["onNavigate"];
  onFindPaper: Props["onFindPaper"];
  replayDisabled: boolean; onRetry: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const displayedBody = useDeferredValue(message.body);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const finished = message.status !== "pending";
  const partial = message.status === "cancelled" || message.status === "failed";
  return <article className={styles.assistant} data-message-role="assistant" data-message-status={message.status}>
    <div className={styles.messageLabel}>
      <MessageCircle size={13} aria-hidden="true" />
      <span>研知 AI{message.status === "cancelled" ? " · 已停止，内容未完整" : message.status === "failed" ? " · 生成未完成" : ""}</span>
    </div>
    <ChatRunStatus progress={message.progress} startedAt={message.createdAt} active={!finished}
      finishedAt={message.updatedAt} label={message.provider === "codex" ? "Codex" : "AI"} compact={finished} />
    {message.body ? <Markdown body={displayedBody} onNavigate={onNavigate} onFindPaper={onFindPaper} literatureLinks={message.literatureSources} copyAsMarkdown
      paperReferenceScope={{ paperId, attachmentId }} /> : <p className={styles.waiting}>
      {finished ? (message.status === "cancelled" ? "已停止，本次尚未收到回复。" : "本次没有生成回复。") : <><LoaderCircle size={13} className={styles.spin} /> 等待回复，可继续阅读…</>}
    </p>}
    {message.error && <p className={styles.messageError}>{message.error}</p>}
    {message.scope && <ScopeDetails scope={message.scope} message={message} />}
    {finished && <div className={styles.replyActions} role="group" aria-label="回复操作">
      {Boolean(message.body.trim()) && <ActionButton label={copied ? "已复制" : "复制"} hint={partial ? "复制已生成内容的 Markdown" : "复制 Markdown"} onClick={async () => {
        try {
          await navigator.clipboard.writeText(message.body);
          setCopyError(""); setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1800);
        } catch { setCopyError("复制失败，可选中回复后按 ⌘/Ctrl+C。"); }
      }}>{copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}</ActionButton>}
      <ActionButton label="重试" hint="从这条提问开启新对话并重新回答，先前回答保留。"
        disabled={replayDisabled} onClick={() => onRetry(message.id)}><RotateCcw size={15} aria-hidden="true" /></ActionButton>
      {Boolean(message.body.trim()) && <ActionButton label="添加到笔记" withText onClick={() => onInsert(`\n> ${message.body.replace(/\n/g, "\n> ")}\n> — AI 对话${partial ? "（生成未完整）" : ""}${message.model ? ` · ${message.model}` : ""} · [文献原文](kb://paper/${paperId})\n\n`)}>
        <NotebookPen size={15} aria-hidden="true" /><span>添加到笔记</span>
      </ActionButton>}
    </div>}
    {copyError && <p className={styles.messageError} role="status">{copyError}</p>}
  </article>;
});

/** Local adaptation of Papernook's per-paper ChatPanel; upstream is MIT licensed. */
export default function PaperChatPanel({ paperId, paperTitle, attachmentId, attachmentName,
  attachments, disabled = false, onInsert, onNavigate, onSettings, onFindPaper }: Props) {
  const client = useMemo(() => getPaperChatClient(paperId), [paperId]);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, () => EMPTY_CHAT_STATE);
  const retryReply = useCallback((id: string) => { void client.retryReply(id); }, [client]);
  const editQuestion = useCallback((id: string, text: string) => client.editQuestion(id, text), [client]);
  const [attachmentChoice, setAttachmentChoice] = useState({ readerId: attachmentId, id: attachmentId || "" });
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string; saving: boolean; error: string } | null>(null);
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const more = useChatPopover();
  const composerId = useId();
  const renameId = useId();
  useEffect(() => { client.paperTitle = paperTitle || "论文对话"; void client.load(true); }, [client, paperTitle]);
  const availableAttachments = attachments?.filter((item) => item.status === "available") || [];
  const conversation = state.conversations.find((item) => item.id === state.activeId);
  const defaultAttachment = availableAttachments.some((item) => item.id === attachmentId)
    ? attachmentId! : availableAttachments[0]?.id || (attachments ? "" : attachmentId || "");
  const selectedAttachment = attachmentChoice.readerId === attachmentId ? attachmentChoice.id : defaultAttachment;
  const effectiveAttachment = conversation?.attachmentId ||
    (availableAttachments.some((item) => item.id === selectedAttachment) ? selectedAttachment : defaultAttachment);
  const sourceName = attachments?.find((item) => item.id === effectiveAttachment)?.filename ||
    (effectiveAttachment === attachmentId ? attachmentName : "该会话关联的 PDF") || "当前 PDF";
  const activeRunning = Boolean(state.running && state.running.conversationId === state.activeId &&
    (state.running.assistantId || state.running.optimisticVisible));
  const preparing = activeRunning && !state.running?.assistantId && state.running?.optimisticVisible;
  const replayDisabled = disabled || state.loading || Boolean(state.running);
  const currentMessages = conversation?.messages || [];
  const latestMessage = currentMessages[currentMessages.length - 1];
  const failedReply = [...currentMessages].reverse().find((item) => item.role === "assistant" && item.status === "failed");
  const recovery = aiErrorRecovery(state.error);
  const shownScope = [...currentMessages].reverse().find((item) => item.role === "assistant" && item.scope)?.scope;
  const lastActualModel = [...currentMessages].reverse().find((item) => item.role === "assistant" && item.model && item.status !== "pending")?.model;
  const configuration = state.configuration;
  useEffect(() => { setRenaming(null); more.close(false); }, [client, state.activeId, more.close]);
  useEffect(() => { setContextPickerOpen(false); }, [client]);
  useEffect(() => {
    // Only opening a conversation changes scroll position; streamed tokens do not.
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    setAwayFromBottom(false);
  }, [paperId, state.activeId]);
  const jumpToLatest = () => {
    const element = scroll.current;
    if (element) element.scrollTop = element.scrollHeight;
    setAwayFromBottom(false);
  };
  const send = () => {
    if (disabled || !state.draft.trim() || state.running) return;
    void client.send(effectiveAttachment);
  };
  const saveName = async () => {
    if (!renaming || renaming.saving) return;
    const { id, title } = renaming;
    setRenaming({ ...renaming, saving: true, error: "" });
    const error = await client.renameConversation(id, title);
    setRenaming((current) => current?.id === id ? error ? { ...current, saving: false, error } : null : current);
  };

  return <section className={styles.panel} aria-label="论文对话" data-paper-chat>
    <ChatHeader title="论文对话" conversations={state.conversations} activeId={state.activeId}
      onSelect={(id) => { if (!id) setAttachmentChoice({ readerId: attachmentId, id: defaultAttachment }); client.select(id || null); }}
      onNew={() => { setAttachmentChoice({ readerId: attachmentId, id: defaultAttachment }); client.newConversation(); }} disabled={disabled} historyDisabled={false} loading={state.loading}
      modelControl={<ChatModelPicker scopeLabel="本篇论文" configuration={configuration} modelOverride={state.modelOverride}
        modelOptions={state.modelOptions} modelOptionsLoading={state.modelOptionsLoading} modelOptionsWarning={state.modelOptionsWarning} modelNotice={state.modelNotice}
        runningModel={state.running?.model} onSetModel={client.setModelOverride}
        onOpen={async () => { more.close(false); await client.load(true); await client.loadModelOptions(); }} onRefresh={client.loadModelOptions} onSettings={onSettings} />} />
    {renaming && <form className={styles.renameForm} onSubmit={(event) => { event.preventDefault(); void saveName(); }}>
      <label htmlFor={renameId}>对话名称</label>
      <div className={styles.renameFields}>
        <input id={renameId} value={renaming.title} maxLength={120} disabled={renaming.saving} autoFocus
          onChange={(event) => setRenaming({ ...renaming, title: event.target.value, error: "" })}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !renaming.saving) { event.preventDefault(); setRenaming(null); window.requestAnimationFrame(() => more.trigger.current?.focus()); }
            if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
          }} />
        <button type="submit" disabled={renaming.saving || !renaming.title.trim()}>{renaming.saving ? "保存中" : "保存"}</button>
        <button type="button" disabled={renaming.saving} onClick={() => { setRenaming(null); window.requestAnimationFrame(() => more.trigger.current?.focus()); }}>取消</button>
      </div>
      {renaming.error && <p className={styles.messageError} role="alert">{renaming.error}</p>}
    </form>}
    <div className={styles.messages} ref={scroll} role="region" aria-label="论文对话记录"
      onScroll={() => {
        const element = scroll.current;
        if (element) setAwayFromBottom(element.scrollHeight - element.clientHeight - element.scrollTop > 90);
      }}>
      {!currentMessages.length && !preparing && <div className={styles.empty}>
        <MessageCircle size={23} strokeWidth={1.4} aria-hidden="true" />
        <h4>边读，边追问。</h4>
        <p>结合这篇论文的正文与对话历史回答，公式、章节和图表引用可点击定位。</p>
        <div className={styles.suggestions}>
          {["这篇论文解决了什么问题？", "请解释核心方法与关键假设。", "哪些结论值得进一步验证？"].map((text) =>
            <button type="button" key={text} onClick={() => client.setDraft(text)} disabled={disabled}>{text}</button>)}
        </div>
      </div>}
      {currentMessages.map((message) => message.role === "user"
        ? <Question key={message.id} message={message} replayDisabled={replayDisabled} onEdit={editQuestion} onNavigate={onNavigate} />
        : <Reply key={message.id} message={message} paperId={paperId} attachmentId={conversation!.attachmentId}
          onInsert={onInsert} onNavigate={onNavigate} onFindPaper={onFindPaper} replayDisabled={replayDisabled} onRetry={retryReply} />)}
      {preparing && <>
        {!state.running?.replay && <article className={styles.userMessage} data-message-role="user" aria-label="我的提问">
          <div className={styles.user}><p>{state.running!.message}</p></div>
          {Boolean(state.running!.contexts.length) && <div className={styles.questionContexts}><ChatContextReferences contexts={state.running!.contexts} onNavigate={onNavigate} /></div>}
        </article>}
        <p className={styles.waiting}><LoaderCircle size={13} className={styles.spin} />{state.running?.replay ? "正在准备重新生成…" : "正在准备论文上下文…"}</p>
        {state.running?.startedAt && <ChatRunStatus startedAt={state.running.startedAt} label="准备资料" />}
      </>}
    </div>
    {(state.running || awayFromBottom) && <div className={styles.progress}>
      <span role="status" aria-live="polite">{state.running
        ? state.running.stopping ? "正在停止，已接收内容保留。" : activeRunning ? "正在生成，可继续阅读或切换页面。" : "另一段对话正在生成。"
        : latestMessage?.status === "cancelled" ? "已停止生成。" : "可查看最新回复。"}</span>
      {!activeRunning && state.running && <button type="button" onClick={client.revealRunning}>查看生成中的对话</button>}
      {(activeRunning || awayFromBottom) && <button type="button" onClick={jumpToLatest}><ArrowDown size={12} />最新回复</button>}
    </div>}
    {state.error && <div className={styles.error} role="alert"><p>{state.error}</p>
      <p>{recovery.hint}</p>
      {!state.loaded && <button type="button" onClick={() => void client.load(true)}>重新加载</button>}
      {state.loaded && state.draft.trim() && <button type="button" disabled={disabled || Boolean(state.running) || !effectiveAttachment} onClick={send}>重试发送</button>}
      {state.loaded && !state.draft.trim() && failedReply && <button type="button" disabled={replayDisabled} onClick={() => retryReply(failedReply.id)}>重试本次提问</button>}
      {onSettings && recovery.kind === "configuration" && <button type="button" onClick={onSettings}>检查 AI 设置</button>}
    </div>}
    <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); send(); }}>
      <label htmlFor={composerId} className={styles.composerLabel}>继续追问</label>
      <textarea id={composerId} placeholder={disabled ? "请先恢复这篇文献，再开始对话" : "输入问题，或继续追问这篇论文…"}
        value={state.draft} maxLength={12000} rows={3} disabled={disabled}
        onChange={(event) => client.setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault(); send();
          }
        }} />
      {Boolean(state.draftContexts.length) && <div className={styles.draftReferences}><ChatContextReferences contexts={state.draftContexts} onNavigate={onNavigate} onRemove={client.removeContext} /></div>}
      <footer className={styles.composerFooter}>
        <div className={styles.composerTools}><TooltipButton type="button" className={styles.contextButton} onClick={() => { more.close(false); setContextPickerOpen(true); }} disabled={disabled || state.loading}>
          <Plus size={15} aria-hidden="true" />参考资料{Boolean(state.draftContexts.length) && <span>{state.draftContexts.length}</span>}</TooltipButton>
          <TooltipButton ref={more.trigger} type="button" className={styles.moreButton} aria-label="对话更多选项" aria-haspopup="dialog" aria-expanded={more.open}
            aria-controls={more.open ? more.id : undefined} onClick={() => more.open ? more.close() : more.show()}><Ellipsis size={17} /></TooltipButton>
        </div>
        {state.running ? <button type="button" className={styles.stop} onClick={client.stop} disabled={state.running.stopping}>
          <Square size={11} />{state.running.stopping ? "正在停止" : "停止生成"}
        </button> : <TooltipButton type="submit" className={styles.send} tooltip="发送（⌘ / Ctrl + Enter）" aria-keyshortcuts="Meta+Enter Control+Enter" disabled={disabled || !effectiveAttachment || !state.draft.trim() || state.loading}>
          <Send size={15} />发送
        </TooltipButton>}
      </footer>
    </form>
    {more.open && createPortal(<div ref={more.panel} id={more.id} className={styles.moreMenu} role="dialog" aria-label="对话更多选项" tabIndex={-1}>
      {onFindPaper && <button type="button" onClick={() => { more.close(false); onFindPaper(); }}>查找并收藏文献</button>}
      <strong>当前 PDF</strong>
      <div className={styles.source}><FileText size={15} aria-hidden="true" />
        {!conversation && availableAttachments.length > 1 ? <select aria-label="新对话使用的 PDF" value={effectiveAttachment}
          onChange={(event) => setAttachmentChoice({ readerId: attachmentId, id: event.target.value })} disabled={Boolean(state.running)}>
          {availableAttachments.map((item) => <option key={item.id} value={item.id}>{item.filename}</option>)}
        </select> : <span>{effectiveAttachment ? sourceName : "请先添加 PDF"}</span>}
      </div>
      <p>默认结合当前 PDF 回答，实际读取范围可在回复中展开查看。{shownScope?.truncated ? "最近一次使用了部分正文。" : ""}</p>
      {lastActualModel && <p>上次回复模型：{lastActualModel}</p>}
      {conversation && <button type="button" onClick={() => { more.close(false); setRenaming({ id: conversation.id, title: conversation.title, saving: false, error: "" }); }}><Pencil size={14} />重命名当前对话</button>}
      <details><summary>参考资料与快捷键</summary><p>个人记录由你主动加入，随提问保存为快照。⌘ / Ctrl + Enter 发送。</p></details>
    </div>, document.body)}
    {contextPickerOpen && <ChatContextPicker contexts={state.draftContexts} onAdd={client.addContext} onAddMany={client.addContexts} onRemove={client.removeContext} onClose={() => setContextPickerOpen(false)} onNavigate={onNavigate} />}
  </section>;
}
