"use client";
import { useState } from "react";
import type { CodexTurn, ExternalMessage } from "../../lib/codex-import/types";
import { plainTextPreview } from "../../lib/plain-text-preview";
import Markdown from "../Markdown";
import styles from "./CodexImport.module.css";
export function DiscussionMessages({ messages, onFindPaper }: { messages: ExternalMessage[]; onFindPaper?: (query: string) => void }) {
  return <div className={styles.messages}>{messages.map((message) => <article key={`${message.turnId}-${message.id}`} className={styles.message}>
    <h4>{message.role === "user" ? "用户" : "AI"}</h4><Markdown body={message.text} onFindPaper={onFindPaper} />
  </article>)}</div>;
}
export function TurnPreview({ turn, checked, disabled, onChange, index }: { turn: CodexTurn; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void; index: number }) {
  const [open, setOpen] = useState(false);
  const text = turn.messages.find((message) => message.role === "user")?.text ?? turn.messages[0]?.text ?? "没有可导入的公开正文";
  return <article className={styles.turn}>
    <div className={styles.turnHeading}><label><input type="checkbox" disabled={disabled || !turn.messages.length} checked={checked} onChange={(event) => onChange(event.target.checked)} /><span><strong>第 {index + 1} 轮</strong><span>{plainTextPreview(text, { maxLength: 100 })}</span></span></label>
      <button type="button" disabled={!turn.messages.length} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "收起" : "预览"}</button></div>
    {turn.status !== "completed" && <p className={styles.muted}>此轮{turn.status === "inProgress" ? "仍在进行" : "未完整结束"}；只导入已读取到的公开正文。</p>}
    {open && <DiscussionMessages messages={turn.messages} />}
  </article>;
}
