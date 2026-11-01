"use client";
import { useEffect, useRef, useState } from "react";
import type { KBState } from "../../lib/types";
import type { CodexHistory, CodexSource, CodexThread, ExternalDiscussion, ExternalDiscussionContext } from "../../lib/codex-import/types";
import { errorMessage, readResponse } from "../WorkspaceShared";
import ImportDialog from "./ImportDialog";
import { TurnPreview } from "./DiscussionMessages";
import styles from "./CodexImport.module.css";

type Preview = CodexHistory & { historyHash: string };
export default function CodexImportPicker({ context = {}, onImported, onClose }: { context?: Partial<ExternalDiscussionContext>; onImported: (discussion: ExternalDiscussion, state: KBState) => void | Promise<void>; onClose: () => void }) {
  const [threads, setThreads] = useState<CodexThread[]>([]), [source, setSource] = useState<CodexSource | null>(null), [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState(""), [cwd, setCwd] = useState(""), [preview, setPreview] = useState<Preview | null>(null), [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<"list" | "read" | "import" | null>(null), [error, setError] = useState("");
  const active = useRef<{ token: number; controller: AbortController | null }>({ token: 0, controller: null });
  const filters = useRef({ search: "", cwd: "" });
  const request = () => { active.current.controller?.abort(); const controller = new AbortController(); active.current = { token: active.current.token + 1, controller }; return { controller, token: active.current.token }; };
  const load = async (next?: string) => {
    const { controller, token } = request(); setPending("list"); setError("");
    if (!next) { filters.current = { search, cwd }; setPreview(null); setSelected([]); setThreads([]); setCursor(null); }
    const query = new URLSearchParams({ ...filters.current, ...(next ? { cursor: next } : {}) });
    try { const result = await readResponse(await fetch(`/api/kb/codex-history?${query}`, { signal: controller.signal })) as { data: CodexThread[]; nextCursor: string | null; source: CodexSource };
      if (token !== active.current.token) return;
      setThreads((old) => next ? [...old, ...result.data.filter((item) => !old.some((previous) => previous.id === item.id))] : result.data); setCursor(result.nextCursor); setSource(result.source);
    } catch (failure) { if (!controller.signal.aborted && token === active.current.token) setError(errorMessage(failure)); }
    finally { if (token === active.current.token) setPending(null); }
  };
  useEffect(() => { void load(); return () => { active.current.token++; active.current.controller?.abort(); }; }, []); // Initial list is requested only after the user opens this picker.
  const read = async (threadId: string) => {
    const { controller, token } = request(); setPending("read"); setError(""); setPreview(null); setSelected([]);
    try { const result = await readResponse(await fetch(`/api/kb/codex-history?${new URLSearchParams({ threadId })}`, { signal: controller.signal })) as Preview;
      if (token === active.current.token) { setPreview(result); setSource(result.source); }
    } catch (failure) { if (!controller.signal.aborted && token === active.current.token) setError(errorMessage(failure)); }
    finally { if (token === active.current.token) setPending(null); }
  };
  const importing = pending === "import", selectedTurns = preview?.turns.filter((turn) => selected.includes(turn.id)) ?? [];
  const characters = selectedTurns.reduce((sum, turn) => sum + turn.messages.reduce((total, message) => total + message.text.length, 0), 0);
  const commit = async () => {
    if (!preview || !selected.length || importing || characters > 2000000) return;
    const { controller, token } = request(); setPending("import"); setError("");
    try { const result = await readResponse(await fetch("/api/kb/codex-history", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ action: "import", threadId: preview.thread.id, sourceId: preview.source.id, historyHash: preview.historyHash, selectedTurnIds: selected, context: { paperIds: context.paperIds ?? [], topicIds: context.topicIds ?? [], noteIds: context.noteIds ?? [] } }) })) as { discussion: ExternalDiscussion; state: KBState };
      if (token === active.current.token) { await onImported(result.discussion, result.state); onClose(); }
    } catch (failure) { if (!controller.signal.aborted && token === active.current.token) setError(errorMessage(failure)); }
    finally { if (token === active.current.token) setPending(null); }
  };
  return <ImportDialog title="从 Codex 导入讨论" busy={importing} onClose={onClose}><div className={styles.body}>
    <p className={styles.muted}>仅读取当前本机 Codex 资料目录。选择会话和轮次后，才会保存公开文本问答。图片、附件、技能提及、工具日志和推理内容不会导入。</p>
    <form className={styles.filters} onSubmit={(event) => { event.preventDefault(); void load(); }}><label>会话标题<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题" disabled={importing} /></label><label>项目目录<input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="全部项目（可填写完整路径）" disabled={importing} /></label><button type="submit" disabled={Boolean(pending)}>筛选</button></form>
    {source && <details className={styles.diagnostics}><summary>当前来源：{source.label}</summary><dl><dt>主机</dt><dd>{source.host}</dd><dt>Codex 资料目录</dt><dd>{source.home}</dd><dt>环境指定索引目录</dt><dd>{source.sqliteHome || "环境未单独指定"}</dd><dt>CLI</dt><dd>{source.binary}</dd></dl><p>资料目录由 Codex 初始化确认；索引目录显示环境声明，CLI 自身配置可能优先。如果找不到桌面里的会话，请核对主机、CLI 与目录配置。此处不会扫描私有 JSONL 补齐索引。</p></details>}
    <div className={styles.pickerColumns}><section className={styles.threadList} aria-label="本机 Codex 会话列表">{threads.map((thread) => <button type="button" key={thread.id} className={preview?.thread.id === thread.id ? styles.active : undefined} disabled={importing} onClick={() => void read(thread.id)}><strong>{thread.title}</strong><span>{thread.cwd || "未记录项目"}</span><small>{new Date(thread.updatedAt).toLocaleString("zh-CN")}</small></button>)}
      {!threads.length && pending !== "list" && <p className={styles.muted}>没有找到会话。可清空项目筛选，或检查当前来源目录。</p>}{cursor && <button type="button" disabled={Boolean(pending)} onClick={() => void load(cursor)}>加载更多会话</button>}</section>
      <section className={styles.preview} aria-label="选择导入轮次">{preview ? <><h3>{preview.thread.title}</h3><p className={styles.muted}>完整读取 {preview.turns.length} 轮；仅展示可见提问和回答，工具日志、推理内容不会导入。</p><div className={styles.actions}><button type="button" disabled={importing} onClick={() => setSelected(preview.turns.filter((turn) => turn.messages.length).map((turn) => turn.id))}>全选有正文的轮次</button><button type="button" disabled={importing || !selected.length} onClick={() => setSelected([])}>清空选择</button><button type="button" disabled={Boolean(pending)} onClick={() => void read(preview.thread.id)}>重新读取</button></div>
        {preview.turns.map((turn, index) => <TurnPreview key={turn.id} turn={turn} index={index} checked={selected.includes(turn.id)} disabled={importing} onChange={(checked) => setSelected((old) => checked ? [...old, turn.id] : old.filter((id) => id !== turn.id))} />)}</> : <p className={styles.muted}>{pending === "read" ? "正在完整读取所选会话…" : "选择左侧会话，再预览并勾选需要的轮次。"}</p>}</section></div>
    {pending === "list" && <p role="status">正在读取会话列表…</p>}{error && <p className={styles.error} role="alert">{error}</p>}{characters > 2000000 && <p className={styles.error}>所选正文超过 200 万字符，请减少轮次并分批导入。</p>}
  </div><footer className={styles.footer}><span role="status">已选 {selected.length} 轮 · {characters.toLocaleString("zh-CN")} 字符</span><button type="button" disabled={importing} onClick={onClose}>取消</button><button type="button" className={styles.primary} disabled={!selected.length || Boolean(pending) || characters > 2000000} onClick={() => void commit()}>{importing ? "正在核对并导入…" : "导入所选轮次"}</button></footer></ImportDialog>;
}
