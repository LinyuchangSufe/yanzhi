// Adapts Papernook's MIT bibliography scan and destination/caption resolver.
// Copyright (c) 2026 Andres Romero. See LICENSE and docs/UPSTREAM.md.
import type { PDFDocumentProxy } from "pdfjs-dist";
import { buildBibliography, type Bibliography, type BibliographyPage } from "./bibliography";
import { captionPattern, destinationCandidates, findPaperRefs, type PaperRef } from "./paper-refs";
import { resolvePdfDestination, type ResolvedPdfDestination } from "./destinations";
import { pdfTextChunks, pdfTextItems } from "./text-items";
import { equationCandidates } from "./equation-locator";
import { headingCandidates } from "./heading-locator";

export type ReferenceLocator = Pick<PaperRef, "kind" | "label">;
export type ReferencePageCache = Map<number, Promise<BibliographyPage>>;
export const MAX_LOCATOR_PAGES = 250;

/** In-memory text only; no PDF copies, AI calls, database or filesystem cache. */
export function referencePage(
  document: PDFDocumentProxy,
  pageNumber: number,
  cache: ReferencePageCache,
): Promise<BibliographyPage> {
  let page = cache.get(pageNumber);
  if (!page) {
    page = (async () => {
      const pdfPage = await document.getPage(pageNumber);
      const chunks = pdfTextChunks(await pdfTextItems(pdfPage));
      return { pageNumber, pageWidth: pdfPage.view[2] - pdfPage.view[0], chunks };
    })();
    cache.set(pageNumber, page);
    void page.catch(() => cache.delete(pageNumber));
  }
  return page;
}

/** Scan the trailing 100 pages, as upstream does; never infer missing entries. */
export async function scanBibliography(
  document: PDFDocumentProxy,
  cache: ReferencePageCache,
  cancelled: () => boolean = () => false,
): Promise<Bibliography | null> {
  const pages: BibliographyPage[] = [];
  for (let number = Math.max(1, document.numPages - 99); number <= document.numPages; number++) {
    if (cancelled()) return null;
    pages.push(await referencePage(document, number, cache));
  }
  return cancelled() ? null : buildBibliography(pages);
}

export interface ReferenceCandidate {
  target: ResolvedPdfDestination;
  text: string;
  source: "outline" | "heading" | "caption" | "equation";
  confidence: "high" | "candidate";
}
export interface ReferenceResult {
  target: ResolvedPdfDestination | null;
  reason?: string;
  candidates?: ReferenceCandidate[];
}

const outlines = new WeakMap<PDFDocumentProxy, Promise<unknown>>();
const MAX_CANDIDATES = 40;

/** Real outline destinations also work when their anchor names are custom. */
async function outlineCandidates(document: PDFDocumentProxy, ref: ReferenceLocator, cancelled: () => boolean): Promise<{entries: ReferenceCandidate[]; incomplete: boolean}> {
  let pending = outlines.get(document);
  if (!pending) {
    pending = Promise.resolve().then(() => document.getOutline()).catch(() => { outlines.delete(document); return []; });
    outlines.set(document, pending);
  }
  const entries = await pending;
  const pattern = captionPattern(ref);
  const found: ReferenceCandidate[] = [];
  let inspected = 0;
  let incomplete = false;
  async function walk(items: unknown, depth: number) {
    if (!Array.isArray(items)) return;
    if (depth > 20) { if (items.length) incomplete = true; return; }
    for (const entry of items) {
      if (cancelled()) return;
      if (++inspected > 5000) { incomplete = true; return; }
      if (!entry || typeof entry !== "object") continue;
      const item = entry as {title?: unknown; dest?: unknown; items?: unknown};
      const title = typeof item.title === "string" ? item.title.replace(/\s+/g, " ").trim() : "";
      const matches = (pattern?.test(title) ?? false) || findPaperRefs(title).some((match) =>
        match.start === 0 && match.kind === ref.kind && match.label === ref.label &&
        !/^[\p{L}\d]|^\.\d/u.test(title.slice(match.end)));
      if (matches && (typeof item.dest === "string" || Array.isArray(item.dest))) {
        const target = await resolvePdfDestination(document, item.dest);
        if (target) found.push({target, text: title.slice(0, 240), source: "outline", confidence: "high"});
      }
      await walk(item.items, depth + 1);
    }
  }
  await walk(entries, 0);
  return {entries: uniqueCandidates(found), incomplete};
}

