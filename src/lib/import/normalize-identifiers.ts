import { doiFromSourceUrl } from "./identifiers";
import { StoreError } from "../store-error";

export function normalizeIdentifiers(input: {
  doi?: string;
  arxivId?: string;
  arxivVersion?: number | null;
  sourceUrl?: string;
}) {
  const source = input.sourceUrl?.trim() ?? "";
  let doi = (input.doi ?? "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
  let arxiv = (input.arxivId ?? "")
    .trim()
    .replace(/^arxiv:\s*/i, "")
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "");
  if (!doi) doi = doiFromSourceUrl(source);
  if (!arxiv && /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i.test(source))
    arxiv = source
      .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
      .split(/[?#]/)[0]
      .replace(/\.pdf$/i, "");
  let arxivVersion = input.arxivVersion ?? null;
  const version = arxiv.match(/v(\d+)$/i);
  if (version) {
    arxivVersion = Number(version[1]);
    arxiv = arxiv.slice(0, version.index);
  }
  arxiv = arxiv.toLowerCase();
  if (doi && !/^10\.\d{4,9}\/\S+$/i.test(doi))
    throw new StoreError("DOI 格式无效");
  if (arxiv && !/^(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})$/.test(arxiv))
    throw new StoreError("arXiv 标识格式无效");
  return { doi, arxivId: arxiv, arxivVersion };
}
