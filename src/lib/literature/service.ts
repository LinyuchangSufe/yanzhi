import { getStore, type KBStore } from "../db";
import { StoreError } from "../store-error";
import { lookupMetadata, type MetadataLookupInput } from "../import/enrichment";
import { attachFromSource } from "../import/metadata";
import { normalizeIdentifiers } from "../import/normalize-identifiers";
import { cacheLiteratureCandidate, readLiteratureCandidate } from "./cache";
import { resolveLiteratureContext } from "./context";
import { findLiteraturePaper, ensureLiteraturePaper } from "./store";
import { literatureImportSchema, literatureSearchSchema } from "./schemas";
import type { LiteratureCandidate, LiteratureContext, LiteratureImportResult, LiteratureSearchResult } from "./types";

export interface LiteratureDependencies {
  lookup?: typeof lookupMetadata;
  attach?: typeof attachFromSource;
}
function cancelled(signal?: AbortSignal, paperId?: string, created?: boolean) {
  if (signal?.aborted) throw new StoreError(paperId ? "已取消后续下载，已保存的题录和标签保留，可稍后补充 PDF。" : "已取消文献操作，尚未写入。", 499, paperId ? { paperId, created } : undefined);
}
function lookupInput(query: string): MetadataLookupInput {
  return /^(?:https?:\/\/|(?:doi:\s*)?10\.\d{4,9}\/|(?:arxiv:\s*)?(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?$)/i.test(query)
    ? { action: "detail", source: query } : { action: "search", title: query.slice(0, 1001) };
}
export async function searchLiterature(input: { query: string; context?: LiteratureContext }, store: KBStore = getStore(), signal?: AbortSignal, deps: LiteratureDependencies = {}): Promise<LiteratureSearchResult> {
  const parsed = literatureSearchSchema.parse(input); cancelled(signal);
  const scope = resolveLiteratureContext(store, parsed.context), query = lookupInput(parsed.query);
  if (query.action === "search" && query.title.length > 1000) throw new StoreError("题名检索最多 1000 字符，请缩短查询，或提供 DOI、arXiv 标识。", 400);
  const result = await (deps.lookup ?? lookupMetadata)(query, undefined, signal); cancelled(signal);
  const fresh = resolveLiteratureContext(store, parsed.context);
  if (fresh.fingerprint !== scope.fingerprint) throw new StoreError("查询期间来源文献或标签已改变，请按当前范围重新查询。", 409);
  const state = store.snapshot();
  const candidates = result.candidates.filter(candidate => candidate.metadata.title?.trim()).map(candidate => {
    let existing;
    const warnings = [...candidate.warnings];
    try { existing = findLiteraturePaper(state, candidate.metadata); }
    catch (error) { warnings.push(error instanceof Error ? error.message : "已有文献身份待核对。"); }
    const value: LiteratureCandidate = { ...candidate, warnings, candidateToken: cacheLiteratureCandidate(store.dataDir, scope, candidate),
      ...(existing ? { existingPaperId: existing.id, existingTrashed: Boolean(existing.deletedAt), hasPdf: state.attachments.some(file => file.paperId === existing.id && file.status === "available") } : {}) };
    return value;
  });
  return { candidates, warnings: result.warnings, inheritedTags: scope.tags.map(tag => tag.name), contextPaperIds: scope.paperIds, queriedAt: result.queriedAt };
}
const queues = new Map<string, Promise<void>>();
async function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve(); let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; }); queues.set(key, current);
  await previous.catch(() => {});
  try { return await run(); } finally { release(); if (queues.get(key) === current) queues.delete(key); }
}
export async function importLiterature(input: { candidateToken: string; context?: LiteratureContext; downloadPdf: boolean }, store: KBStore = getStore(), signal?: AbortSignal, deps: LiteratureDependencies = {}): Promise<LiteratureImportResult> {
  const parsed = literatureImportSchema.parse(input);
  return serial(store.dataDir, async () => {
    cancelled(signal);
    const cached = readLiteratureCandidate(parsed.candidateToken, store.dataDir), context = resolveLiteratureContext(store, parsed.context);
    if (context.fingerprint !== cached.context.fingerprint) throw new StoreError("来源范围或标签已改变，请重新查询并核对继承标签后入库。", 409);
    const { paper, created } = ensureLiteraturePaper(store, cached.candidate.metadata, context);
    cancelled(signal, paper.id, created);
    const state = store.snapshot(), alreadyHadPdf = state.attachments.some(file => file.paperId === paper.id && file.status === "available");
    const warnings: string[] = [];
    const requestedVersion = normalizeIdentifiers(cached.candidate.metadata).arxivVersion;
    const versionDiffers = Boolean(requestedVersion && requestedVersion !== paper.arxivVersion);
    const originalVersion = paper.arxivVersion ? `arXiv v${paper.arxivVersion}` : "未记录版本";
    let downloaded = false;
    if (parsed.downloadPdf && !alreadyHadPdf) {
      try {
        await (deps.attach ?? attachFromSource)(paper.id, cached.candidate.metadata.sourceUrl, { store, signal });
        cancelled(signal, paper.id, created); downloaded = true;
      } catch (error) {
        cancelled(signal, paper.id, created);
        warnings.push(`题录和标签已保存，PDF 暂未取得：${error instanceof StoreError ? error.message : "下载失败，请稍后重试或手动上传。"}`);
      }
    }
    if (alreadyHadPdf && versionDiffers) warnings.push(`候选指定 arXiv v${requestedVersion}，已有记录为${originalVersion}；本次沿用现有附件，没有下载或替换该指定版本。`);
    else if (alreadyHadPdf && parsed.downloadPdf) warnings.push("库中已有可用 PDF，已复用现有附件；没有覆盖已有文件。");
    if (downloaded && versionDiffers) warnings.push(`本次附件通过候选指定的 arXiv v${requestedVersion} 来源链接获取；原题录为${originalVersion}，题录版本未修改。`);
    return { paperId: paper.id, created, downloaded, alreadyHadPdf, warnings, inheritedTags: context.tags.map(tag => tag.name), state: store.snapshot() };
  });
}
