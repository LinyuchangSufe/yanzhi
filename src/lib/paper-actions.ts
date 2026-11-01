import type { Paper } from "./types";

/** Links are user-visible and may also be sent to the protected server downloader. */
export function paperSource(paper: Pick<Paper, "sourceUrl" | "doi" | "arxivId"> & Partial<Pick<Paper, "arxivVersion">>): string {
  try {
    const source = new URL(paper.sourceUrl);
    if (["http:", "https:"].includes(source.protocol) && !source.username && !source.password)
      return source.href;
  } catch {}
  const doi = paper.doi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  if (/^10\.\d{4,9}\/\S+$/i.test(doi))
    return `https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}`;
  const arxivId = paper.arxivId.trim();
  if (/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i.test(arxivId)) {
    const version = paper.arxivVersion;
    const suffix = !/v\d+$/i.test(arxivId) && Number.isInteger(version) && Number(version) > 0 ? `v${version}` : "";
    return `https://arxiv.org/abs/${arxivId}${suffix}`;
  }
  return "";
}
