"use client";
import {
  BookOpen,
  ChevronRight,
  FolderOpen,
  Lightbulb,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CodexConnectionStatus } from "../lib/ai/codex-check";
import type { KBState } from "../lib/types";
import type { WorkspaceController } from "./Workspace";
import LibraryPaperList from "./LibraryPaperList";
import LibraryFilters from "./LibraryFilters";
import ObjectActions from "./menus/ObjectActions";
import { plainTextPreview } from "../lib/plain-text-preview";
import { useProtectedDraft } from "./editor/useProtectedDraft";
import baseStyles from "./Workspace.module.css";
import { Empty } from "./WorkspaceDialogs";
import {
  errorMessage,
  formatDate,
  linked,
  readResponse,
} from "./WorkspaceShared";
import contentStyles from "./styles/WorkspaceContent.module.css";
import pageStyles from "./styles/LibraryPages.module.css";
const styles = { ...baseStyles, ...contentStyles, ...pageStyles };

export function LibraryPages({ c }: { c: WorkspaceController }) {
  const [checkingAI, setCheckingAI] = useState(false);
  const {
    state,
    view,
    section,
    busy,
    dirty,
    sort,
    topicFilter,
    tagFilter,
    missingOnly,
    aiConfig,
    restoreMessage,
    visiblePapers,
    activePapers,
    trashedPapers,
    ideas,
    paperRow,
    setSection,
    setError,
    setDialog,
    setBusy,
    setSort,
    setTopicFilter,
    setTagFilter,
    setMissingOnly,
    setAiConfig,
    setRestoreMessage,
    mutate,
    leaveEditor,
    navigate,
  } = c;
  const checkAI = async () => {
    setCheckingAI(true);
    try {
      setAiConfig(await readResponse(await fetch("/api/kb/ai")));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setCheckingAI(false);
    }
  };
  useEffect(() => {
    if (view.kind !== "home" || section !== "settings") return;
    const controller = new AbortController();
    setCheckingAI(true);
    void fetch("/api/kb/ai", { signal: controller.signal })
      .then(readResponse).then(setAiConfig)
      .catch((error: unknown) => { if (!controller.signal.aborted) setError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setCheckingAI(false); });
    return () => controller.abort();
  }, [view.kind, section, setAiConfig, setError]);
  return (
    <>
      {view.kind === "home" &&
        ["all", "unread"].includes(section) && (
          <div className={styles.library}>
            <div className={styles.pageHeading}>
              <div>
                <h1>
                  {section === "unread" ? "待阅读" : "全部文献"}
                  <span>{visiblePapers.length}</span>
                </h1>
              </div>
              <div className={styles.actions}><button type="button" className={styles.primary} onClick={() => setDialog({ kind: "paper" })}><Plus size={15} aria-hidden="true" />添加文献</button>
                <ObjectActions label="文献库更多操作" actions={[{ label: "查找并收藏文献", onSelect: () => c.openLiterature("", {}) }, { label: c.pdfShare.pending ? "正在整理 PDF…" : "打开 PDF 文件夹", disabled: busy || c.pdfShare.pending, onSelect: async () => { await c.pdfShare.prepare(); } }]} /></div>
            </div>
            <LibraryFilters c={c} />
            {visiblePapers.length ? (
              <LibraryPaperList key={JSON.stringify([section, topicFilter, tagFilter, missingOnly, sort])} c={c} />
            ) : (
              <div className={styles.empty}>
                <div className={styles.emptyIcon}>
                  <BookOpen size={32} />
                </div>
                <h2>
                  {section === "unread" && !activePapers.some((paper) => paper.inReadingList)
                    ? "待阅读清单是空的"
                    : activePapers.length
                    ? "没有符合筛选的文献"
                    : "从第一篇文献开始"}
                </h2>
                <p>
                  {section === "unread" && !activePapers.some((paper) => paper.inReadingList)
                    ? "到全部文献勾选想读的文章，点击“加入待阅读”。新导入的文献不会自动加入。"
                    : activePapers.length
                    ? "清除筛选，或切换到全部文献。"
                    : "粘贴 DOI、arXiv、网页链接，或导入本地 PDF。没有全文也可以开始记笔记。"}
                </p>
                {(activePapers.length > 0 || section === "unread") && <button
                  className={styles.primary}
                  onClick={() =>
                    activePapers.length || section === "unread"
                      ? (setTopicFilter(""),
                        setTagFilter(""),
                        setMissingOnly(false),
                        setSection("all"))
                      : setDialog({ kind: "paper" })
                  }
                >
                  {section === "unread" && !activePapers.some((paper) => paper.inReadingList)
                    ? "前往全部文献"
                    : activePapers.length ? "清除筛选" : "添加第一篇文献"}
                </button>}
              </div>
            )}
            <div className={styles.libraryFoot}>
              <span>勾选文献后可加入或移出待阅读</span>
              <span>
                {activePapers.length} 篇文献 ·{" "}
                {state.notes.filter((n) => n.body).length} 篇个人笔记
              </span>
            </div>
          </div>
        )}
      {view.kind === "home" && section === "trash" && (
        <div className={styles.library}>
          <div className={styles.pageHeading}>
            <div>
              <h1>
                回收站<span>{trashedPapers.length}</span>
              </h1>
              {trashedPapers.length > 0 && <p>恢复文献时，PDF、笔记和批注会一并保留。</p>}
            </div>
          </div>
          {visiblePapers.length ? (
            <div className={styles.paperList}>
              <div className={styles.listHeader}>
                <span>文献</span>
                <span>移入时间</span>
              </div>
              {visiblePapers.map((item) => paperRow(item))}
            </div>
          ) : (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>
                <Trash2 size={30} />
              </div>
              <h2>回收站是空的</h2>
              <p>移入回收站的文献会保存在这里，可随时恢复。</p>
            </div>
          )}
        </div>
      )}
      {view.kind === "home" && section === "topics" && (
        <div className={styles.library}>
          <div className={styles.pageHeading}>
            <div>
              <h1>
                研究问题<span>{state.topics.length}</span>
              </h1>
            </div>
            <button className={styles.primary} onClick={() => setDialog({ kind: "topic" })}>
              <Plus size={15} />
              新建研究问题
            </button>
          </div>
          <div className={styles.objectList}>
            {state.topics.map((t) => (
              <button
                key={t.id}
                onClick={() => void navigate({ kind: "topic", id: t.id })}
              >
                <FolderOpen size={19} />
                <div>
                  <strong>{t.title}</strong>
                  <p>{plainTextPreview(t.description, { title: t.title, maxLength: 110 }) || "还没有问题描述"}</p>
                  <small>
                    {
                      activePapers.filter((p) =>
                        linked(state, "paper", p.id, "topic", t.id),
                      ).length
                    }{" "}
                    篇论文 · {formatDate(t.updatedAt)}
                  </small>
                </div>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
          {!state.topics.length && (
            <Empty
              title="从一个研究问题开始"
              text="写下你正在探索的问题，再逐步关联论文与思考。"
            />
          )}
        </div>
      )}
      {view.kind === "home" && section === "ideas" && (
        <div className={styles.library}>
          <div className={styles.pageHeading}>
            <div>
              <h1>
                我的想法<span>{ideas.length}</span>
              </h1>
            </div>
            <button className={styles.primary} onClick={() => setDialog({ kind: "idea" })}>
              <Plus size={15} />
              新建想法
            </button>
          </div>
          <div className={styles.objectList}>
            {ideas.map((n) => (
              <button
                key={n.id}
                onClick={() => void navigate({ kind: "note", id: n.id })}
              >
                <Lightbulb size={19} />
                <div>
                  <strong>{n.title}</strong>
                  <p>
                    {plainTextPreview(n.body, { title: n.title, maxLength: 120 }) ||
                      "还没有正文"}
                  </p>
                  <small>{(state.ideaConversations ?? []).filter((item) => item.noteId === n.id).length} 段讨论 · {(state.ideaSummaries ?? []).filter((item) => item.noteId === n.id).length} 份整理 · {formatDate(n.updatedAt)}</small>
                </div>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
          {!ideas.length && (
            <Empty
              title="把闪过的想法留下来"
              text="想法可以独立存在，也可以关联多篇论文和多个研究问题。"
            />
          )}
        </div>
      )}
      {view.kind === "home" && section === "settings" && (
        <div className={styles.detailPage}>
          <h1>设置与数据</h1>
          {c.settingsReturn && <div className={styles.settingsReturn}><button type="button"
            onClick={() => void c.returnFromSettings()}>← 返回工作区</button></div>}
          <section className={styles.settingSection} id="ai-settings">
            <div className={styles.sectionHeading}><h2>模型与连接</h2><button type="button" disabled={checkingAI} onClick={() => void checkAI()}>{checkingAI ? "正在读取…" : "刷新状态"}</button></div>
            {aiConfig && <AIConfigurationDetails config={aiConfig} />}
            <AISettings
              settings={state.settings}
              checking={checkingAI}
              onSave={async (payload) => {
                await mutate("settings.update", payload);
                setAiConfig(await readResponse(await fetch("/api/kb/ai")));
              }}
            />
            <details className={styles.technical}><summary>连接方式与数据使用说明</summary><p>AI 为可选辅助。仅在点击生成或测试连接时调用，生成时使用你选择的资料；AI 内容独立保存，采纳后才写入笔记。</p><p>Codex CLI 复用本机登录，模型推理需要联网并使用账户额度。兼容 API 的密钥通过后端环境变量配置，具体参数见项目 README。后端环境变量优先于网页设置。</p></details>
          </section>
          <section className={styles.settingSection}>
            <h2>备份与导出</h2>
            <p>完整备份保留文献、附件、笔记、批注和关联；Markdown 适合阅读和迁移正文。</p>
            <div className={styles.actions}>
              <a className={styles.buttonLink} href="/api/kb/export">
                导出全部 Markdown
              </a>
              <a
                className={styles.buttonLink}
                href="/api/kb/backup"
                onClick={async (e) => {
                  if (dirty) {
                    e.preventDefault();
                    if (await leaveEditor())
                      window.location.href = "/api/kb/backup";
                  }
                }}
              >
                导出完整备份
              </a>
            </div>
            <div className={styles.actions}><button type="button" disabled={busy || c.pdfShare.pending} onClick={() => void c.pdfShare.prepare()}>{c.pdfShare.pending ? "正在整理 PDF…" : "打开 PDF 文件夹"}</button></div>
            <details className={styles.technical}><summary>数据保存位置</summary><p>数据库与 PDF 附件保存在服务端配置的 <code>KB_DATA_DIR</code> 目录。备份不包含 AI 密钥，应用默认仅供本机访问。</p></details>
          </section>
          <section className={styles.settingSection}>
            <h2>从备份恢复</h2>
            <p>
              先校验归档，将内容恢复到新的空目录，不覆盖当前知识库。成功后按提示修改数据目录并重启本地服务。
            </p>
            <input
              type="file"
              aria-label="选择完整备份"
              accept=".zip,.json,.gz,.tar"
              disabled={busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file || !(await leaveEditor())) return;
                setBusy(true);
                setRestoreMessage("");
                const form = new FormData();
                form.append("file", file);
                try {
                  const result = await readResponse(
                    await fetch("/api/kb/backup", {
                      method: "POST",
                      body: form,
                    }),
                  );
                  setRestoreMessage(JSON.stringify(result, null, 2));
                } catch (err) {
                  setError(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            />
            {busy && <p>正在验证与恢复…</p>}
            {restoreMessage && <RestoreResult message={restoreMessage} />}
          </section>

        </div>
      )}
    </>
  );
}
function AIConfigurationDetails({
  config,
}: {
  config: Record<string, unknown>;
}) {
  const providerNames: Record<string, string> = {
    none: "不启用 AI",
    ollama: "Ollama 本地模型",
    codex: "Codex CLI",
    "openai-compatible": "兼容 OpenAI 的 API",
  };
  const rows: [string, string][] = [];
  if (config.endpoint) rows.push(["服务地址", String(config.endpoint)]);
  if (config.environmentOverride)
    rows.push(["配置来源", "后端环境变量覆盖网页设置"]);
  if (config.message) rows.push(["说明", String(config.message)]);
  const status = config.codexStatus;
  if (status && typeof status === "object") {
    const codex = status as Record<string, unknown>;
    rows.push(["Codex CLI", codex.installed ? "已安装" : "未检测到"]);
    if (codex.version) rows.push(["CLI 版本", String(codex.version)]);
    rows.push(["CLI 登录", codex.authenticated ? "已登录" : "未确认登录"]);
    if (codex.message) rows.push(["检测结果", String(codex.message)]);
  }
  return (
    <div className={styles.configuration} aria-live="polite">
      <p><strong>{providerNames[String(config.provider)] || String(config.provider)}</strong><span>{config.model ? String(config.model) : "默认模型"}</span></p>
      <p className={styles.muted}>{config.provider === "none" ? "尚未启用 AI，阅读和笔记功能可正常使用。" : config.configured ? "已选择配置，实际连接可通过下方测试确认。" : "尚未完成配置，请检查下方设置。"}</p>
      {!!rows.length && <details className={styles.technical}><summary>配置详情</summary><dl className={styles.configList}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl></details>}
    </div>
  );
}
function RestoreResult({ message }: { message: string }) {
  let result: Record<string, unknown> | null = null;
  try { const parsed: unknown = JSON.parse(message); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) result = parsed as Record<string, unknown>; } catch { /* Keep older messages readable. */ }
  const counts = result?.counts && typeof result.counts === "object" ? result.counts as Record<string, unknown> : null;
  const warnings = Array.isArray(result?.warnings) ? result.warnings.filter((warning): warning is string => typeof warning === "string") : [];
  return <div className={styles.restoreResult} role="status">
    <strong>{result?.restoredDirectory ? "备份已校验并恢复到新目录" : "恢复结果"}</strong>
    {result?.restoredDirectory ? <><p>当前知识库保持原样。要使用恢复的数据，请将服务的数据目录改为下方位置，再重启本地服务。</p><code>{String(result.restoredDirectory)}</code></> : <p>{message}</p>}
    {counts && <p>已恢复 {Number(counts.papers) || 0} 篇文献、{Number(counts.notes) || 0} 篇笔记和 {Number(counts.annotations) || 0} 条批注。</p>}
    {warnings.length > 0 && <p>有 {warnings.length} 项需要检查（例如缺失附件），请展开诊断详情查看。</p>}
    {result && <details className={styles.technical}><summary>诊断详情与启动命令</summary><pre>{message}</pre></details>}
  </div>;
}
function AISettings({
  settings,
  onSave,
  checking,
}: {
  settings: KBState["settings"];
  onSave: (payload: Record<string, unknown>) => Promise<void>;
  checking: boolean;
}) {
  const [provider, setProvider] = useState(settings.aiProvider);
  const [url, setUrl] = useState(
    provider === "openai-compatible" ? settings.openaiUrl : settings.ollamaUrl,
  );
  const [model, setModel] = useState(
    provider === "codex"
      ? (settings.codexModel ?? "")
      : provider === "openai-compatible"
        ? settings.openaiModel
        : settings.ollamaModel,
  );
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<CodexConnectionStatus>();
  const [probeError, setProbeError] = useState("");
  const clean = {
    provider: settings.aiProvider,
    url: settings.aiProvider === "openai-compatible" ? settings.openaiUrl : settings.ollamaUrl,
    model: settings.aiProvider === "codex" ? (settings.codexModel ?? "") :
      settings.aiProvider === "openai-compatible" ? settings.openaiModel : settings.ollamaModel,
  };
  const changed = provider !== clean.provider || model !== clean.model ||
    ((provider === "ollama" || provider === "openai-compatible") && url !== clean.url);
  const draft = useProtectedDraft({
    key: "research-ai-settings-draft-v1",
    value: { provider, url, model }, dirty: changed, blocked: saving,
    validate: (value: unknown): value is typeof clean => {
      if (!value || typeof value !== "object") return false;
      const item = value as Record<string, unknown>;
      return ["none", "ollama", "codex", "openai-compatible"].includes(String(item.provider)) &&
        typeof item.url === "string" && typeof item.model === "string";
    },
    restore: (value) => { setProvider(value.provider); setUrl(value.url); setModel(value.model); },
  });
  const testRequest = useRef<AbortController | null>(null);
  const testToken = useRef(0);
  useEffect(
    () => () => {
      testToken.current++;
      testRequest.current?.abort();
    },
    [],
  );
  const clearProbe = () => {
    testToken.current++;
    testRequest.current?.abort();
    testRequest.current = null;
    setTesting(false);
    setProbe(undefined);
    setProbeError("");
    setMessage("");
  };
  const testCodex = async () => {
    if (testRequest.current || saving || checking) return;
    const token = ++testToken.current;
    const controller = new AbortController();
    testRequest.current = controller;
    setTesting(true);
    setProbe(undefined);
    setProbeError("");
    setMessage("");
    // Local version/login checks each allow eight seconds; the actual model
    // request allows 45 seconds. Include a small transport margin as well.
    const timeout = setTimeout(() => controller.abort(), 75000);
    try {
      const result = (await readResponse(
        await fetch("/api/kb/ai/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "codex", model: model.trim() }),
          signal: controller.signal,
        }),
      )) as { codexStatus: CodexConnectionStatus };
      if (token !== testToken.current) return;
      if (!result.codexStatus) throw new Error("未收到连接测试结果，请重试。");
      setProbe(result.codexStatus);
    } catch (error) {
      if (token !== testToken.current) return;
      setProbeError(
        controller.signal.aborted
          ? "连接测试超时，请检查网络后重试。"
          : errorMessage(error),
      );
    } finally {
      clearTimeout(timeout);
      if (token === testToken.current) {
        testRequest.current = null;
        setTesting(false);
      }
    }
  };
  return (
    <form
      className={styles.aiSettings}
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving || testing || checking) return;
        setSaving(true);
        setMessage("正在保存…");
        try {
          await onSave({
            aiProvider: provider,
            ...(provider === "ollama"
              ? { ollamaUrl: url, ollamaModel: model }
              : provider === "openai-compatible"
                ? { openaiUrl: url, openaiModel: model }
                : provider === "codex"
                  ? { codexModel: model.trim() }
                  : {}),
          });
          setMessage(
            provider === "codex"
              ? "配置已保存。可点击“测试连接”确认模型响应。"
              : "配置已保存。",
          );
        } catch (error) {
          setMessage(errorMessage(error));
        } finally {
          setSaving(false);
        }
      }}
    >
      {changed && <div className={styles.notice} role="status">
        {draft.storageError || (draft.restored ? "已恢复本窗口未保存的配置。" : "配置尚未保存，已保留在本窗口草稿中。")}
        <button type="button" disabled={saving || testing} onClick={() => {
          clearProbe(); setProvider(clean.provider); setUrl(clean.url); setModel(clean.model);
        }}>放弃未保存修改</button>
      </div>}
      <label>
        AI 服务
        <select
          value={provider}
          disabled={saving || testing}
          onChange={(e) => {
            clearProbe();
            const next = e.target.value as KBState["settings"]["aiProvider"];
            setProvider(next);
            setUrl(
              next === "openai-compatible"
                ? settings.openaiUrl
                : settings.ollamaUrl,
            );
            setModel(
              next === "codex"
                ? (settings.codexModel ?? "")
                : next === "openai-compatible"
                  ? settings.openaiModel
                  : settings.ollamaModel,
            );
          }}
        >
          <option value="none">不启用 AI</option>
          <option value="ollama">Ollama 本地模型</option>
          <option value="codex">Codex CLI（本机登录）</option>
          <option value="openai-compatible">兼容 OpenAI 的 API</option>
        </select>
      </label>
      {provider !== "none" && (
        <>
          {provider !== "codex" && (
            <label>
              服务地址
              <input
                aria-label="AI 服务地址"
                type="url"
                required
                disabled={saving || testing}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
          )}
          <label>
            {provider === "codex" ? "模型（可选）" : "模型"}
            <input
              aria-label="AI 模型"
              required={provider !== "codex"}
              disabled={saving || testing}
              placeholder={
                provider === "codex" ? "留空使用 Codex CLI 默认模型" : undefined
              }
              value={model}
              onChange={(e) => {
                clearProbe();
                setModel(e.target.value);
              }}
            />
          </label>
        </>
      )}
      {provider === "codex" && (
        <>
          <p className={styles.muted}>测试上方所填模型，不会保存配置。测试会发送固定短文本，消耗少量额度，不读取文献和笔记。</p>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={checking || saving || testing}
              onClick={() => void testCodex()}
            >
              {testing ? "正在测试连接…" : "测试连接"}
            </button>
            {testing && (
              <button
                type="button"
                onClick={() => {
                  clearProbe();
                  setProbeError("连接测试已取消。");
                }}
              >
                取消测试
              </button>
            )}
          </div>
        </>
      )}
      <button type="submit" className={styles.primary} disabled={saving || checking || testing}>
        {saving ? "正在保存…" : "保存 AI 配置"}
      </button>
      {message && <p role="status">{message}</p>}
      {provider === "codex" && (
        <div
          className={styles.codexProbe}
          aria-live="polite"
          aria-busy={testing}
        >
          {testing && <p>正在确认 CLI 安装、登录和模型实际响应…</p>}
          {probeError && <p className={styles.probeError}>{probeError}</p>}
          {probe && <CodexProbeResult status={probe} />}
        </div>
      )}
    </form>
  );
}

function CodexProbeResult({ status }: { status: CodexConnectionStatus }) {
  const rows: [string, string][] = [
    ["CLI 安装", status.installed ? "已安装" : "未检测到"],
    ["CLI 登录", status.authenticated ? "已登录" : "未确认登录"],
    [
      "模型调用",
      status.service === "available"
        ? "测试通过"
        : status.service === "unavailable"
          ? "测试未通过"
          : "未测试",
    ],
    [
      "测试模型",
      status.model && status.model !== "cli-default"
        ? status.model
        : "CLI 默认模型",
    ],
    [
      "测试时间",
      `${new Date(status.checkedAt).toLocaleString("zh-CN")} · ${(status.elapsedMs / 1000).toFixed(1)} 秒`,
    ],
  ];
  if (status.version) rows.push(["CLI 版本", status.version]);
  return (
    <>
      <p className={status.service === "available" ? undefined : styles.probeError}>{status.message}</p>
      <details className={styles.technical}><summary>测试详情与排查</summary><dl className={styles.configList}>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl><p>后端环境变量优先，以“测试模型”为准。表单配置需保存后才用于生成。未登录时，请在本机终端运行 <code>codex login</code>。</p></details>
    </>
  );
}
