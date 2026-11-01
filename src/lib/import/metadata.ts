import { z } from "zod";
import { normalizeIdentifiers, StoreError, getStore, type KBStore } from "../db";
import { fetchPublicUrl, downloadPdf, type DownloadOptions, type FetchedPublicResponse } from "./download";
import { normalizeUrl } from "./normalize";
import { readBoundedResponse } from "./bounded-response";
import { parseHtmlMetadata, plainMetadataText as plain } from "./html-metadata";

export interface Metadata {
  title?: string;
  authors?: string[];
  year?: number;
  abstract?: string;
  sourceUrl: string;
  doi?: string;
  arxivId?: string;
  arxivVersion?: number | null;
}
type PublicFetcher = (url: string, signal?: AbortSignal) => Promise<FetchedPublicResponse>;
const crossrefSchema = z.object({message: z.object({
  DOI: z.string(),
  title: z.array(z.string()).min(1),
  author: z.array(z.object({given: z.string().optional(), family: z.string().optional(), name: z.string().optional()})).optional(),
  published: z.object({"date-parts": z.array(z.array(z.number()))}).optional(),
  "published-online": z.object({"date-parts": z.array(z.array(z.number()))}).optional(),
  "published-print": z.object({"date-parts": z.array(z.array(z.number()))}).optional(),
  abstract: z.string().optional(),
})});
function tag(xml: string, name: string) {
  return plain(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] || "");
}

export async function resolveMetadata(source: string, fetcher: PublicFetcher = fetchPublicUrl): Promise<{metadata: Metadata; warnings: string[]}> {
  const input = source.trim();
  let sourceUrl = input;
  if (/^(?:doi:\s*)?10\.\d{4,9}\//i.test(input)) sourceUrl = `https://doi.org/${input.replace(/^doi:\s*/i, "")}`;
  else if (/^(?:arxiv:\s*)?(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?$/i.test(input)) sourceUrl = `https://arxiv.org/abs/${input.replace(/^arxiv:\s*/i, "")}`;
  let url: URL;
  try { url = new URL(sourceUrl); }
  catch { throw new StoreError("请填写 HTTP/HTTPS URL、DOI 或 arXiv 标识", 400); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new StoreError("来源地址格式无效", 400);
  const ids = normalizeIdentifiers({sourceUrl});
  const metadata: Metadata = {sourceUrl, ...ids};
  const warnings: string[] = [];
  async function publicText(address: string) {
    const result = await fetcher(address, AbortSignal.timeout(15000));
    if (!result.response.ok) {
      await result.response.body?.cancel();
      await result.close();
      throw new StoreError(`源站返回 HTTP ${result.response.status}`, 422);
    }
    const bytes = await readBoundedResponse(result.response, 2 * 1024 * 1024, result.close);
    return bytes.toString("utf8");
  }
  async function crossref(doi: string) {
    const {message} = crossrefSchema.parse(JSON.parse(await publicText(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)));
    if (normalizeIdentifiers({doi: message.DOI}).doi !== doi) throw new Error("Crossref DOI mismatch");
    const title = plain(message.title[0]);
    if (!title) throw new Error("Crossref title missing");
    const authors = message.author?.map((author) => plain([author.given, author.family].filter(Boolean).join(" ") || author.name || "")).filter(Boolean);
    const year = (message.published ?? message["published-online"] ?? message["published-print"])?.["date-parts"]?.[0]?.[0];
    return {
      title,
      ...(authors?.length ? {authors} : {}),
      ...(Number.isInteger(year) && year! >= 1000 && year! <= 2200 ? {year} : {}),
      ...(message.abstract ? {abstract: plain(message.abstract)} : {}),
    };
  }
  if (ids.arxivId) {
    try {
      const xml = await publicText(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(ids.arxivId + (ids.arxivVersion ? `v${ids.arxivVersion}` : ""))}`);
      const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
      if (!entry || !tag(entry, "title")) throw new Error("no entry");
      metadata.title = tag(entry, "title");
      metadata.abstract = tag(entry, "summary");
      metadata.authors = [...entry.matchAll(/<author>([\s\S]*?)<\/author>/g)].map((author) => tag(author[1], "name")).filter(Boolean);
      metadata.year = Number(tag(entry, "published").slice(0, 4)) || undefined;
    } catch {
      warnings.push("arXiv 元数据暂时读取失败。来源已保留，可手工填写或稍后重试。");
    }
    return {metadata, warnings};
  }
  if (ids.doi) {
    try {
      Object.assign(metadata, await crossref(ids.doi));
      return {metadata, warnings};
    } catch { /* Publisher citation metadata can still be available. */ }
  }
  try {
    if (/\.pdf$/i.test(url.pathname) || /\/doi\/(?:pdf|epdf|pdfplus)\//i.test(url.pathname))
      throw new Error("PDF needs local inspection");
    const page = parseHtmlMetadata(await publicText(sourceUrl));
    if (!page.title || (ids.doi && page.doi && page.doi !== ids.doi)) throw new Error("Page metadata missing or DOI mismatch");
    Object.assign(metadata, page);
    if (ids.doi) warnings.push("DOI 公开元数据暂不可用；已读取期刊页面中的可用字段，请核对后保存。");
    else if (page.doi) {
      try { Object.assign(metadata, await crossref(page.doi)); }
      catch { warnings.push("已读取网页元数据；DOI 公开元数据暂不可用，请核对后保存。"); }
    }
  } catch {
    warnings.push("元数据暂时读取失败，期刊网站可能限制自动访问或未提供公开信息。来源与已识别的 DOI 已保留，可手工填写标题后收藏；全文 PDF 需自行上传或从有权访问的来源补充。");
  }
  return {metadata, warnings};
}

export async function attachFromSource(
  paperId: string,
  source: string,
  options: Pick<DownloadOptions, "fetcher" | "signal"> & { store?: KBStore } = {},
) {
  const store = options.store ?? getStore();
  const paper = store.snapshot().papers.find((item) => item.id === paperId);
  if (!paper) throw new StoreError("文献不存在或已移除", 404);
  if (paper.deletedAt) throw new StoreError("文献已在回收站，请先恢复后添加 PDF。", 409);
  let target: string;
  try { target = normalizeUrl(source).url; }
  catch { throw new StoreError("请提供有效的来源链接、DOI 或 arXiv 标识", 400); }
  const identifiers = normalizeIdentifiers({ sourceUrl: target });
  if ((paper.doi && identifiers.doi && paper.doi !== identifiers.doi) ||
      (paper.arxivId && identifiers.arxivId && paper.arxivId !== identifiers.arxivId))
    throw new StoreError("来源标识与当前文献不一致，请先核对后重试。", 409);
  const downloaded = await downloadPdf(target, {
    ...options,
    expectedDoi: paper.doi,
    expectedTitle: paper.title,
  });
  if (options.signal?.aborted) throw new StoreError("已取消获取 PDF，原附件保持不变。", 499);
  const current = store.snapshot().papers.find((item) => item.id === paperId);
  if (!current || current.deletedAt || current.revision !== paper.revision)
    throw new StoreError("下载期间文献信息已变化，未写入附件。请核对当前记录后重试。", 409);
  return store.addAttachment(paperId, "source.pdf", downloaded.bytes);
}
