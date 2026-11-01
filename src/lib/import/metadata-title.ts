/** Conservative title identity check for DOI/arXiv enrichment of a selected PDF. */
export function pdfTitlesAgree(left: string, right: string): boolean {
  const compact = (value: string) =>
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  const a = compact(left);
  const b = compact(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const terms = (value: string) =>
    new Set(
      (
        value
          .normalize("NFKC")
          .toLocaleLowerCase()
          .match(/[\p{L}\p{N}]+/gu) || []
      ).filter(
        (term) =>
          term.length >= 3 &&
          ![
            "the",
            "and",
            "for",
            "with",
            "from",
            "into",
            "are",
            "how",
            "using",
            "research",
            "method",
            "methods",
            "a",
            "an",
            "in",
            "on",
            "of",
            "to",
            "by",
          ].includes(term),
      ),
    );
  const x = terms(left);
  const y = terms(right);
  if (!x.size || !y.size) return false;
  if (
    (a.includes(b) || b.includes(a)) &&
    Math.min(a.length, b.length) >= 12 &&
    Math.min(a.length, b.length) / Math.max(a.length, b.length) >= 0.65
  )
    return true;
  const overlap = [...x].filter((word) => y.has(word)).length;
  if (overlap >= 2 && overlap / Math.max(x.size, y.size) >= 0.7) return true;
  const grams = (value: string) =>
    new Set(
      Array.from({ length: Math.max(0, value.length - 2) }, (_, i) =>
        value.slice(i, i + 3),
      ),
    );
  const gx = grams(a);
  const gy = grams(b);
  const shared = [...gx].filter((part) => gy.has(part)).length;
  return (
    Math.min(a.length, b.length) >= 12 &&
    shared / Math.max(gx.size, gy.size) >= 0.82
  );
}
