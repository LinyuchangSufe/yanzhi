import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ChevronDown,
  History,
  Sparkles,
  X,
} from "lucide-react";
import type {
  NoteAssistance,
  NoteAssistContext,
  NoteAssistMode,
  NoteAssistSelection,
  NoteAssistSource,
  NoteRevision,
} from "../../lib/note-assist/types";
import { buildRevisedText } from "../../lib/note-assist/patches";
import type { NoteAction } from "./useNoteAssistBridge";
import Markdown from "../Markdown";
import styles from "../styles/NoteAssist.module.css";

interface Configuration {
  provider: string;
  model: string;
  configured: boolean;
  remote: boolean;
}
interface AssistanceData {
  assists: NoteAssistance[];
  revisions: NoteRevision[];
  context: NoteAssistContext;
  configuration: Configuration;
}
interface Props {
  noteId: string;
  title: string;
  body: string;
  revision: number;
  hasSelection: boolean;
  applying: boolean;
  prepare: (scope: "note" | "selection") => Promise<{
    revision: number;
    selection?: NoteAssistSelection;
  }>;
  onAction: (
    action: NoteAction,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  onNavigate: (href: string) => void;
  onClose: () => void;
}
const modes: { id: NoteAssistMode; label: string; hint: string }[] = [
  { id: "polish", label: "轻度润色", hint: "保留原意，调整表达与术语" },
  { id: "structure", label: "梳理问题", hint: "整理问题脉络，找出缺失环节" },
  { id: "advise", label: "研究建议", hint: "提出质疑、研究方向与验证步骤" },
];
const labels = Object.fromEntries(modes.map((mode) => [mode.id, mode.label]));
const basis = {
  note: "基于你的笔记",
  literature: "文献支持的判断",
  hypothesis: "待验证的设想",
};
const reasons = {
  "ai-start": "生成前原稿",
  "before-apply": "采纳前原稿",
  "before-restore": "恢复前原稿",
  manual: "原稿快照",
};
function date(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
async function responseData<T>(response: Response): Promise<T> {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "请求失败，请重试。");
  return value as T;
}
function expected(assistance: NoteAssistance) {
  try {
    return buildRevisedText(assistance);
  } catch {
    return null;
  }
}

export default function NoteAssistPanel(props: Props) {
  const [data, setData] = useState<AssistanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<NoteAssistMode>("structure");
  const [scope, setScope] = useState<"note" | "selection">("note");
  const [paperIds, setPaperIds] = useState<string[]>([]);
  const [ideaIds, setIdeaIds] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [snapshotId, setSnapshotId] = useState("");
  const [tab, setTab] = useState<"assist" | "history">("assist");
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState("");
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const latest = useRef(props);
  latest.current = props;
  const refreshing = useRef(0);
  const observedRevision = useRef(props.revision);

  const refresh = async (
    preferredId?: string,
    isCurrent: () => boolean = () => alive.current,
  ) => {
    if (!isCurrent()) return;
    const ticket = ++refreshing.current;
    const result = await responseData<AssistanceData>(
      await fetch(
        `/api/kb/note-assist?noteId=${encodeURIComponent(props.noteId)}`,
        { cache: "no-store" },
      ),
    );
    if (!alive.current || ticket !== refreshing.current || !isCurrent()) return;
    setData(result);
    setSelectedId(
      (current) =>
        preferredId ||
        (result.assists.some((a) => a.id === current)
          ? current
          : result.assists[0]?.id || ""),
    );
    setSnapshotId((current) =>
      result.revisions.some((s) => s.id === current)
        ? current
        : result.revisions[0]?.id || "",
    );
  };
  useEffect(() => {
    alive.current = true;
    void refresh()
      .catch((err: unknown) => {
        if (alive.current)
          setError(err instanceof Error ? err.message : "读取 AI 建议失败。");
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
      ++generation.current;
      ++refreshing.current;
      request.current?.abort();
    };
  }, [props.noteId]);
  useEffect(() => {
    if (
      generating ||
      props.applying ||
      observedRevision.current === props.revision
    )
      return;
    observedRevision.current = props.revision;
    // Saving a new [[reference]] may make an additional related source available.
    void refresh().catch((err: unknown) => {
      if (alive.current)
        setError(err instanceof Error ? err.message : "更新关联来源失败。");
    });
  }, [props.revision, generating, props.applying]);

  const cancel = () => {
    ++generation.current;
    request.current?.abort();
    request.current = null;
    setGenerating(false);
    setMessage("本次生成已取消，正文保持原样。");
  };
  const generate = async () => {
    if (request.current || props.applying) return;
    const ticket = ++generation.current;
    const controller = new AbortController();
    request.current = controller;
    const isCurrent = () =>
      alive.current &&
      ticket === generation.current &&
      !controller.signal.aborted;
    setGenerating(true);
    setError("");
    setMessage("");
    try {
      const draft = await latest.current.prepare(scope);
      if (!alive.current || ticket !== generation.current) return;
      const result = await responseData<{ result: NoteAssistance }>(
        await fetch("/api/kb/note-assist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            noteId: props.noteId,
            revision: draft.revision,
            mode,
            selection: draft.selection,
            paperIds,
            ideaIds,
          }),
          signal: controller.signal,
        }),
      );
      if (!alive.current || ticket !== generation.current) return;
      await refresh(result.result.id, isCurrent);
      if (!alive.current || ticket !== generation.current) return;
      setTab("assist");
      setMessage("建议已单独保存。查看差异后，再选择是否采纳。");
    } catch (err) {
      if (
        alive.current &&
        ticket === generation.current &&
        !controller.signal.aborted
      ) {
        setError(
          err instanceof Error ? err.message : "生成失败，原稿保持原样。",
        );
        // The provider can fail after the original draft was safely captured.
        // Keep the existing AI result selected and expose that new history now.
        try {
          await refresh(undefined, isCurrent);
        } catch {
          // Preserve the original generation error and the already loaded data.
        }
      }
    } finally {
      if (alive.current && ticket === generation.current) {
        setGenerating(false);
        request.current = null;
      }
    }
  };
  const perform = async (
    action: NoteAction,
    payload: Record<string, unknown>,
  ) => {
    if (props.applying) return;
    setError("");
    setMessage("");
    try {
      await props.onAction(action, payload);
      if (!alive.current) return;
      await refresh(selectedId);
      if (alive.current)
        setMessage(
          action === "note.revision.restore"
            ? "已恢复所选原稿；恢复前的内容也已留存，可在历史中找回。"
            : "已保存采纳结果；采纳前的原稿保留在历史中。",
        );
    } catch (err) {
      if (alive.current)
        setError(err instanceof Error ? err.message : "操作失败，原稿保留。");
    }
  };

  const selected = data?.assists.find((item) => item.id === selectedId);
  const expectedBody = useMemo(
    () => (selected ? expected(selected) : null),
    [selected],
  );
  const snapshot = data?.revisions.find((item) => item.id === snapshotId);
  const stale = Boolean(
    selected &&
    (selected.baseTitle !== props.title ||
      expectedBody !== props.body ||
      props.revision !== selected.lastAppliedRevision),
  );
  const disabled = props.applying || generating;
  const toggle = (
    id: string,
    values: string[],
    set: (next: string[]) => void,
  ) =>
    set(
      values.includes(id)
        ? values.filter((value) => value !== id)
        : [...values, id],
    );
  const apply = (payload: Record<string, unknown>) => {
    if (!selected) return;
    void perform("note.assist.apply", {
      assistanceId: selected.id,
      ...payload,
    });
  };

  return (
    <aside className={styles.panel} aria-label="笔记 AI 辅助" data-note-shortcuts="ignore">
      <div className={styles.header}>
        <div>
          <Sparkles size={15} aria-hidden="true" />
          <strong>AI 辅助</strong>
          <span>你的原稿始终保留</span>
        </div>
        <button
          aria-label="关闭 AI 辅助"
          title="关闭 AI 辅助"
          disabled={props.applying}
          onClick={() => {
            cancel();
            props.onClose();
          }}
        >
          <X size={17} />
        </button>
      </div>
      {loading && <p role="status">正在读取建议与原稿历史…</p>}
      {error && (
        <div className={styles.error} role="alert">
          {error}
          {!data && (
            <button
              onClick={() => {
                setLoading(true);
                void refresh()
                  .then(() => setError(""))
                  .catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : "读取失败"),
                  )
                  .finally(() => setLoading(false));
              }}
            >
              重试
            </button>
          )}
        </div>
      )}
      {data && (
        <>
          <div className={styles.modes} aria-label="AI 辅助方式">
            {modes.map((item) => (
              <button
                key={item.id}
                aria-pressed={mode === item.id}
                title={item.hint}
                disabled={disabled}
                onClick={() => setMode(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className={styles.hint}>
            {modes.find((item) => item.id === mode)?.hint}
            。结果先作为独立建议保存。
          </p>
          <details className={styles.context}>
            <summary>
              <ChevronDown size={13} />
              读取范围：{scope === "note" ? "当前笔记" : "当前选段"}
              {paperIds.length ? ` · ${paperIds.length} 篇文献` : ""}
              {ideaIds.length ? ` · ${ideaIds.length} 个想法` : ""}
            </summary>
            <fieldset disabled={disabled}>
              <legend>正文范围</legend>
              <label>
                <input
                  type="radio"
                  name={`assist-scope-${props.noteId}`}
                  checked={scope === "note"}
                  onChange={() => setScope("note")}
                />
                当前笔记
              </label>
              <label>
                <input
                  type="radio"
                  name={`assist-scope-${props.noteId}`}
                  checked={scope === "selection"}
                  disabled={!props.hasSelection}
                  onChange={() => setScope("selection")}
                />
                当前选段{!props.hasSelection && "（先在正文选中文字）"}
              </label>
            </fieldset>
            <fieldset disabled={disabled}>
              <legend>关联文献 · 按需勾选</legend>
              <p>仅摘要与已有导读证据，不是全文重读。</p>
              {data.context.papers.length ? (
                data.context.papers.map((paper) => (
                  <label key={paper.id}>
                    <input
                      type="checkbox"
                      checked={paperIds.includes(paper.id)}
                      onChange={() => toggle(paper.id, paperIds, setPaperIds)}
                    />
                    <span>
                      {paper.title}
                      <small>
                        {paper.hasAbstract ? "有摘要" : "无摘要"} ·{" "}
                        {paper.evidenceCount} 条导读证据
                      </small>
                    </span>
                  </label>
                ))
              ) : (
                <p>还没有关联文献。可先在正文用 [[ 引用库内论文。</p>
              )}
            </fieldset>
            <fieldset disabled={disabled}>
              <legend>关联想法 · 按需勾选</legend>
              {data.context.ideas.length ? (
                data.context.ideas.map((idea) => (
                  <label key={idea.id}>
                    <input
                      type="checkbox"
                      checked={ideaIds.includes(idea.id)}
                      onChange={() => toggle(idea.id, ideaIds, setIdeaIds)}
                    />
                    {idea.title}
                  </label>
                ))
              ) : (
                <p>还没有其他关联想法。</p>
              )}
            </fieldset>
            {data.context.topic && (
              <p className={styles.hint}>
                问题背景：{data.context.topic.title}（标题与描述）
              </p>
            )}
          </details>
          <div className={styles.generateRow}>
            <button
              className={styles.primary}
              disabled={disabled || !data.configuration.configured}
              onClick={() => void generate()}
            >
              <Sparkles size={14} />
              {generating ? "正在生成独立建议…" : "生成建议"}
            </button>
            {generating && <button onClick={cancel}>取消生成</button>}
            <small>
              {data.configuration.provider === "codex"
                ? "Codex"
                : data.configuration.provider === "ollama"
                  ? "Ollama"
                  : "AI"}{" "}
              · {data.configuration.model}
            </small>
          </div>
          <p className={styles.privacy}>
            {!data.configuration.configured
              ? "请先在设置中配置 AI 服务。"
              : data.configuration.provider === "codex"
                ? "Codex 会将当前笔记范围及勾选内容发送至 OpenAI，需要联网并消耗账户额度。"
                : data.configuration.remote
                  ? "所选内容会发送到已配置的远程模型服务。"
                  : "所选内容由本地模型处理。"}{" "}
            未勾选的文献和想法不会读取。
          </p>
          {generating && (
            <p className={styles.hint} role="status">
              你可以继续编辑正文。生成结果只对应开始时的原稿，不会自动覆盖新输入。
            </p>
          )}
          {message && (
            <p className={styles.message} role="status">
              {message}
            </p>
          )}

          <div className={styles.tabs}>
            <button
              aria-pressed={tab === "assist"}
              onClick={() => setTab("assist")}
            >
              AI 建议{data.assists.length ? ` · ${data.assists.length}` : ""}
            </button>
            <button
              aria-pressed={tab === "history"}
              onClick={() => setTab("history")}
            >
              <History size={13} />
              原稿历史
              {data.revisions.length ? ` · ${data.revisions.length}` : ""}
            </button>
          </div>
          {tab === "assist" && (
            <>
              {data.assists.length > 0 && (
                <label className={styles.version}>
                  建议版本
                  <select
                    value={selectedId}
                    disabled={props.applying}
                    onChange={(event) => setSelectedId(event.target.value)}
                  >
                    {data.assists.map((item) => (
                      <option key={item.id} value={item.id}>
                        {date(item.createdAt)} · {labels[item.mode]} · 原稿 r
                        {item.baseRevision}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!selected && (
                <div className={styles.empty}>
                  <strong>先写下你的问题，再让 AI 帮你推进</strong>
                  <p>
                    润色表达、梳理脉络，或结合关联文献提出研究建议。每次结果独立保存，由你决定采纳哪些内容。
                  </p>
                </div>
              )}
              {selected && (
                <div className={styles.results}>
                  <div className={styles.resultMeta}>
                    {labels[selected.mode]} · {selected.provider} /{" "}
                    {selected.model} · {date(selected.createdAt)}
                    {selected.selection && " · 仅针对选段"}
                  </div>
                  {stale && (
                    <p className={styles.warning}>
                      正文已变化。这份建议仍可阅读和插入为新段落；替换原文需基于当前稿重新生成。
                    </p>
                  )}
                  <Markdown
                    body={selected.result.overview}
                    onNavigate={props.onNavigate}
                  />
                  {selected.result.edits.length > 0 && (
                    <section className={styles.edits}>
                      <div className={styles.sectionHeading}>
                        <h4>修改对比</h4>
                        <button
                          disabled={
                            disabled ||
                            stale ||
                            selected.appliedEdits.length ===
                              selected.result.edits.length
                          }
                          onClick={() => apply({ operation: "all" })}
                        >
                          采纳全部修改
                        </button>
                      </div>
                      {selected.result.edits.map((edit, index) => (
                        <article key={index} className={styles.edit}>
                          <div className={styles.diff}>
                            <div>
                              <small>原文</small>
                              <pre>{edit.before}</pre>
                            </div>
                            <div>
                              <small>建议</small>
                              <pre>{edit.after}</pre>
                            </div>
                          </div>
                          <div className={styles.editReason}>
                            <p>{edit.reason}</p>
                            <button
                              disabled={
                                disabled ||
                                stale ||
                                selected.appliedEdits.includes(index)
                              }
                              onClick={() =>
                                apply({ operation: "edit", editIndex: index })
                              }
                            >
                              {selected.appliedEdits.includes(index)
                                ? "已采纳"
                                : "采纳这处"}
                            </button>
                          </div>
                        </article>
                      ))}
                    </section>
                  )}
                  {selected.result.suggestions.length > 0 && (
                    <section className={styles.suggestions}>
                      <h4>可以继续推进的方向</h4>
                      {selected.result.suggestions.map((suggestion, index) => (
                        <article key={index} className={styles.suggestion}>
                          <span
                            className={styles.basis}
                            data-basis={suggestion.basis}
                          >
                            {basis[suggestion.basis]}
                          </span>
                          <h5>{suggestion.title}</h5>
                          <Markdown
                            body={suggestion.body}
                            onNavigate={props.onNavigate}
                          />
                          <div className={styles.sources}>
                            {suggestion.evidenceIds.map((sourceId) => {
                              const source = selected.sources.find(
                                (item) => item.id === sourceId,
                              );
                              return source ? (
                                <Source
                                  key={sourceId}
                                  source={source}
                                  navigate={props.onNavigate}
                                />
                              ) : null;
                            })}
                          </div>
                          <button
                            disabled={disabled}
                            onClick={() =>
                              apply({
                                operation: "insert",
                                suggestionIndex: index,
                              })
                            }
                          >
                            <ArrowDownToLine size={13} />
                            插入光标处
                          </button>
                          <button
                            disabled={disabled}
                            onClick={() =>
                              apply({
                                operation: "insert",
                                suggestionIndex: index,
                                insertAtEnd: true,
                              })
                            }
                          >
                            追加到末尾
                          </button>
                        </article>
                      ))}
                    </section>
                  )}
                  <details className={styles.sourceList}>
                    <summary>
                      本次读取的来源 · {selected.sources.length}
                    </summary>
                    {selected.sources.map((source) => (
                      <Source
                        key={source.id}
                        source={source}
                        navigate={props.onNavigate}
                      />
                    ))}
                  </details>
                </div>
              )}
            </>
          )}
          {tab === "history" && (
            <>
              <p className={styles.hint}>
                生成、采纳和恢复前都会留存原稿。AI 建议与正文分别保存。
              </p>
              {data.revisions.length ? (
                <>
                  <label className={styles.version}>
                    原稿版本
                    <select
                      value={snapshotId}
                      disabled={disabled}
                      onChange={(event) => setSnapshotId(event.target.value)}
                    >
                      {data.revisions.map((item) => (
                        <option key={item.id} value={item.id}>
                          {date(item.createdAt)} · {reasons[item.reason]} · r
                          {item.noteRevision}
                        </option>
                      ))}
                    </select>
                  </label>
                  {snapshot && (
                    <article className={styles.snapshot}>
                      <strong>{snapshot.title}</strong>
                      <p className={styles.hint}>
                        {date(snapshot.createdAt)} · {reasons[snapshot.reason]}
                      </p>
                      <div className={styles.snapshotBody}>
                        <Markdown
                          body={snapshot.body || "（空白正文）"}
                          onNavigate={props.onNavigate}
                        />
                      </div>
                      <button
                        disabled={
                          disabled ||
                          (snapshot.title === props.title &&
                            snapshot.body === props.body)
                        }
                        onClick={() =>
                          void perform("note.revision.restore", {
                            snapshotId: snapshot.id,
                          })
                        }
                      >
                        恢复此原稿
                      </button>
                      <small>恢复前会先保存当前内容，之后仍可回退。</small>
                    </article>
                  )}
                </>
              ) : (
                <div className={styles.empty}>
                  还没有原稿快照。首次生成建议前会自动保存一版。
                </div>
              )}
            </>
          )}
        </>
      )}
    </aside>
  );
}

function Source({
  source,
  navigate,
}: {
  source: NoteAssistSource;
  navigate: (href: string) => void;
}) {
  const href = source.paperId
    ? `kb://paper/${source.paperId}`
    : source.noteId
      ? `kb://note/${source.noteId}`
      : null;
  const sourceKind =
    source.kind === "pdf-evidence"
      ? `PDF 证据 · ${source.pageIndex === undefined ? "未记录页码" : `物理第 ${source.pageIndex + 1} 页`}`
      : source.kind === "paper-abstract"
        ? "论文摘要"
        : source.kind === "topic"
          ? "研究问题背景"
          : source.kind === "idea"
            ? "关联想法"
            : "当前笔记";
  return (
    <details className={styles.source}>
      <summary>
        {sourceKind} · {source.title}
      </summary>
      <blockquote>{source.text}</blockquote>
      {href && <button onClick={() => navigate(href)}>打开来源</button>}
    </details>
  );
}