function uniqueCandidates(entries: ReferenceCandidate[]): ReferenceCandidate[] {
  const found: ReferenceCandidate[] = [];
  for (const entry of entries) {
    const duplicate = found.find((other) => other.target.pageNumber === entry.target.pageNumber &&
      (other.target.top !== null && entry.target.top !== null
        ? Math.abs(other.target.top - entry.target.top) < 4 && Math.abs((other.target.left ?? 0) - (entry.target.left ?? 0)) < 4
        : other.text === entry.text && other.target.top === entry.target.top));
    if (!duplicate) found.push(entry);
    else if (entry.confidence === "high") duplicate.confidence = "high";
  }
  return found;
}

function chooseCandidate(entries: ReferenceCandidate[], incomplete = false): ReferenceResult {
  const candidates = uniqueCandidates(entries);
  const high = candidates.filter((entry) => entry.confidence === "high");
  if (!incomplete && candidates.length === 1 && high.length === 1) return {target: high[0].target};
  const shown = [...high, ...candidates.filter((entry) => entry.confidence !== "high")].slice(0, MAX_CANDIDATES);
  const reason = incomplete ? "定位扫描范围有限，请核对下列候选位置后跳转。"
    : candidates.length > 1 ? "找到多处可能的位置，请选择候选并核对原文预览。"
    : "找到可能的位置，请核对原文预览后跳转。";
  return {target: null, candidates: shown, reason: reason + (candidates.length > MAX_CANDIDATES ? `已显示前 ${MAX_CANDIDATES} 处。` : "")};
}

/** Use original anchors/outlines first, then layout-aware text with explicit ambiguity choices. */
export async function locatePdfReference(
  document: PDFDocumentProxy,
  ref: ReferenceLocator,
  cache: ReferencePageCache,
  cancelled: () => boolean = () => false,
): Promise<ReferenceResult> {
  for (const candidate of destinationCandidates(ref)) {
    if (cancelled()) return { target: null };
    const target = await resolvePdfDestination(document, candidate);
    if (cancelled()) return { target: null };
    if (target) return { target };
  }
  const outline = await outlineCandidates(document, ref, cancelled);
  if (cancelled()) return {target: null};
  if (outline.entries.length) return chooseCandidate(outline.entries, outline.incomplete);
  const matches: ReferenceCandidate[] = [];
  let incomplete = outline.incomplete || document.numPages > MAX_LOCATOR_PAGES;
  for (let number = 1; number <= Math.min(document.numPages, MAX_LOCATOR_PAGES); number++) {
    if (cancelled()) return { target: null };
    const page = await referencePage(document, number, cache);
    const entries = ref.kind === "equation" ? equationCandidates(page, ref.label) : headingCandidates(page, ref);
    matches.push(...entries.map((entry): ReferenceCandidate => ({...entry,
      source: ref.kind === "equation" ? "equation" : ref.kind === "section" || ref.kind === "appendix" ? "heading" : "caption"})));
    if (matches.length > 500) { incomplete = true; break; }
  }
  if (cancelled()) return {target: null};
  if (matches.length) return chooseCandidate(matches, incomplete);
  return {target: null, reason: incomplete
    ? `前 ${MAX_LOCATOR_PAGES} 页未找到可识别的定位信息，请通过目录或物理页码查找。`
    : ref.kind === "equation" ? "未找到可识别的公式编号及页面位置；扫描件、公式图片或特殊排版可能需要手动按页码查找。阅读位置已保留。"
    : "当前 PDF 未找到可识别的标题或图表说明，可能是扫描件、特殊排版或编号不同。阅读位置已保留。"};
}
