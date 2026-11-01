"use client";
import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { KBState } from "../../lib/types";
import type { ExternalDiscussion } from "../../lib/codex-import/types";
import { errorMessage, readResponse } from "../WorkspaceShared";
import { DiscussionMessages } from "./DiscussionMessages";
import styles from "./CodexImport.module.css";
export default function ExternalDiscussionView({ discussion, onChanged, onDiscuss, onClose, onFindPaper }: { discussion: ExternalDiscussion; onChanged: (state: KBState) => void | Promise<void>; onDiscuss?: (discussion: ExternalDiscussion) => void; onClose?: () => void; onFindPaper?: (query?: string) => void }) {
  const [selectedRevision, setSelectedRevision] = useState("current"), [refreshing, setRefreshing] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const version = selectedRevision === "current" ? discussion : discussion.history.find((item) => item.revision === Number(selectedRevision)) ?? discussion;
  const refresh = async () => {
    if (request.current) return; const controller = new AbortController(); request.current = controller;
    setRefreshing(true); setError(""); setMessage("");
    try { const result = await readResponse(await fetch("/api/kb/codex-history", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ action: "refresh", id: discussion.id, revision: discussion.revision }) })) as { discussion: ExternalDiscussion; state: KBState; changed: boolean };
      if (controller.signal.aborted) return; await onChanged(result.state); setSelectedRevision("current"); setMessage(result.changed ? "所选轮次已更新，之前的资料版本已保留。" : "所选轮次没有新增正文，已更新检查时间。");
    } catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setRefreshing(false); request.current = null; }
  };
  return <section className={styles.readOnly} aria-label="已导入 Codex 讨论">
    <div className={styles.viewHeading}><div><p className={styles.badge}>只读外部讨论</p><h2>{version.title}</h2></div>{onClose && <button type="button" disabled={refreshing} onClick={onClose}>返回资料列表</button>}</div>
    <p className={styles.muted}>范围：所选 {discussion.selectedTurnIds.length} 轮 · {version.messages.length} 条公开消息。刷新只更新这些轮次，不会自动加入新轮次，也不会改写个人笔记。</p>
    {Object.values(version.turnStatuses ?? {}).some((status) => status !== "completed") && <p className={styles.warning}>部分轮次在读取时尚未完整结束；这里仅保留当时已公开的文本，可稍后手动刷新。</p>}
    <div className={styles.actions}><a className={styles.link} href={discussion.sourceHref}>在 Codex 中打开<ExternalLink size={13} aria-hidden="true" /></a><button type="button" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" />{refreshing ? "正在读取所选轮次…" : "手动刷新"}</button>
      {onDiscuss && <button type="button" className={styles.primary} disabled={refreshing} onClick={() => onDiscuss({ ...discussion, title: version.title, revision: version.revision, hash: version.hash, messages: version.messages, turnStatuses: version.turnStatuses })}>基于此资料讨论</button>}</div>
    <div className={styles.versionRow}><label>资料版本<select value={selectedRevision} disabled={refreshing} onChange={(event) => setSelectedRevision(event.target.value)}><option value="current">当前版本 · 修订 {discussion.revision}</option>{[...discussion.history].reverse().map((item) => <option key={item.revision} value={item.revision}>修订 {item.revision} · {new Date(item.capturedAt).toLocaleString("zh-CN")}</option>)}</select></label><span className={styles.muted}>最近检查：{new Date(discussion.refreshedAt).toLocaleString("zh-CN")}</span></div>
    <details className={styles.diagnostics}><summary>来源与导入范围详情</summary><dl><dt>原会话</dt><dd>{discussion.threadId}</dd><dt>主机与资料目录</dt><dd>{discussion.source.host} · {discussion.source.home}</dd><dt>选中轮次</dt><dd>{discussion.selectedTurnIds.join("、")}</dd><dt>首次导入</dt><dd>{new Date(discussion.importedAt).toLocaleString("zh-CN")}</dd><dt>来源更新时间</dt><dd>{new Date(version.sourceUpdatedAt).toLocaleString("zh-CN")}</dd><dt>内容校验</dt><dd>{version.hash}</dd></dl></details>
    {message && <p role="status">{message}</p>}{error && <p className={styles.error} role="alert">{error}</p>}
    {onFindPaper && <button type="button" onClick={() => onFindPaper()}>查找并收藏文献</button>}
    <DiscussionMessages messages={version.messages} onFindPaper={onFindPaper} />
  </section>;
}
