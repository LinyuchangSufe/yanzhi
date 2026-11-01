import type { KBStore } from "../db";
import { normalizeIdentifiers } from "../import/normalize-identifiers";
import { normalizeUrl } from "../import/normalize";
import type { Metadata } from "../import/metadata";
import type { KBState, Paper } from "../types";
import { StoreError } from "../store-error";
import type { ResolvedLiteratureContext } from "./context";

function canonicalSource(source: string) {
  if (!source) return "";
  try {
    const url = new URL(normalizeUrl(source).url); url.hash = ""; url.searchParams.sort();
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch { return ""; }
}
export function findLiteraturePaper(state: KBState, metadata: Metadata): Paper | undefined {
  const ids = normalizeIdentifiers(metadata), source = canonicalSource(metadata.sourceUrl);
  const matches = state.papers.filter(paper => (ids.doi && paper.doi === ids.doi) || (ids.arxivId && paper.arxivId === ids.arxivId));
  if (matches.length > 1) throw new StoreError("候选的 DOI 与 arXiv 指向不同的已有记录，请先核对文献身份。", 409);
  if (matches[0]) {
    const paper = matches[0];
    if ((ids.doi && paper.doi && ids.doi !== paper.doi) || (ids.arxivId && paper.arxivId && ids.arxivId !== paper.arxivId))
      throw new StoreError("候选的文献标识与已有档案冲突，请核对 DOI 和 arXiv 身份后再入库。", 409);
    return paper;
  }
  const urls = source ? state.papers.filter(paper => canonicalSource(paper.sourceUrl) === source &&
    !(ids.doi && paper.doi && ids.doi !== paper.doi) && !(ids.arxivId && paper.arxivId && ids.arxivId !== paper.arxivId)) : [];
  if (urls.length > 1) throw new StoreError("同一来源链接对应多个已有档案，请先在文献库核对。", 409);
  return urls[0];
}
export function ensureLiteraturePaper(store: KBStore, metadata: Metadata, context: ResolvedLiteratureContext): { paper: Paper; created: boolean } {
  const state = store.snapshot();
  let paper = findLiteraturePaper(state, metadata), created = false;
  if (paper?.deletedAt) throw new StoreError("该文献已在回收站，请先恢复已有记录；不会自动恢复或另建副本。", 409, { existingPaperId: paper.id, trashed: true });
  if (!paper) {
    if (!metadata.title?.trim()) throw new StoreError("公开来源没有可核对的标题，请补充 DOI 或论文详情页后重试。", 422);
    try {
      const result = store.dispatch("paper.create", { title: metadata.title, authors: metadata.authors ?? [], year: metadata.year ?? null,
        abstract: metadata.abstract ?? "", sourceUrl: metadata.sourceUrl, doi: metadata.doi ?? "", arxivId: metadata.arxivId ?? "", arxivVersion: metadata.arxivVersion ?? null,
        tags: context.tags.map(tag => tag.name) }) as Paper;
      paper = store.snapshot().papers.find(item => item.id === result.id); created = true;
    } catch (error) {
      const details = error instanceof StoreError ? error.details as { existingPaperId?: string; trashed?: boolean } | undefined : undefined;
      if (!details?.existingPaperId || details.trashed) throw error;
      paper = store.snapshot().papers.find(item => item.id === details.existingPaperId);
    }
  }
  if (!paper || paper.deletedAt) throw new StoreError("无法确认文献档案，请刷新后重试。", 409);
  // Add existing tag IDs; never replace the original labels or other paper fields.
  for (const tag of context.tags) store.dispatch("link.set", { fromType: "paper", fromId: paper.id, toType: "tag", toId: tag.id, purpose: "tag" });
  return { paper, created };
}
