"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KBState } from "../../lib/types";
import type { LiteratureCandidate, LiteratureContext, LiteratureSearchResult } from "../../lib/literature/types";
import { LiteratureImportError, LiteratureRequests, literatureImportFeedback, literatureScopeFingerprint, literatureScopePaperIds, literatureScopeTags } from "../../lib/literature/client";
import { persistSessionDraft, readSessionDraft, registerLeaveGuard } from "../../lib/editor/pending-edits";

export interface CandidateOutcome { paperId?: string; label: string; pdfReady: boolean; warnings: string[]; uncertain?: boolean }
interface QueryDraft { query: string; paperIds: string[] }
const validDraft = (value: unknown): value is QueryDraft => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.query === "string" && item.query.length <= 4000 && Array.isArray(item.paperIds) && item.paperIds.length <= 16 && item.paperIds.every((id) => typeof id === "string" && /^[a-f\d-]{36}$/i.test(id));
};
export function useLiteratureDialog({ state, context, initialQuery = "", onChanged }: { state: KBState; context: LiteratureContext; initialQuery?: string; onChanged: () => Promise<void> }) {
  const requests = useMemo(() => new LiteratureRequests(), []);
  const [query, setQuery] = useState(initialQuery.trim());
  const [paperIds, setPaperIds] = useState(() => literatureScopePaperIds(state, context));
  const [result, setResult] = useState<{ data: LiteratureSearchResult; query: string; context: LiteratureContext; fingerprint: string } | null>(null);
  const [searching, setSearching] = useState(false), [savingToken, setSavingToken] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [stale, setStale] = useState("");
  const [outcomes, setOutcomes] = useState<Record<string, CandidateOutcome>>({});
  const [restored, setRestored] = useState(false), [storageError, setStorageError] = useState(""), [readyKey, setReadyKey] = useState("");
  const contextKey = JSON.stringify({ noteId: context.noteId ?? null, paperIds: context.paperIds ? [...context.paperIds].sort() : null });
  const draftKey = `literature-query-v1:${contextKey}`, initializationKey = `${contextKey}:${initialQuery.trim()}`;
  const currentContext: LiteratureContext = { ...(context.noteId ? { noteId: context.noteId } : {}), paperIds: [...paperIds].sort() };
  const fingerprint = literatureScopeFingerprint(state, currentContext);
  const busy = useRef(false), generation = useRef(0), mounted = useRef(true);
  const latest = useRef({ state, context, currentContext, fingerprint, onChanged });
  latest.current = { state, context, currentContext, fingerprint, onChanged };
  const cancelSearch = (showNotice = true) => {
    generation.current++; requests.cancelSearch(); setSearching(false);
    if (showNotice) setNotice("查询已取消。");
  };
  useLayoutEffect(() => {
    cancelSearch(false); setResult(null); setOutcomes({}); setStale(""); setError(""); setNotice(""); setRestored(false);
    let draft: QueryDraft | null = null;
    try { if (!initialQuery.trim()) draft = readSessionDraft(sessionStorage, draftKey, validDraft); setStorageError(""); }
    catch { setStorageError("本窗口无法保留查询草稿，可继续搜索。"); }
    const active = new Set(latest.current.state.papers.filter((paper) => !paper.deletedAt).map((paper) => paper.id));
    setQuery(initialQuery.trim() || draft?.query || "");
    setPaperIds(draft ? [...new Set(draft.paperIds)].filter((id) => active.has(id)) : literatureScopePaperIds(latest.current.state, latest.current.context));
    setRestored(Boolean(draft)); setReadyKey(initializationKey);
  }, [initializationKey, draftKey]);
  useLayoutEffect(() => {
    if (readyKey !== initializationKey) return;
    try { persistSessionDraft(sessionStorage, draftKey, { query, paperIds }, Boolean(query.trim())); setStorageError(""); }
    catch { setStorageError("本窗口无法保留查询草稿，可继续搜索。"); }
  }, [draftKey, initializationKey, readyKey, query, paperIds]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; requests.cancelSearch(); }; }, [requests]);
  useEffect(() => registerLeaveGuard(() => !busy.current), []);
  useEffect(() => {
    if (!savingToken) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect); return () => window.removeEventListener("beforeunload", protect);
  }, [savingToken]);
  useEffect(() => {
    if (result && result.fingerprint !== fingerprint) { cancelSearch(false); setStale("标签来源范围或标签已改变，请重新搜索后再保存。"); }
  }, [fingerprint, result?.fingerprint]);

  const search = async (text = query) => {
    if (busy.current || text.trim().length < 2) return;
    if ((latest.current.currentContext.paperIds?.length ?? 0) > 16) { setError("最多从 16 篇文献继承标签，请先减少所选范围。"); return; }
    const token = ++generation.current, snapshot = latest.current;
    const searchContext: LiteratureContext = { ...(snapshot.currentContext.noteId ? { noteId: snapshot.currentContext.noteId } : {}), paperIds: [...(snapshot.currentContext.paperIds ?? [])] };
    setSearching(true); setError(""); setNotice(""); setStale(""); setResult(null); setOutcomes({});
    try {
      const data = await requests.search(text, searchContext);
      if (!data || token !== generation.current || !mounted.current) return;
      if (snapshot.fingerprint !== latest.current.fingerprint) { setStale("查询期间标签来源发生变化，请重新搜索。"); return; }
      setResult({ data, query: text.trim(), context: searchContext, fingerprint: snapshot.fingerprint });
    } catch (failure) {
      if (token === generation.current && mounted.current) setError(failure instanceof Error ? failure.message : "查询失败，请重试。");
    } finally { if (token === generation.current && mounted.current) setSearching(false); }
  };
  useEffect(() => {
    if (readyKey === initializationKey && initialQuery.trim().length >= 2) void search(initialQuery.trim());
  }, [readyKey, initializationKey]);

  const changeQuery = (value: string) => { if (busy.current) return; cancelSearch(false); setQuery(value); setResult(null); setOutcomes({}); setError(""); setStale(""); setNotice(""); };
  const togglePaper = (id: string, checked: boolean) => {
    if (busy.current) return; cancelSearch(false);
    setPaperIds((old) => checked ? [...new Set([...old, id])] : old.filter((value) => value !== id));
    if (result) setStale("标签来源范围已改变，请重新搜索后再保存。");
    setNotice(""); setError("");
  };
  const refresh = async () => {
    try { await latest.current.onChanged(); setNotice("已重新读取文献库，请核对候选的已有记录状态。"); }
    catch { setError("文献库刷新暂未完成，请稍后重试。保存结果请以文献库为准。"); }
  };
  const save = async (candidate: LiteratureCandidate) => {
    if (busy.current || !result || stale || result.fingerprint !== latest.current.fingerprint || candidate.existingTrashed) return;
    busy.current = true; setSavingToken(candidate.candidateToken); setError(""); setNotice("");
    try {
      const imported = await requests.importCandidate(candidate.candidateToken, result.context);
      if (mounted.current) setOutcomes((old) => ({ ...old, [candidate.candidateToken]: { paperId: imported.paperId, ...literatureImportFeedback(imported), warnings: imported.warnings } }));
      try { await latest.current.onChanged(); }
      catch { if (mounted.current) setError("文献已保存，但列表刷新暂未完成。请重新刷新文献库核对。"); }
    } catch (failure) {
      const savedId = failure instanceof LiteratureImportError ? failure.paperId : undefined;
      if (mounted.current) {
        setOutcomes((old) => ({ ...old, [candidate.candidateToken]: { ...old[candidate.candidateToken], paperId: savedId ?? old[candidate.candidateToken]?.paperId,
          label: savedId || old[candidate.candidateToken]?.paperId ? "题录已在库中，PDF 状态请刷新核对" : "请求结果尚未确认，请刷新文献库核对", pdfReady: old[candidate.candidateToken]?.pdfReady ?? false,
          uncertain: true, warnings: [failure instanceof Error ? failure.message : "请求中断，可能已有题录保存。"] } }));
        if (failure instanceof LiteratureImportError && [409, 410].includes(failure.status ?? 0)) setStale("候选或标签来源已变化，请重新搜索后再试。");
      }
      try { await latest.current.onChanged(); }
      catch { if (mounted.current) setError("文献库刷新暂未完成，请稍后核对保存结果；请勿将请求中断理解为未保存。"); }
    } finally { busy.current = false; if (mounted.current) setSavingToken(""); }
  };
  return { query, paperIds, result, searching, savingToken, error, notice, stale, outcomes, restored, storageError,
    tags: result && !stale ? result.data.inheritedTags : literatureScopeTags(state, paperIds),
    scopePapers: state.papers.filter((paper) => !paper.deletedAt && (paperIds.includes(paper.id) || literatureScopePaperIds(state, context).includes(paper.id))),
    search, cancelSearch, changeQuery, togglePaper, save, refresh };
}
