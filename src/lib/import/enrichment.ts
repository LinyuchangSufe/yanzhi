import { z } from "zod";
import { StoreError } from "../store-error";
import { fetchPublicUrl, type FetchedPublicResponse } from "./download";
import { readBoundedResponse } from "./bounded-response";
import { doiFromSourceUrl } from "./identifiers";
import { plainMetadataText as plain } from "./html-metadata";
import { parseEnrichmentHtml } from "./enrichment-html";
import { pdfTitlesAgree } from "./metadata-title";
import { resolveMetadata, type Metadata } from "./metadata";
import type { MetadataCandidate, MetadataField, MetadataLookupResult, MetadataProvenance } from "./enrichment-types";

export const metadataLookupSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("search"), title: z.string().trim().min(2).max(1000) }).strict(),
  z.object({ action: z.literal("detail"), source: z.string().trim().min(1).max(4000), title: z.string().trim().min(2).max(1000).optional() }).strict(),
]);
export type MetadataLookupInput = z.infer<typeof metadataLookupSchema>;
type PublicFetcher = (url: string, signal?: AbortSignal) => Promise<FetchedPublicResponse>;
const dateSchema = z.object({ "date-parts": z.array(z.array(z.number())) });
const workSchema = z.object({
  DOI: z.string(), title: z.array(z.string()).min(1),
  author: z.array(z.object({ given: z.string().optional(), family: z.string().optional(), name: z.string().optional() })).optional(),
  published: dateSchema.optional(), "published-online": dateSchema.optional(), "published-print": dateSchema.optional(),
  abstract: z.string().optional(), resource: z.object({ primary: z.object({ URL: z.string() }).optional() }).optional(),
  "container-title": z.array(z.string()).optional(), publisher: z.string().optional(), type: z.string().optional(),
});
type Work = z.infer<typeof workSchema>;
const ALL_FIELDS: MetadataField[] = ["title", "authors", "year", "doi", "arxivId", "abstract", "sourceUrl"];
function presentFields(metadata: Metadata): MetadataField[] {
  return ALL_FIELDS.filter((field) => {
    const value = metadata[field];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== "";
  });
}
function normalizeDoi(value: string): string {
  const doi = value.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "").toLowerCase();
  return /^10\.\d{4,9}\/[^\s?#]+$/.test(doi) ? doi : "";
}
function safeWebUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}
function titleMatch(query: string | undefined, title: string | undefined): MetadataCandidate["match"] {
  if (!query || !title) return "unknown";
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (normalize(query) === normalize(title)) return "exact";
  return pdfTitlesAgree(query, title) ? "similar" : "different";
}
function makeCandidate(metadata: Metadata, query: string | undefined, provenance: MetadataProvenance[]): MetadataCandidate {
  const match = titleMatch(query, metadata.title);
  return { id: metadata.doi || metadata.arxivId || metadata.sourceUrl, metadata, match, provenance, warnings: [
    ...(match === "different" ? ["题名与当前记录不一致，请先核对论文身份与版本。"] : []),
    ...(!metadata.abstract ? ["此来源未提供可核验的原文摘要。"] : []),
  ] };
}
function publicationInfo(work: Work) {
  const publication = plain(work["container-title"]?.[0] || work.publisher || "");
  const workType = work.type?.trim();
  return { ...(publication ? { publication } : {}), ...(workType ? { workType } : {}) };
}
function fromWork(work: Work, source?: string): Metadata {
  const doi = normalizeDoi(work.DOI);
  if (!doi) throw new StoreError("公开元数据中的 DOI 无效", 422);
  const title = plain(work.title[0]);
  if (!title) throw new StoreError("公开元数据缺少题名", 422);
  const authors = work.author?.map((author) => plain([author.given, author.family].filter(Boolean).join(" ") || author.name || "")).filter(Boolean);
  const year = (work.published ?? work["published-online"] ?? work["published-print"])?.["date-parts"]?.[0]?.[0];
  const abstract = work.abstract ? plain(work.abstract) : undefined;
  return { title, doi, sourceUrl: source || safeWebUrl(work.resource?.primary?.URL || "") || `https://doi.org/${doi}`,
    ...(authors?.length ? { authors } : {}),
    ...(Number.isInteger(year) && year! >= 1000 && year! <= 2200 ? { year } : {}),
    ...(abstract ? { abstract } : {}),
  };
}

