const entities: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", ensp: " ", emsp: " ", thinsp: " ",
};

export function plainMetadataText(value: string): string {
  return value
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? match;
      const code = entity[1].toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

export interface HtmlMetadata {
  title?: string;
  authors?: string[];
  year?: number;
  abstract?: string;
  doi?: string;
}

export function parseHtmlMetadata(html: string): HtmlMetadata {
  // Only the document's own metadata; embedded examples/reference fragments and
  // commented or scripted meta tags must not identify another paper.
  const documentHead = html.match(/<head(?:\s[^>]*)?>([\s\S]*?)<\/head>/i)?.[1] ?? html;
  const metadataHtml = documentHead
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, "");
  const values = new Map<string, string[]>();
  for (const match of metadataHtml.matchAll(/<meta\b(?:[^"'>]|"[^"]*"|'[^']*')*>/gi)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[0].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g))
      attributes.set(attribute[1].toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4]);
    const name = (attributes.get("name") || attributes.get("property"))?.toLowerCase();
    const content = attributes.get("content");
    if (!name || content === undefined) continue;
    const text = plainMetadataText(content);
    if (text) values.set(name, [...(values.get(name) ?? []), text]);
  }
  const first = (...names: string[]) => names.map((name) => values.get(name)?.[0]).find(Boolean);
  const title = first("citation_title", "dc.title", "og:title") ||
    plainMetadataText(metadataHtml.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i)?.[1] || "");
  // Bot challenges and access gates must never become the paper title.
  if (/^(?:just a moment|attention required|access denied|robot check|security check|checking your browser|enable javascript)(?:\b|[.!…])/i.test(title))
    return {};
  const authors = [...new Set(values.get("citation_author") ?? values.get("dc.creator") ?? [])];
  const date = first("citation_publication_date", "citation_date", "prism.publicationdate", "dc.date", "article:published_time");
  const year = date?.match(/^(\d{4})(?:\b|[./])/i)?.[1];
  const doiValues = [...new Set((values.get("citation_doi") ?? values.get("dc.identifier") ?? [])
    .map((value) => value.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "").toLowerCase())
    .filter((value) => /^10\.\d{4,9}\/\S+$/.test(value)))];
  return {
    ...(title ? {title} : {}),
    ...(authors.length ? {authors} : {}),
    ...(year && Number(year) >= 1000 && Number(year) <= 2200 ? {year: Number(year)} : {}),
    ...(first("citation_abstract", "dc.description", "description", "og:description")
      ? {abstract: first("citation_abstract", "dc.description", "description", "og:description")} : {}),
    ...(doiValues.length === 1 ? {doi: doiValues[0]} : {}),
  };
}
