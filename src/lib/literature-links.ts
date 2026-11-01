import { doiFromSourceUrl } from "./import/identifiers";

/** A paper-shaped link is an invitation to verify metadata, never proof of identity. */
export function isLiteratureHref(href: string): boolean {
  if (doiFromSourceUrl(href)) return true;
  try {
    const url = new URL(href);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      /^(?:www\.)?arxiv\.org$/i.test(url.hostname) && /^\/(?:abs|pdf)\/(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?(?:\.pdf)?\/?$/i.test(url.pathname);
  } catch { return false; }
}
export function literatureReferenceQuery(text: string): string {
  const trimCitationEnd = (value: string) => {
    let clean = value.replace(/[.,;:]+$/, "");
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    while (pairs[clean.at(-1) ?? ""]) {
      const end = clean.at(-1)!, start = pairs[end];
      if ([...clean].filter(char => char === end).length <= [...clean].filter(char => char === start).length) break;
      clean = clean.slice(0, -1).replace(/[.,;:]+$/, "");
    }
    return clean;
  };
  const doi = text.match(/\b10\.\d{4,9}\/[^\s<>"#]+/i)?.[0];
  if (doi) return trimCitationEnd(doi);
  const arxiv = text.match(/https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/[^\s<>"#]+/i)?.[0];
  const arxivId = text.match(/\barxiv\s*:\s*((?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?)/i)?.[1];
  return arxiv ? trimCitationEnd(arxiv) : arxivId || text.replace(/\s+/g, " ").trim().slice(0, 1000);
}
