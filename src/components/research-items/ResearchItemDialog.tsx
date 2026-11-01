"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { z } from "zod";
import type { KBState } from "../../lib/types";
import type { ResearchItem, ResearchItemDraft, ResearchItemSource } from "../../lib/research-items/types";
import { researchItemSchema, researchItemStatusSchema, researchSourceInputSchema } from "../../lib/research-items/schemas";
import { previewResearchSources, researchInputKey, researchStatusLabels, saveResearchItem } from "../../lib/research-items/client";
import { useProtectedDraft } from "../editor/useProtectedDraft";
import ResearchSourcePicker from "./ResearchSourcePicker";
import ResearchSourcePreview from "./ResearchSourcePreview";
import TooltipButton from "../TooltipButton";
import styles from "./ResearchItems.module.css";

const formSchema = z.object({ id: z.string().uuid(), baseRevision: z.number().int().nonnegative(), topicId: z.string().max(36), title: z.string().max(1000), body: z.string().max(20000), nextAction: z.string().max(5000),
  status: researchItemStatusSchema, sourceRefs: z.array(researchSourceInputSchema).max(12), resultRefs: z.array(researchSourceInputSchema).max(12), resolution: z.string().max(5000) }).strict();

export default function ResearchItemDialog({ state, initial = {}, item, onClose, onSaved }: {
  state: KBState; initial?: ResearchItemDraft; item?: ResearchItem; onClose: () => void; onSaved: (item: ResearchItem) => void | Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(() => ({ id: item?.id ?? crypto.randomUUID(), baseRevision: item?.revision ?? 0, topicId: item?.topicId ?? initial.topicId ?? "", title: item?.title ?? initial.title ?? "", body: item?.body ?? initial.body ?? "", nextAction: item?.nextAction ?? initial.nextAction ?? "", status: item?.status ?? "pending" as const,
    sourceRefs: item?.sourceRefs.map(source => source.input) ?? initial.sources ?? [], resultRefs: item?.resultRefs.map(source => source.input) ?? [], resolution: item?.resolution ?? "" }));
  const baseline = useRef(JSON.stringify(value));
  const [latest, setLatest] = useState(item);
  const [needsReload, setNeedsReload] = useState(false);
  const [saving, setSaving] = useState(false), [error, setError] = useState(""), [loading, setLoading] = useState(false), [previewError, setPreviewError] = useState("");
  const [sources, setSources] = useState<ResearchItemSource[]>(item?.sourceRefs ?? []), [results, setResults] = useState<ResearchItemSource[]>(item?.resultRefs ?? []);
  const draftKey = useRef(`research-item-form:${item?.id ?? initial.topicId ?? "new"}:${JSON.stringify(initial.sources ?? [])}`).current;
  const draft = useProtectedDraft({ key: draftKey, value, dirty: JSON.stringify(value) !== baseline.current, blocked: saving,
    validate: (data: unknown): data is typeof value => formSchema.safeParse(data).success, restore: setValue });
  useEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }, []);
  const saved = useMemo(() => new Map([...(item?.sourceRefs ?? []), ...(item?.resultRefs ?? []), ...(latest?.sourceRefs ?? []), ...(latest?.resultRefs ?? [])].map(source => [researchInputKey(source.input), source])), [item, latest]);
  const sourceKey = JSON.stringify(value.sourceRefs), resultKey = JSON.stringify(value.resultRefs);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setPreviewError("");
    setSources(value.sourceRefs.map(input => saved.get(researchInputKey(input))).filter((source): source is ResearchItemSource => Boolean(source)));
    setResults(value.resultRefs.map(input => saved.get(researchInputKey(input))).filter((source): source is ResearchItemSource => Boolean(source)));
    const freshSources = value.sourceRefs.filter(input => !saved.has(researchInputKey(input))), freshResults = value.resultRefs.filter(input => !saved.has(researchInputKey(input)));
    void Promise.all([freshSources.length ? previewResearchSources(freshSources, abort.signal) : Promise.resolve([]), freshResults.length ? previewResearchSources(freshResults, abort.signal) : Promise.resolve([])]).then(groups => {
      if (abort.signal.aborted) return;
      const values = groups.flat();
      const byKey = new Map([...saved, ...values.map(source => [researchInputKey(source.input), source] as const)]);
      setSources(value.sourceRefs.map(input => byKey.get(researchInputKey(input))!)); setResults(value.resultRefs.map(input => byKey.get(researchInputKey(input))!));
    }).catch((cause: unknown) => { if (!abort.signal.aborted) setPreviewError(cause instanceof Error ? cause.message : "来源预览失败，请重新选择。"); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [sourceKey, resultKey, saved]);
  const remove = (key: string, result = false) => setValue(current => ({ ...current, [result ? "resultRefs" : "sourceRefs"]: (result ? current.resultRefs : current.sourceRefs).filter(input => researchInputKey(input) !== key) }));
  const submit = async () => {
    if (saving || loading || previewError) return;
    setSaving(true); setError(""); setNeedsReload(false);
    try {
      if (value.status === "resolved" && (!value.resultRefs.length || !value.resolution.trim())) throw new Error("标记已解决前，请选择结果来源并写下你的核验判断。");
      if (item && latest && value.baseRevision !== latest.revision) throw new Error("原记录已更新，请先核对当前已保存内容，再明确采用当前修订。");
      const { baseRevision, ...fields } = value;
      const result = await saveResearchItem(item ? { ...fields, action: "update", revision: baseRevision } : { action: "create", id: value.id, topicId: value.topicId, title: value.title, body: value.body, nextAction: value.nextAction, sourceRefs: value.sourceRefs });
      baseline.current = JSON.stringify(value); try { sessionStorage.removeItem(draftKey); } catch {}
      await onSaved(result); onClose();
    } catch (cause) { setNeedsReload((cause as { status?: number } | null)?.status === 409); setError(cause instanceof Error ? cause.message : "保存失败，输入保留。"); }
    finally { setSaving(false); }
  };
  const readLatest = async () => {
    if (!item) return; setSaving(true);
    try { const response = await fetch(`/api/kb/research-items?id=${encodeURIComponent(item.id)}`, { cache: "no-store" }); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "重新读取失败，输入保留。"); setLatest(researchItemSchema.parse(data.items?.[0]));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "重新读取失败，输入保留。"); } finally { setSaving(false); }
  };
  return <dialog ref={dialog} className={styles.dialog} aria-label={item ? "编辑待核验条目" : "加入待核验清单"}
    onCancel={event => { event.preventDefault(); if (!saving) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <header><h2>{item ? "编辑待核验条目" : "加入待核验清单"}</h2><TooltipButton type="button" aria-label="关闭待核验编辑" disabled={saving} onClick={onClose}><X size={17} /></TooltipButton></header>
      <div className={styles.formBody}><fieldset disabled={saving}>
        <label>归属研究问题<select aria-label="待核验归属研究问题" required value={value.topicId} onChange={event => setValue({ ...value, topicId: event.target.value })}><option value="">选择研究问题</option>{state.topics.map(topic => <option key={topic.id} value={topic.id}>{topic.title}</option>)}</select></label>
        {!state.topics.length && <p>请先新建一个研究问题，再归入待核验清单。</p>}
        <label>要核验的问题<input aria-label="待核验问题标题" required maxLength={1000} value={value.title} onChange={event => setValue({ ...value, title: event.target.value })} /></label>
        <label>问题与依据<textarea aria-label="待核验问题说明" maxLength={20000} rows={3} value={value.body} onChange={event => setValue({ ...value, body: event.target.value })} /></label>
        <label>下一步怎么验证<textarea aria-label="待核验下一步" maxLength={5000} rows={2} value={value.nextAction} onChange={event => setValue({ ...value, nextAction: event.target.value })} placeholder="例如：回到定理假设核对，或补一个反例。" /></label>
        <ResearchSourcePicker state={state} value={value.sourceRefs} onChange={sourceRefs => setValue({ ...value, sourceRefs })} />
        {value.sourceRefs.map(input => <div className={styles.selectedSource} key={researchInputKey(input)}><span>{sources.find(source => researchInputKey(source.input) === researchInputKey(input))?.title ?? "所选来源（正在核对）"}</span><button type="button" onClick={() => remove(researchInputKey(input))}>移除来源</button></div>)}
        <ResearchSourcePreview sources={sources} />
        {item && <><label>核验状态<select aria-label="核验状态" value={value.status} onChange={event => setValue({ ...value, status: researchItemStatusSchema.parse(event.target.value) })}>{Object.entries(researchStatusLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></label>
          <label>我的核验判断<textarea aria-label="我的核验判断" maxLength={5000} rows={3} value={value.resolution} onChange={event => setValue({ ...value, resolution: event.target.value })} placeholder="说明依据、限制或尚不能确认的地方。" /></label>
          <ResearchSourcePicker state={state} results value={value.resultRefs} onChange={resultRefs => setValue({ ...value, resultRefs })} />
          {value.resultRefs.map(input => <div className={styles.selectedSource} key={researchInputKey(input)}><span>{results.find(source => researchInputKey(source.input) === researchInputKey(input))?.title ?? "所选结果（正在核对）"}</span><button type="button" onClick={() => remove(researchInputKey(input), true)}>移除结果来源</button></div>)}
          <ResearchSourcePreview sources={results} /><p className={styles.hint}>AI 建议和讨论不等于验证结果；“已解决”由你选择结果来源并明确确认。</p></>}
        {loading && <p role="status">正在核对来源快照…</p>}{previewError && <p className={styles.error} role="alert">{previewError}</p>}
        {(error || draft.storageError) && <p className={styles.error} role="alert">{error || draft.storageError}</p>}
        {item && (needsReload || latest?.revision !== value.baseRevision) && <button type="button" onClick={() => void readLatest()}>读取最新记录，保留当前输入</button>}
        {latest && value.baseRevision !== latest.revision && <div className={styles.conflict}>
          <details><summary>核对当前已保存内容（修订 {latest.revision}）</summary><strong>{latest.title}</strong><blockquote>{latest.body}</blockquote><p>下一步：{latest.nextAction || "未填写"}</p><p>状态：{researchStatusLabels[latest.status]}；我的判断：{latest.resolution || "未填写"}</p></details>
          {latest.archivedAt ? <p>条目已归档，请关闭后先在清单中恢复；当前输入仍保留。</p> : <button type="button" onClick={() => { setValue({ ...value, baseRevision: latest.revision }); setError(""); }}>核对后采用当前修订，保留我的输入</button>}
        </div>}
        {draft.restored && <p className={styles.hint}>已恢复本窗口未保存的输入。</p>}
      </fieldset></div>
      <footer><button type="button" disabled={saving} onClick={onClose}>取消</button><button type="submit" disabled={saving || loading || Boolean(previewError) || !value.topicId || !value.title.trim()}>{saving ? "保存中…" : item ? "保存核验记录" : "确认加入待核验"}</button></footer>
    </form>
  </dialog>;
}
