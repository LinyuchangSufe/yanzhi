import type { KBState, Paper } from "../types";
import { normalizeIdentifiers } from "../import/normalize-identifiers";
import type { LiteratureCandidate, LiteratureContext, LiteratureImportResult, LiteratureSearchResult } from "./types";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export class LiteratureRequestError extends Error {
  constructor(message: string, public readonly status?: number, public readonly details?: Record<string, unknown>) { super(message); }
}
export class LiteratureImportError extends LiteratureRequestError {
  readonly paperId?: string;
  constructor(error: unknown) {
    const source = error instanceof LiteratureRequestError ? error : null;
    super(error instanceof Error ? error.message : "保存请求未能确认，请刷新文献库核对。", source?.status, source?.details);
    const id = source?.details?.paperId ?? source?.details?.existingPaperId;
    if (typeof id === "string" && /^[a-f\d-]{36}$/i.test(id)) this.paperId = id;
  }
}

/** One dialog's requests: obsolete searches cannot replace newer results; writes are serialized. */
export class LiteratureRequests {
  private searchToken = 0;
  private searchController: AbortController | null = null;
  private importing = false;
  constructor(private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}
  cancelSearch(): void { this.searchToken++; this.searchController?.abort(); this.searchController = null; }
  private async post<T>(body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher("/api/kb/literature", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    const value: unknown = await response.json();
    if (!response.ok) { const failure = record(value); throw new LiteratureRequestError(typeof failure.error === "string" ? failure.error : "文献操作暂未完成，请重试。", response.status, record(failure.details)); }
    return value as T;
  }
  async search(query: string, context: LiteratureContext): Promise<LiteratureSearchResult | null> {
    if (this.importing) throw new LiteratureRequestError("正在保存文献，请等待当前操作完成。");
    this.cancelSearch(); const token = this.searchToken, controller = new AbortController(); this.searchController = controller;
    try { const result = await this.post<LiteratureSearchResult>({ action: "search", query: query.trim(), context }, controller.signal); return !controller.signal.aborted && token === this.searchToken ? result : null; }
    catch (error) { if (controller.signal.aborted || token !== this.searchToken) return null; throw error; }
    finally { if (token === this.searchToken) this.searchController = null; }
  }
  async importCandidate(candidateToken: string, context: LiteratureContext): Promise<LiteratureImportResult> {
    if (this.importing) throw new LiteratureRequestError("正在保存文献，请等待当前操作完成。");
    this.cancelSearch(); this.importing = true;
    try { return await this.post<LiteratureImportResult>({ action: "import", candidateToken, context, downloadPdf: true }); }
    catch (error) { throw new LiteratureImportError(error); }
    finally { this.importing = false; }
  }
}

export function literatureScopePaperIds(state: KBState, context: LiteratureContext): string[] {
  const active = new Set(state.papers.filter((paper) => !paper.deletedAt).map((paper) => paper.id));
  const ids = context.paperIds ?? (context.noteId ? state.relations.filter((link) => link.purpose !== "reference" &&
    ((link.fromType === "note" && link.fromId === context.noteId && link.toType === "paper") || (link.toType === "note" && link.toId === context.noteId && link.fromType === "paper")))
    .map((link) => link.fromType === "paper" ? link.fromId : link.toId) : []);
  return [...new Set(ids)].filter((id) => active.has(id)).sort();
}
export function literatureScopeTags(state: KBState, paperIds: readonly string[]): string[] {
  const ids = new Set(paperIds), tags = new Set(state.relations.filter((link) => link.purpose === "tag" &&
    ((link.fromType === "paper" && ids.has(link.fromId) && link.toType === "tag") || (link.toType === "paper" && ids.has(link.toId) && link.fromType === "tag")))
    .map((link) => link.fromType === "tag" ? link.fromId : link.toId));
  return state.tags.filter((tag) => tags.has(tag.id)).map((tag) => tag.name).sort((a, b) => a.localeCompare(b));
}
export function literatureScopeFingerprint(state: KBState, context: LiteratureContext): string {
  const active = literatureScopePaperIds(state, context);
  return JSON.stringify({ paperIds: context.paperIds ?? active, active, tags: literatureScopeTags(state, active),
    noteExists: !context.noteId || state.notes.some((note) => note.id === context.noteId) });
}
/** Resolve only stable identifiers after refreshing; a similar title is insufficient evidence. */
export function existingLiteraturePaper(state: KBState, candidate: LiteratureCandidate): Paper | undefined {
  const known = candidate.existingPaperId && state.papers.find((paper) => paper.id === candidate.existingPaperId);
  if (known) return known;
  try {
    const ids = normalizeIdentifiers(candidate.metadata);
    const matching = state.papers.filter((paper) => (ids.doi && paper.doi === ids.doi) || (ids.arxivId && paper.arxivId === ids.arxivId));
    return matching.length === 1 ? matching[0] : undefined;
  } catch { return undefined; }
}
export function safeLiteratureHref(value: string | undefined): string | undefined {
  try { const url = new URL(value ?? ""); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
export function literatureImportFeedback(result: Pick<LiteratureImportResult, "created" | "downloaded" | "alreadyHadPdf">): { label: string; pdfReady: boolean } {
  if (result.downloaded) return { label: result.created ? "题录与 PDF 已保存" : "PDF 已补齐，所选标签已同步", pdfReady: true };
  if (result.alreadyHadPdf) return { label: "已复用库中的 PDF，所选标签已同步", pdfReady: true };
  return { label: result.created ? "题录已保存，PDF 待补" : "文献已在库中，PDF 待补", pdfReady: false };
}
