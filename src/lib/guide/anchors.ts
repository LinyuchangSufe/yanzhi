/**
 * Exact evidence matching shared by the server validator and PDF text layer.
 * Only typography/spacing introduced by PDF extraction is normalized. No fuzzy
 * matching or model-generated coordinates are used to place an AI highlight.
 */
export interface EvidenceTextIndex {
  text: string;
  starts: number[];
  ends: number[];
}

const ligatures: Record<string, string> = {
  ﬀ: "ff",
  ﬁ: "fi",
  ﬂ: "fl",
  ﬃ: "ffi",
  ﬄ: "ffl",
  ﬅ: "st",
  ﬆ: "st",
};

export function indexEvidenceText(source: string): EvidenceTextIndex {
  const text: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let offset = 0; offset < source.length;) {
    const point = source.codePointAt(offset)!;
    const character = String.fromCodePoint(point);
    const next = offset + character.length;
    // A visible hyphen is ignored only at a real line break within a word.
    // Ordinary hyphens and mathematical minus signs retain their meaning.
    const wrap =
      /[-\u2010]$/.test(character) &&
      offset > 0 &&
      /\p{L}/u.test(source[offset - 1])
        ? source.slice(next).match(/^[ \t]*\r?\n\s*(?=\p{L})/u)
        : null;
    if (wrap) {
      offset = next + wrap[0].length;
      continue;
    }
    if (
      !/\s/u.test(character) &&
      !/[\u00ad\u200b\u2060\ufeff]/u.test(character)
    ) {
      const normalized = ligatures[character] ?? character;
      for (let index = 0; index < normalized.length; index++) {
        text.push(normalized[index]);
        starts.push(offset);
        ends.push(next);
      }
    }
    offset = next;
  }
  return { text: text.join(""), starts, ends };
}

export function normalizeEvidenceText(source: string): string {
  return indexEvidenceText(source).text;
}

export type QuoteMatch =
  | { status: "matched"; start: number; end: number }
  | { status: "missing" | "ambiguous" | "too-short" };

/** Returns offsets in the original source; repeats deliberately fail closed. */
export function findUniqueQuote(
  source: string,
  quote: string,
  minimumLength = 20,
): QuoteMatch {
  const needle = normalizeEvidenceText(quote);
  if (needle.length < minimumLength) return { status: "too-short" };
  const index = indexEvidenceText(source);
  const start = index.text.indexOf(needle);
  if (start < 0) return { status: "missing" };
  if (index.text.indexOf(needle, start + 1) >= 0)
    return { status: "ambiguous" };
  return {
    status: "matched",
    start: index.starts[start],
    end: index.ends[start + needle.length - 1],
  };
}

export interface EvidenceTextRun {
  text: string;
  /** PDF.js marks line endings explicitly, including spaces absent from spans. */
  hasEOL?: boolean;
}

/** A deterministic page string for PDF.js text items and server-side blocks. */
export function joinEvidenceTextRuns(runs: readonly EvidenceTextRun[]): string {
  return runs.map((run) => `${run.text}${run.hasEOL ? "\n" : " "}`).join("");
}
