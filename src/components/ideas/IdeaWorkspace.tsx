"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, Ellipsis, FileText, Link2, MessageCircle, Plus, Send, Sparkles, Square, X } from "lucide-react";
import type { Note } from "../../lib/types";
import type { IdeaMessage } from "../../lib/idea-lab/types";
import { ideaSourceScope } from "../../lib/idea-lab/source-details";
import type { WorkspaceController } from "../Workspace";
import { aiErrorRecovery } from "../../lib/ai-error-recovery";
import Markdown from "../Markdown";
import TooltipButton from "../TooltipButton";
import ChatRunStatus from "../ai/ChatRunStatus";
import ChatHeader from "../chat/ChatHeader";
import ChatModelPicker from "../chat/ChatModelPicker";
import { linked } from "../WorkspaceShared";
import IdeaMaterials from "./IdeaMaterials";
import IdeaSummary from "./IdeaSummary";
import { useIdeaDiscussion } from "./useIdeaDiscussion";
import { ideaCompletedTurns, ideaDiscussionIsLong, ideaDiscussionSources } from "./idea-client";
import { useIdeaSplit } from "./useIdeaSplit";
import styles from "./IdeaWorkspace.module.css";

function MessageSources({ message, onNavigate }: { message: IdeaMessage; onNavigate: (href: string) => void }) {
  if (!message.sources.length) return null;
  return <details className={styles.messageSources}><summary>本轮实际资料 · {message.sources.length} 项</summary>
    {message.sources.map((source) => <div key={source.id} className={styles.sourceSnapshot}>
      <button type="button" onClick={() => onNavigate(source.sourceHref)}>{source.title}</button>
      <small>{ideaSourceScope(source)}
        {source.pageIndex !== undefined ? ` · 物理第 ${source.pageIndex + 1} 页` : ""} · {source.text.length.toLocaleString()} 字符 · 修订 {source.revision}</small>
      <blockquote>{source.text}</blockquote>
    </div>)}
  </details>;
}

