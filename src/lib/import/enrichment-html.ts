import { parseHtmlMetadata, plainMetadataText as plain } from "./html-metadata";

/** Only an explicitly identified abstract, never an SEO description or preview. */
export function parseEnrichmentHtml(html: string) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, "");
  const head = clean.match(/<head(?:\s[^>]*)?>([\s\S]*?)<\/head>/i)?.[1] ?? clean;
  const meta = parseHtmlMetadata(head.replace(/<meta\b(?:[^"'>]|"[^"]*"|'[^']*')*>/gi, (tag) =>
    /\b(?:name|property)\s*=\s*["']?(?:description|og:description|dc\.description)["'\s>]/i.test(tag) ? "" : tag));
  delete meta.abstract;
  const citation = parseHtmlMetadata(head.replace(/<meta\b(?:[^"'>]|"[^"]*"|'[^']*')*>/gi, (tag) =>
    /\b(?:name|property)\s*=\s*["']?citation_abstract["'\s>]/i.test(tag) ? tag : ""));
  if (citation.abstract) return { metadata: { ...meta, abstract: citation.abstract }, abstractLabel: "出版商 citation_abstract" };

  // Springer Nature's article-level Abstract section. Keep this adapter narrow:
  // reference abstracts, dialogs and arbitrary descriptions are not evidence.
  for (const section of clean.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/gi)) {
    const attributes = section[1];
    const content = section[2];
    const abstractSection = /\bdata-title\s*=\s*["']Abstract["']/i.test(attributes) ||
      /\baria-labelledby\s*=\s*["']Abs1["']/i.test(attributes);
    if (!abstractSection || !/<h[1-6]\b[^>]*>\s*Abstract\s*<\/h[1-6]>/i.test(content)) continue;
    const paragraphs = [...content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((match) => plain(match[1])).filter(Boolean);
    const abstract = paragraphs.join("\n\n");
    if (abstract.length >= 30 && abstract.length <= 30000)
      return { metadata: { ...meta, abstract }, abstractLabel: "出版商 Abstract 段" };
  }
  return { metadata: meta, abstractLabel: undefined };
}