/** Public bibliographic lookup only. No store writes, AI calls, PDF or note reads. */
export async function lookupMetadata(input: MetadataLookupInput, fetcher: PublicFetcher = fetchPublicUrl, signal?: AbortSignal): Promise<MetadataLookupResult> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
  const warnings: string[] = [];
  async function read(address: string) {
    requestSignal.throwIfAborted();
    const timeout = AbortSignal.any([requestSignal, AbortSignal.timeout(15000)]);
    const result = await fetcher(address, timeout);
    if (!result.response.ok) {
      await result.response.body?.cancel(); await result.close();
      throw new StoreError(`公开来源返回 HTTP ${result.response.status}，请稍后重试或打开来源核对`, result.response.status === 429 ? 429 : 422);
    }
    const bytes = await readBoundedResponse(result.response, 2 * 1024 * 1024, result.close);
    requestSignal.throwIfAborted();
    return { text: bytes.toString("utf8"), url: result.url };
  }
  async function crossref(doi: string) {
    const endpoint = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
    const { text } = await read(endpoint);
    const work = workSchema.parse(z.object({ message: workSchema }).parse(JSON.parse(text)).message);
    if (normalizeDoi(work.DOI) !== doi) throw new StoreError("公开来源返回了不同 DOI，已停止合并", 422);
    return { work, endpoint };
  }
  async function page(address: string) {
    const parsed = new URL(address);
    if (/\.pdf$/i.test(parsed.pathname) || /\/doi\/(?:pdf|epdf|pdfplus)\//i.test(parsed.pathname))
      throw new StoreError("PDF 链接只用于核对标识；请上传 PDF 或提供论文详情页", 422);
    const { text, url } = await read(address);
    return { ...parseEnrichmentHtml(text), url };
  }
  async function fromDoi(doi: string, source?: string, query?: string): Promise<MetadataCandidate> {
    const { work, endpoint } = await crossref(doi);
    const metadata = fromWork(work, source);
    const provenance: MetadataProvenance[] = [{ label: "Crossref DOI 注册元数据", url: endpoint, fields: presentFields(metadata) }];
    if (!metadata.abstract) {
      const publisherUrl = safeWebUrl(work.resource?.primary?.URL || "") || source || metadata.sourceUrl;
      try {
        const publisher = await page(publisherUrl);
        // A matching explicit DOI is mandatory when supplementing a DOI record.
        // Same/similar titles can identify different preprint or journal versions.
        if (publisher.metadata.doi !== doi || !publisher.metadata.title || !pdfTitlesAgree(metadata.title!, publisher.metadata.title))
          throw new StoreError("出版商页面的论文标识或题名无法核对，已保留 DOI 元数据", 422);
        const added: MetadataField[] = [];
        for (const field of ["authors", "year", "abstract"] as const) {
          if (metadata[field] !== undefined || publisher.metadata[field] === undefined) continue;
          if (field === "authors") metadata.authors = publisher.metadata.authors;
          if (field === "year") metadata.year = publisher.metadata.year;
          if (field === "abstract") metadata.abstract = publisher.metadata.abstract;
          added.push(field);
        }
        if (added.length) provenance.push({ label: publisher.abstractLabel || "出版商公开元数据", url: publisher.url, fields: added });
      } catch (error) {
        requestSignal.throwIfAborted();
        warnings.push(error instanceof StoreError ? error.message : "出版商公开详情暂时无法读取，已保留 DOI 元数据。");
      }
    }
    return { ...makeCandidate(metadata, query, provenance), ...publicationInfo(work) };
  }

  try {
    if (input.action === "search") {
      const endpoint = new URL("https://api.crossref.org/works");
      endpoint.searchParams.set("query.title", input.title);
      endpoint.searchParams.set("rows", "5");
      endpoint.searchParams.set("select", "DOI,title,author,published,published-online,published-print,abstract,resource,container-title,publisher,type");
      const { text } = await read(endpoint.toString());
      const result = z.object({ message: z.object({ items: z.array(z.unknown()) }) }).parse(JSON.parse(text));
      const candidates: MetadataCandidate[] = [];
      const seen = new Set<string>();
      for (const item of result.message.items.slice(0, 5)) {
        const parsed = workSchema.safeParse(item);
        if (!parsed.success) continue;
        try {
          const metadata = fromWork(parsed.data);
          if (seen.has(metadata.doi!)) continue;
          seen.add(metadata.doi!);
          candidates.push({ ...makeCandidate(metadata, input.title, [{ label: "Crossref 题名检索", url: `https://api.crossref.org/works/${encodeURIComponent(metadata.doi!)}`, fields: presentFields(metadata) }]), ...publicationInfo(parsed.data) });
        } catch { /* A malformed public record does not invalidate other candidates. */ }
      }
      if (!candidates.length) warnings.push("未找到可用候选。可修改题名，或粘贴 DOI、期刊详情页后重试。");
      return { candidates, warnings, queriedAt: new Date().toISOString() };
    }

    const raw = input.source.trim();
    const doi = normalizeDoi(raw) || doiFromSourceUrl(raw);
    if (doi) {
      const candidate = await fromDoi(doi, safeWebUrl(raw), input.title);
      return { candidates: [candidate], warnings, queriedAt: new Date().toISOString() };
    }
    const arxiv = /^(?:arxiv:\s*)?(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?$/i.test(raw) || /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i.test(raw);
    if (arxiv) {
      const result = await resolveMetadata(raw, (address) => fetcher(address, requestSignal));
      requestSignal.throwIfAborted();
      warnings.push(...result.warnings);
      return { candidates: result.metadata.title ? [makeCandidate(result.metadata, input.title, [{ label: "arXiv 公开元数据", url: result.metadata.sourceUrl, fields: presentFields(result.metadata) }])] : [], warnings, queriedAt: new Date().toISOString() };
    }
    const address = safeWebUrl(raw);
    if (!address) throw new StoreError("请填写 HTTP/HTTPS 论文详情页、DOI 或 arXiv 标识", 400);
    const publisher = await page(address);
    if (!publisher.metadata.title) throw new StoreError("此页面未提供可核验的论文元数据，请填写 DOI 或用题名检索", 422);
    if (publisher.metadata.doi) {
      try {
        const { work, endpoint } = await crossref(publisher.metadata.doi);
        const metadata = fromWork(work, address);
        if (!pdfTitlesAgree(metadata.title!, publisher.metadata.title)) throw new StoreError("网页与 DOI 题名不一致，已停止合并", 422);
        const provenance: MetadataProvenance[] = [{ label: "Crossref DOI 注册元数据", url: endpoint, fields: presentFields(metadata) }];
        const added: MetadataField[] = [];
        for (const field of ["authors", "year", "abstract"] as const) {
          if (metadata[field] !== undefined || publisher.metadata[field] === undefined) continue;
          if (field === "authors") metadata.authors = publisher.metadata.authors;
          if (field === "year") metadata.year = publisher.metadata.year;
          if (field === "abstract") metadata.abstract = publisher.metadata.abstract;
          added.push(field);
        }
        if (added.length) provenance.push({ label: publisher.abstractLabel || "出版商公开元数据", url: publisher.url, fields: added });
        return { candidates: [{ ...makeCandidate(metadata, input.title, provenance), ...publicationInfo(work) }], warnings, queriedAt: new Date().toISOString() };
      } catch (error) {
        requestSignal.throwIfAborted();
        if (error instanceof StoreError && /不一致|不同 DOI/.test(error.message)) throw error;
        warnings.push("DOI 注册元数据暂时不可用，已返回出版商的公开字段，请核对后再采用。");
      }
    }
    const metadata = { ...publisher.metadata, sourceUrl: address };
    return { candidates: [makeCandidate(metadata, input.title, [{ label: publisher.abstractLabel || "出版商公开元数据", url: publisher.url, fields: presentFields(metadata) }])], warnings, queriedAt: new Date().toISOString() };
  } catch (error) {
    if (signal?.aborted) throw new StoreError("已取消联网查询，未修改本地内容", 499);
    if (requestSignal.aborted) throw new StoreError("联网查询超时，未修改本地内容，请稍后重试", 504);
    if (error instanceof StoreError) throw error;
    throw new StoreError("公开元数据暂时无法读取，请稍后重试或打开来源核对；本地内容未修改", 422);
  }
}