export default function IdeaWorkspace({ note, c, onImportCodex }: { note: Note; c: WorkspaceController; onImportCodex?: () => void }) {
  const discussion = useIdeaDiscussion(note.id);
  const { client } = discussion;
  const split = useIdeaSplit();
  const paneId = useId();
  const latest = useRef({ c, note }); latest.current = { c, note };
  const [mobileTab, setMobileTab] = useState<"discussion" | "notes">("discussion");
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [marked, setMarked] = useState<string[]>([]);
  const [selectingRange, setSelectingRange] = useState(false);
  const [historyId, setHistoryId] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsPanel = useRef<HTMLDivElement>(null);
  const toolsButton = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const conversation = discussion.conversations.find((item) => item.id === discussion.activeId);
  const summary = discussion.summaries.find((item) => item.id === discussion.summaryId);
  const revisions = (c.state.noteRevisions ?? []).filter((item) => item.noteId === note.id);
  const revision = revisions.find((item) => item.id === historyId) ?? revisions[0];
  const completedMessages = ideaCompletedTurns(conversation?.messages ?? []);
  const completedMessageIds = new Set(completedMessages.map((message) => message.id));
  const selectedMessages = selectingRange ? completedMessages.filter((message) => marked.includes(message.id)) : completedMessages;
  const historicalSources = ideaDiscussionSources(conversation?.messages ?? []);
  const referenceCount = historicalSources.length + discussion.materials.length + Number(discussion.includeCurrentNote);
  const relatedPapers = c.state.papers.filter((paper) => !paper.deletedAt && linked(c.state, "note", note.id, "paper", paper.id));
  const relatedTopics = c.state.topics.filter((topic) => linked(c.state, "note", note.id, "topic", topic.id));
  const busy = discussion.running || discussion.summarizing;
  const displayModel = (model: string) => model === "cli-default" ? "CLI 默认" : model || "默认模型";
  const pendingMessage = conversation?.messages.find((message) => message.role === "assistant" && message.status === "pending");
  const recovery = aiErrorRecovery(discussion.error);
  useEffect(() => { setMarked([]); setSelectingRange(false); setToolsOpen(false); }, [discussion.activeId]);
  useEffect(() => { if (nearBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [conversation?.messages, busy]);
  useEffect(() => {
    if (!toolsOpen) return;
    const position = () => {
      const panel = toolsPanel.current, button = toolsButton.current;
      if (!panel || !button) return;
      const anchor = button.getBoundingClientRect(), gap = 7, margin = 8;
      const above = anchor.top - gap - margin, below = window.innerHeight - anchor.bottom - gap - margin;
      panel.style.setProperty("--idea-tools-max-height", `${Math.max(40, Math.min(420, Math.max(above, below)))}px`);
      const bounds = panel.getBoundingClientRect();
      const preferredLeft = button.parentElement?.getBoundingClientRect().left ?? anchor.left;
      const left = Math.max(margin, Math.min(window.innerWidth - bounds.width - margin, preferredLeft));
      const preferredTop = above >= below ? anchor.top - bounds.height - gap : anchor.bottom + gap;
      const top = Math.max(margin, Math.min(window.innerHeight - bounds.height - margin, preferredTop));
      panel.style.setProperty("--idea-tools-left", `${left}px`); panel.style.setProperty("--idea-tools-top", `${top}px`);
      panel.dataset.positioned = "true";
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !toolsPanel.current?.contains(event.target) && !toolsButton.current?.contains(event.target)) setToolsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault(); setToolsOpen(false); toolsButton.current?.focus();
    };
    position();
    const focusFrame = window.requestAnimationFrame(() => (toolsPanel.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), summary') ?? toolsPanel.current)?.focus({ preventScroll: true }));
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    if (toolsPanel.current) observer?.observe(toolsPanel.current);
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true);
      observer?.disconnect(); window.cancelAnimationFrame(focusFrame);
    };
  }, [toolsOpen]);
  const prepare = async () => {
    const origin = latest.current.note.id;
    await latest.current.c.editor.current?.flush();
    if (latest.current.note.id !== origin) throw new Error("想法已切换，请返回后重新发送。");
    return latest.current.c.editor.current?.getRevision() ?? latest.current.note.revision;
  };
  const send = () => { if (discussion.draft.trim() && !busy) void client.send(prepare); };
  const organize = async () => {
    if (!selectedMessages.length) return;
    if (selectedMessages.length > 100 && !selectingRange) {
      setMarked(completedMessages.map((message) => message.id)); setSelectingRange(true);
    }
    const result = await client.summarize(selectedMessages.map((message) => message.id), prepare);
    if (result && latest.current.note.id === note.id) setSummaryOpen(true);
  };
  return <section className={styles.workspace} aria-labelledby="idea-workspace-title">
    <h1 id="idea-workspace-title" className={styles.srOnly}>{note.title || "想法工作区"}</h1>
    <div className={styles.mobileTabs} role="tablist" aria-label="想法工作区视图">
      <button type="button" role="tab" aria-selected={mobileTab === "discussion"} onClick={() => setMobileTab("discussion")}><MessageCircle size={14} />讨论</button>
      <button type="button" role="tab" aria-selected={mobileTab === "notes"} onClick={() => setMobileTab("notes")}><FileText size={14} />工作笔记</button>
    </div>
    <div ref={split.containerRef} className={styles.columns} data-mobile-tab={mobileTab} data-resizing={split.dragging}>
      <section id={`${paneId}-discussion`} className={styles.discussion} aria-label="想法多轮讨论">
        <ChatHeader title="一起推敲" conversations={discussion.conversations} activeId={discussion.activeId}
          onSelect={client.chooseConversation} onNew={() => client.chooseConversation("")} disabled={busy} loading={discussion.loading}
          leading={<TooltipButton type="button" className={styles.back} aria-label="返回我的想法" onClick={() => void c.chooseSection("ideas")}><ArrowLeft size={16} /></TooltipButton>}
          modelControl={<ChatModelPicker scopeLabel="本想法" configuration={discussion.configuration} modelOverride={discussion.modelOverride}
            modelOptions={discussion.modelOptions} modelOptionsLoading={discussion.modelOptionsLoading} modelOptionsWarning={discussion.modelOptionsWarning}
            modelNotice={discussion.modelNotice} runningModel={busy ? discussion.runModel : null} onSetModel={client.setModelOverride}
            onOpen={async () => { setToolsOpen(false); await client.load(true); await client.loadModelOptions(); }}
            onRefresh={client.loadModelOptions} onSettings={() => void c.chooseSection("settings")} />} />
        <div className={styles.messages} ref={scroll} aria-label="想法讨论记录" onScroll={() => {
          if (scroll.current) nearBottom.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 100;
        }}>
          {discussion.loading && <p role="status" className={styles.empty}>正在读取讨论…</p>}
          {!discussion.loading && !(conversation?.messages.length) && <div className={styles.intro}>
            <Sparkles size={24} /><h3>从一个还不完整的念头开始。</h3><p>连接材料、寻找漏洞，逐步形成可验证的判断。AI 的推测和引用仍需核对。</p>
          </div>}
          {(conversation?.messages ?? []).map((message) => <article key={message.id} className={`${styles.message} ${message.role === "user" ? styles.userMessage : styles.assistantMessage}`}>
            <div className={styles.messageHeading}><strong>{message.role === "user" ? "我的思考" : "AI 讨论"}</strong>
              {selectingRange && completedMessageIds.has(message.id) && <label className={styles.mark}><input type="checkbox" checked={marked.includes(message.id)}
                aria-label={`纳入整理范围：${message.role === "user" ? "我的思考" : "AI 回复"} ${message.body.slice(0, 24)}`}
                onChange={(event) => setMarked((current) => event.target.checked ? [...current, message.id] : current.filter((id) => id !== message.id))} />纳入整理</label>}
              {message.role === "assistant" && <small>{message.status === "pending" ? `${displayModel(message.model)} · 生成中…` : message.status === "failed" ? "未完成" : message.status === "cancelled" ? "已停止" : message.model}</small>}
            </div>
            {message.body ? <Markdown body={message.body} copyAsMarkdown onNavigate={(href) => void c.navigateLink(href)}
              literatureLinks={message.literatureSources} onFindPaper={(query) => c.openLiterature(query, { noteId: note.id })} /> : <p className={styles.muted}>{message.status === "pending" ? "等待模型回复，收到的内容会继续显示。" : "此轮没有收到回复正文。"}</p>}
            {message.role === "assistant" && (message.status === "pending" || message.progress) && <ChatRunStatus progress={message.progress}
              startedAt={message.createdAt} active={message.status === "pending"} finishedAt={message.status === "pending" ? undefined : message.updatedAt} label={message.provider === "codex" ? "Codex" : "本轮回复"} compact={message.status !== "pending"} />}
            {message.error && <p className={styles.error}>{message.error}</p>}
            <MessageSources message={message} onNavigate={(href) => void c.navigateLink(href)} />
          </article>)}
          {(discussion.summarizing || (discussion.running && !pendingMessage)) && discussion.runStartedAt && <ChatRunStatus
            progress={discussion.progress} startedAt={discussion.runStartedAt} label={discussion.summarizing ? "整理笔记" : "本轮请求"} />}
        </div>
        {discussion.error && <div className={styles.errorPanel} role="alert"><p>{discussion.error}</p><div className={styles.inlineActions}>
          {!discussion.loaded && <button type="button" onClick={() => void client.load(true)}>重新读取</button>}
          {discussion.failed && <button type="button" disabled={busy} onClick={() => void client.send(prepare, true)}>重试原提问</button>}
          {recovery.kind === "configuration" && <button type="button" onClick={() => void c.chooseSection("settings")}>检查 AI 设置</button>}
          <TooltipButton type="button" aria-label="关闭讨论提示" onClick={client.clearError}><X size={14} /></TooltipButton>
        </div></div>}
        <div className={styles.composer}>
          {discussion.notice && <p className={styles.stageHint} role="status">{discussion.notice}</p>}
          <textarea ref={composer} aria-label="想法讨论输入" value={discussion.draft} maxLength={12000}
            placeholder="写下想法，或继续追问…" onChange={(event) => client.setDraft(event.target.value)}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
          <div className={styles.composerFooter}>
            <div className={styles.composerActions}>
              <TooltipButton type="button" tooltip="添加或查看参考资料；已引用资料在后续讨论中继续沿用" onClick={() => { setToolsOpen(false); setMaterialsOpen(true); }}>
                <Plus size={14} />参考资料{referenceCount > 0 && <span className={styles.referenceCount}>{referenceCount}</span>}</TooltipButton>
              <TooltipButton type="button" disabled={busy || !selectedMessages.length} tooltip={selectingRange ? `整理选中的 ${selectedMessages.length} 条消息，先预览再采纳` : "整理已完成的讨论，先预览再采纳"}
                onClick={() => { setToolsOpen(false); void organize(); }}><Sparkles size={14} />整理笔记{selectingRange ? ` · ${selectedMessages.length}` : ""}</TooltipButton>
              <TooltipButton ref={toolsButton} type="button" aria-label="讨论工具与整理选项" tooltip="整理范围、追问建议和本次阅读范围"
                aria-haspopup="dialog" aria-expanded={toolsOpen} aria-controls={`${paneId}-tools`} onClick={() => { setToolsOpen(!toolsOpen); }}><Ellipsis size={16} /></TooltipButton>
              {toolsOpen && <div ref={toolsPanel} id={`${paneId}-tools`} className={styles.composerPopover} role="dialog" tabIndex={-1} aria-label="讨论工具与整理选项">
                <button type="button" onClick={() => { setToolsOpen(false); c.openLiterature("", { noteId: note.id }); }}>查找并收藏文献</button>
                <strong>整理范围</strong><p>{selectingRange ? `已选 ${selectedMessages.length} / ${completedMessages.length} 条消息` : "默认整理已完成的讨论"}</p>
                <div className={styles.inlineActions}><button type="button" disabled={busy || !completedMessages.length} onClick={() => {
                  if (selectingRange) setSelectingRange(false);
                  else { setMarked(completedMessages.map((message) => message.id)); setSelectingRange(true); }
                  setToolsOpen(false);
                }}>{selectingRange ? "使用整段讨论" : "选择整理范围"}</button>
                {selectingRange && <button type="button" disabled={busy} onClick={() => setMarked(selectedMessages.length === completedMessages.length ? [] : completedMessages.map((message) => message.id))}>
                  {selectedMessages.length === completedMessages.length ? "清空选择" : "全选"}</button>}</div>
                <strong>换个角度</strong><div className={styles.prompts}>
                  {["还有哪些可能？", "这里有什么漏洞？", "下一步怎么验证？"].map((question) => <button type="button" key={question} onClick={() => {
                    client.setDraft(discussion.draft ? `${discussion.draft}\n${question}` : question); setToolsOpen(false);
                    window.requestAnimationFrame(() => composer.current?.focus());
                  }}>{question}</button>)}
                </div>
                {discussion.usage && <details className={styles.usage}><summary>本次实际阅读范围</summary><p>历史 {discussion.usage.historyMessages} 条消息、{discussion.usage.historyCharacters.toLocaleString()} 字符；新增 {discussion.usage.sourceCount} 项资料、{discussion.usage.sourceCharacters.toLocaleString()} 字符。不会自动读取关联论文的 PDF 全文。</p></details>}
                {ideaDiscussionIsLong(conversation?.messages ?? []) && <p>讨论较长，建议分阶段整理，再用小结开启新对话。</p>}
              </div>}
            </div>
            {busy ? <button type="button" onClick={client.stop}><Square size={13} />{discussion.summarizing ? "停止整理" : "停止生成"}</button> :
              <TooltipButton type="button" className={styles.primary} disabled={!discussion.draft.trim() || discussion.loading} tooltip="发送（⌘ / Ctrl + Enter）"
                aria-keyshortcuts="Meta+Enter Control+Enter" onClick={send}><Send size={14} />发送</TooltipButton>}
          </div>
          {discussion.storageError && <p role="alert" className={styles.error}>{discussion.storageError}</p>}
        </div>
      </section>
      <div ref={split.separatorRef} className={styles.splitter} role="separator" aria-label="调整一起推敲与工作笔记宽度"
        aria-orientation="vertical" aria-controls={`${paneId}-discussion ${paneId}-notes`}
        aria-valuemin={Math.round(split.limits.minimum * 10) / 10} aria-valuemax={Math.round(split.limits.maximum * 10) / 10}
        aria-valuenow={Math.round(split.split * 10) / 10}
        aria-valuetext={`一起推敲 ${Math.round(split.split)}%，工作笔记 ${100 - Math.round(split.split)}%`}
        tabIndex={split.desktop ? 0 : -1} aria-hidden={!split.desktop}
        title="拖动调整左右宽度；方向键微调，Home / End 移至边界；双击恢复各占一半"
        onPointerDown={split.onPointerDown} onPointerMove={split.onPointerMove} onPointerUp={split.onPointerFinish}
        onPointerCancel={split.onPointerFinish} onLostPointerCapture={split.onPointerFinish} onKeyDown={split.onKeyDown} onDoubleClick={split.reset} />
      <section id={`${paneId}-notes`} className={styles.notes} aria-label="想法工作笔记">
        <header className={styles.paneHeader}><div><FileText size={16} /><h2>工作笔记</h2></div></header>
        {c.editorFor(note, { compact: true })}
        {discussion.summaries.length > 0 && <div className={styles.savedSummaries}><label>阶段整理稿<select aria-label="选择想法整理稿" value={discussion.summaryId} onChange={(event) => client.chooseSummary(event.target.value)}>
          {discussion.summaries.map((item) => <option key={item.id} value={item.id}>{item.title} · {new Date(item.createdAt).toLocaleDateString("zh-CN")}</option>)}</select></label>
          <div className={styles.inlineActions}><button type="button" onClick={() => setSummaryOpen(true)}>预览并采纳</button>
            <TooltipButton type="button" tooltip="用小结准备新对话，原讨论保留；检查草稿后再发送" disabled={busy || !summary} onClick={() => {
              if (summary && client.startFromSummary(summary)) {
                setMobileTab("discussion"); window.requestAnimationFrame(() => composer.current?.focus());
              }
            }}>用小结开启新对话</TooltipButton></div><p className={styles.muted}>整理稿独立保留，采纳后仍可继续讨论。</p></div>}
        <details className={styles.noteHistory}><summary>原稿历史 · {revisions.length}</summary>
          {revision ? <><label>历史版本<select aria-label="想法原稿历史" value={revision.id} disabled={restoring} onChange={(event) => setHistoryId(event.target.value)}>
            {revisions.map((item) => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString("zh-CN")} · 修订 {item.noteRevision}</option>)}</select></label>
            <Markdown body={revision.body || "此版本正文为空。"} onNavigate={(href) => void c.navigateLink(href)} />
            <button type="button" disabled={restoring} onClick={async () => {
              if (!window.confirm("恢复这个原稿版本？恢复前会先保存当前正文为新的历史版本。")) return;
              setRestoring(true); setHistoryError("");
              try {
                if (!c.editor.current) throw new Error("工作笔记尚未准备好，请稍后重试。");
                await c.editor.current.applyAction("note.revision.restore", { snapshotId: revision.id }); await c.refresh();
              }
              catch (error) { setHistoryError(error instanceof Error ? error.message : "恢复失败，当前内容保留。"); }
              finally { setRestoring(false); }
            }}>{restoring ? "正在恢复…" : "恢复此版本"}</button></> : <p className={styles.muted}>采纳整理稿前会保存原稿，便于找回。</p>}
          {historyError && <p className={styles.error} role="alert">{historyError}</p>}
        </details>
        <details className={styles.relationships}><summary>关联论文与问题</summary>
          <div className={styles.relationshipTools}><p className={styles.muted}>用于归类和回看研究材料。讨论用到的文字可通过参考资料添加。</p>
            <button type="button" onClick={() => c.setDialog({ kind: "links", type: "note", id: note.id })}><Link2 size={13} />管理关联</button></div>
          <div className={styles.relationshipLinks}>
            {relatedPapers.map((paper) => <button type="button" key={paper.id} onClick={() => void c.navigateLink(`kb://paper/${paper.id}`)}><FileText size={13} />{paper.title}</button>)}
            {relatedTopics.map((topic) => <button type="button" key={topic.id} onClick={() => void c.navigateLink(`kb://topic/${topic.id}`)}><Link2 size={13} />{topic.title}</button>)}
          </div>
          {c.sourceLists("note", note.id)}
        </details>
      </section>
    </div>
    {materialsOpen && <IdeaMaterials state={c.state} noteId={note.id} selected={discussion.materials} onAdd={client.addMaterial} onRemove={client.removeMaterial}
      includeCurrentNote={discussion.includeCurrentNote} onIncludeCurrentNoteChange={client.setIncludeNote} currentNoteCharacters={note.body.length}
      historySources={historicalSources}
      onImportCodex={onImportCodex}
      onFindPaper={(query) => c.openLiterature(query, { noteId: note.id })}
      onClose={() => setMaterialsOpen(false)} onNavigate={(href) => void c.navigateLink(href)} />}
    {summaryOpen && summary && <IdeaSummary key={summary.id} summary={summary} note={note} c={c} onClose={() => setSummaryOpen(false)}
      onApplied={() => { client.clearNotice(); void client.load(true); void c.refresh(); }} />}
  </section>;
}
