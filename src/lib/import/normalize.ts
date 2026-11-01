import { plainMetadataText } from "./html-metadata";

/**
 * Turn "whatever the share sheet sent" into a fetchable PDF URL.
 *  - arxiv /abs/, /pdf/, versioned IDs → canonical /pdf/ URL + arxiv id
 *  - HTML pages → caller fetches the page and extracts citation_pdf_url
 *  - direct PDFs pass through
 */

export interface NormalizedTarget {
  /** URL expected to serve the PDF (or the page to inspect). */
  url: string;
  /** True when `url` should already be a PDF; false = inspect HTML first. */
  expectsPdf: boolean;
  arxivId: string | null;
}

const ARXIV_RE =
  /^https?:\/\/(?:www\.)?arxiv\.org\/(abs|pdf)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?(?:\.pdf)?\/?$/i;

export function normalizeUrl(input: string): NormalizedTarget {
  let trimmed = input.trim();
  if (/^(?:doi:\s*)?10\.\d{4,9}\/\S+$/i.test(trimmed))
    trimmed = `https://doi.org/${trimmed.replace(/^doi:\s*/i, "")}`;
  else if (/^(?:arxiv:\s*)?(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?$/i.test(trimmed))
    trimmed = `https://arxiv.org/abs/${trimmed.replace(/^arxiv:\s*/i, "")}`;
  const url = new URL(trimmed); // throws on garbage; caller handles
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Only public HTTP(S) sources are supported");

  const arxiv = `${url.origin}${url.pathname}`.match(ARXIV_RE);
  if (arxiv) {
    const id = `${arxiv[2]}${arxiv[3] ?? ""}`;
    return {
      url: `https://arxiv.org/pdf/${id}`,
      expectsPdf: true,
      arxivId: id,
    };
  }

  if (url.pathname.toLowerCase().endsWith(".pdf")) {
    return { url: trimmed, expectsPdf: true, arxivId: null };
  }

  // openreview pdf links use /pdf?id=...
  if ((url.hostname === "openreview.net" || url.hostname.endsWith(".openreview.net")) && url.pathname === "/forum") {
    const id = url.searchParams.get("id");
    if (id) {
      return {
        url: `https://openreview.net/pdf?id=${encodeURIComponent(id)}`,
        expectsPdf: true,
        arxivId: null,
      };
    }
  }

  return { url: trimmed, expectsPdf: false, arxivId: null };
}

/**
 * Find the PDF link inside an HTML page: `citation_pdf_url` meta first
 * (Google Scholar convention), a PDF alternate link, then an unambiguous
 * article download anchor. Supplementary/reference PDFs are never guessed.
 */
export function pdfUrlFromHtml(html: string, baseUrl: string): string | null {
  const clean = html.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, "");
  const head = clean.match(/<head(?:\s[^>]*)?>([\s\S]*?)<\/head>/i)?.[1] ?? clean;
  const attributes = (tag: string) => {
    const values = new Map<string, string>();
    for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g))
      values.set(match[1].toLowerCase(), plainMetadataText(match[2] ?? match[3] ?? match[4]));
    return values;
  };
  const absolute = (value: string) => {
    try {
      const url = new URL(value, baseUrl);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
    } catch {
      return null;
    }
  };
  const unique = (values: string[]) => [...new Set(values.map(absolute).filter((url): url is string => !!url))];
  const meta: string[] = [], alternate: string[] = [], anchors: string[] = [];
  for (const match of head.matchAll(/<(?:meta|link)\b(?:[^"'>]|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = attributes(match[0]);
    if (attrs.get("name")?.toLowerCase() === "citation_pdf_url" && attrs.get("content"))
      meta.push(attrs.get("content")!);
    if (attrs.get("type")?.toLowerCase() === "application/pdf" && /(?:^|\s)alternate(?:\s|$)/i.test(attrs.get("rel") ?? "") && attrs.get("href"))
      alternate.push(attrs.get("href")!);
  }
  for (const candidates of [meta, alternate]) {
    const urls = unique(candidates);
    if (urls.length) return urls.length === 1 ? urls[0] : null;
  }
  for (const match of clean.matchAll(/<a\b((?:[^"'>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = attributes(match[1]);
    const href = attrs.get("href") ?? "";
    const label = `${plainMetadataText(match[2])} ${attrs.get("title") ?? ""} ${attrs.get("aria-label") ?? ""}`;
    const identity = `${href} ${label}`;
    if (/supp(?:lement(?:ary|al)?)?|supporting|appendi[xxces]|附件|补充|参考/i.test(identity)) continue;
    if (/(?:\.pdf(?:[?#]|$)|\/doi\/(?:pdf|epdf|pdfplus)\/|\/pdf(?:[/?#]|$))/i.test(href) &&
        /(?:\bpdf\b|full[ -]?text|download|下载|全文)/i.test(label)) {
      anchors.push(href);
    }
  }
  const urls = unique(anchors);
  return urls.length === 1 ? urls[0] : null;
}
