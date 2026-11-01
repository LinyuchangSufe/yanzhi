"use client";
import { useMemo, useState } from "react";
import type { KBState } from "../../lib/types";
import type { ExternalDiscussion } from "../../lib/codex-import/types";
import { researchInputKey } from "../../lib/research-items/client";
import type { ResearchSourceInput } from "../../lib/research-items/types";
import styles from "./ResearchItems.module.css";

export default function ResearchSourcePicker({ state, value, onChange, results = false, disabled = false }: {
  state: KBState; value: ResearchSourceInput[]; onChange: (value: ResearchSourceInput[]) => void; results?: boolean; disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const options = useMemo(() => {
    const choices: { input: ResearchSourceInput; title: string; text: string; label: string; disabled?: boolean }[] = [];
    for (const note of state.notes) if (note.body.trim()) choices.push({ input: { kind: "note", id: note.id, revision: note.revision }, title: note.title, text: note.body, label: "个人笔记", disabled: note.body.length > 32000 });
    for (const mark of state.annotations) choices.push({ input: { kind: "annotation", id: mark.id, revision: mark.revision }, title: `标注 · 物理第 ${mark.pageIndex + 1} 页`, text: mark.selectedText || mark.comment, label: "高亮与批注" });
    for (const ai of state.aiContents) if (ai.guideData) {
      for (const evidence of ai.guideData.evidence) choices.push({ input: { kind: "guideEvidence", id: ai.id, evidenceId: evidence.id }, title: evidence.title, text: evidence.quote, label: "导读证据（仍需核验）" });
      if (!results) ai.guideData.questions.forEach((question, questionIndex) => choices.push({ input: { kind: "guideQuestion", id: ai.id, questionIndex }, title: question, text: question, label: "AI 后续问题" }));
    }
    for (const conversation of state.ideaConversations ?? []) for (const message of conversation.messages) if (message.status === "completed" && message.body.trim()) choices.push({ input: { kind: "ideaMessage", conversationId: conversation.id, messageId: message.id }, title: conversation.title, text: message.body, label: message.role === "assistant" ? "AI 讨论回复（仍需核验）" : "我的讨论记录", disabled: message.body.length > 32000 });
    for (const discussion of (state as KBState & { externalDiscussions?: ExternalDiscussion[] }).externalDiscussions ?? []) {
      const text = discussion.messages.map(message => `${message.role === "assistant" ? "AI" : "用户"}：${message.text}`).join("\n\n"), counts = new Map<string, number>();
      for (const message of discussion.messages) counts.set(message.id, (counts.get(message.id) ?? 0) + 1);
      choices.push({ input: { kind: "externalDiscussion", id: discussion.id, revision: discussion.revision }, title: discussion.title, text, label: "导入 Codex · 已导入的完整选择（仍需核验）", disabled: text.length > 32000 });
      for (const message of discussion.messages) if (message.text.trim() && counts.get(message.id) === 1) choices.push({ input: { kind: "externalDiscussion", id: discussion.id, revision: discussion.revision, messageIds: [message.id] }, title: discussion.title, text: message.text, label: `导入 Codex · ${message.role === "assistant" ? "AI 回复（仍需核验）" : "我的提问"}`, disabled: message.text.length > 32000 });
    }
    return choices;
  }, [state, results]);
  const selected = new Set(value.map(researchInputKey));
  const matches = options.filter(option => !query.trim() || `${option.title}\n${option.text}\n${option.label}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <details className={styles.picker}>
    <summary>{results ? "选择结果来源" : "选择问题来源"} · 已选 {value.length}</summary>
    <input type="search" aria-label={results ? "搜索结果来源" : "搜索问题来源"} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索笔记、证据或讨论…" disabled={disabled} />
    <div className={styles.sourceChoices}>
      {matches.map(option => { const key = researchInputKey(option.input); return <label key={key}>
        <input type="checkbox" checked={selected.has(key)} disabled={disabled || option.disabled || (!selected.has(key) && value.length >= 12)}
          onChange={event => onChange(event.target.checked ? [...value, option.input] : value.filter(input => researchInputKey(input) !== key))} />
        <span><strong>{option.title}</strong><small>{option.label}{option.disabled ? " · 内容较长，请在原记录中选择较小选段" : ""}</small><span>{option.text.slice(0, 140)}</span></span>
      </label>; })}
      {!matches.length && <p>没有匹配的已保存来源。</p>}
    </div>
  </details>;
}
