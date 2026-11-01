import type { BibliographyPage, PdfTextChunk } from "./bibliography";
import type { ResolvedPdfDestination } from "./destinations";
import type { PaperRef } from "./paper-refs";

export interface HeadingCandidate {
  target: ResolvedPdfDestination;
  text: string;
  confidence: "high" | "candidate";
}

interface Line {
  text: string;
  x: number;
  y: number;
  right: number;
  chunks: PdfTextChunk[];
}

interface Layout {
  lines: Line[];
  bodyHeight: number | null;
  bodyFont: string | null;
  pitch: number;
}

const CAPTION_WORDS: Partial<Record<PaperRef["kind"], string>> = {
  figure: "Figure|Fig\\.?|图",
  table: "Table|Tab\\.?|表",
  algorithm: "Algorithm|Alg\\.?|算法",
  theorem: "Theorem|Thm\\.?|定理",
  lemma: "Lemma|Lem\\.?|引理",
  proposition: "Proposition|Prop\\.?|命题",
  definition: "Definition|Defn?\\.?|定义",
  corollary: "Corollary|Cor\\.?|推论",
};
const layouts = new WeakMap<BibliographyPage, Layout>();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function dominantFont(chunks: PdfTextChunk[]): string | null {
  const counts = new Map<string, number>();
  for (const chunk of chunks) {
    if (chunk.fontName) counts.set(chunk.fontName, (counts.get(chunk.fontName) ?? 0) + letters(chunk.str));
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function right(chunk: PdfTextChunk, height: number): number {
  return chunk.x + (typeof chunk.width === "number" && chunk.width >= 0
    ? chunk.width : chunk.str.length * height * 0.48);
}

/** Keep geometry intact: duplicate OCR layers must not invent extra captions. */
function uniqueChunks(chunks: PdfTextChunk[]): PdfTextChunk[] {
  const visible = chunks.filter((chunk) => chunk.str.trim() && Number.isFinite(chunk.x) && Number.isFinite(chunk.y));
  const result: PdfTextChunk[] = [];
  for (const chunk of visible.sort((a, b) => b.y - a.y || a.x - b.x)) {
    if (!result.some((other) => Math.abs(other.y - chunk.y) < 0.8
      && Math.abs(other.x - chunk.x) < 0.8 && other.str.trim() === chunk.str.trim())) result.push(chunk);
  }
  return result;
}

function layout(page: BibliographyPage): Layout {
  const cached = layouts.get(page);
  if (cached) return cached;
  const chunks = uniqueChunks(page.chunks);
  const weightedHeights = chunks.flatMap((chunk) => typeof chunk.height === "number" && chunk.height > 0 && letters(chunk.str) > 2
    ? Array<number>(Math.min(100, letters(chunk.str))).fill(chunk.height) : []);
  const bodyHeight = median(weightedHeights);
  const unit = bodyHeight ?? 10;
  const rows: PdfTextChunk[][] = [];
  for (const chunk of chunks) {
    const previous = rows[rows.length - 1];
    if (previous && Math.abs((previous[0]?.y ?? 0) - chunk.y) <= Math.min(2.5, unit * 0.25)) previous.push(chunk);
    else rows.push([chunk]);
  }
  const lines: Line[] = [];
  for (const row of rows) {
    let current: Line | null = null;
    for (const chunk of row.sort((a, b) => a.x - b.x)) {
      // Actual inter-column gaps, rather than frequent x coordinates: a bold
      // numbered-list lead-in followed by regular prose is still one line.
      const markerOnly = current && /^(?:(?:Figure|Fig\.?|Table|Algorithm|Theorem|Lemma)\s*)?[\dA-Z]+(?:\.\d+)*\.?$/i.test(current.text);
      const gap = markerOnly ? Math.max(30, unit * 3) : Math.max(8, unit * 0.9);
      if (!current || chunk.x - current.right > gap) {
        current = { text: chunk.str.trim(), x: chunk.x, y: chunk.y, right: right(chunk, unit), chunks: [chunk] };
        lines.push(current);
      } else {
        current.text = `${current.text} ${chunk.str.trim()}`.replace(/\s+/g, " ");
        current.right = Math.max(current.right, right(chunk, unit));
        current.chunks.push(chunk);
      }
    }
  }
  const pitches: number[] = [];
  for (const line of lines) {
    const next = lines.find((other) => other.y < line.y - 3 && Math.abs(other.x - line.x) < unit * 2);
    const distance = next ? line.y - next.y : 0;
    if (distance > unit * 0.8 && distance < unit * 2) pitches.push(distance);
  }
  const result = { lines, bodyHeight, bodyFont: dominantFont(chunks), pitch: median(pitches) ?? unit * 1.2 };
  layouts.set(page, result);
  return result;
}

interface HeadingMatch { title: string; explicit: boolean; punctuation: boolean }
function matchHeading(text: string, ref: Pick<PaperRef, "kind" | "label">): HeadingMatch | null {
  const label = escape(ref.label);
  if (ref.kind === "section" || ref.kind === "appendix") {
    const chinese = new RegExp(`^第\\s*${label}\\s*[章节]\\s*(.+)$`, "u").exec(text);
    if (chinese) return { title: chinese[1], explicit: true, punctuation: false };
    const prefix = ref.kind === "appendix" ? "(?:Appendix|附录)" : "(?:Section|Sec\\.?|Chapter|章节)";
    const explicit = new RegExp(`^${prefix}\\s*${label}(?!\\w|\\.\\d)(?:[.:：．]?\\s+|[.:：．])(.+)$`, "iu").exec(text);
    if (explicit) return { title: explicit[1], explicit: true, punctuation: false };
    const bare = new RegExp(`^${label}(?:[.．]?\\s+)(.+)$`, "u").exec(text);
    return bare ? { title: bare[1], explicit: false, punctuation: false } : null;
  }
  const word = CAPTION_WORDS[ref.kind];
  if (!word) return null;
  const caption = new RegExp(`^(?:${word})\\s*${label}(?!\\w|\\.\\d)(?:([.:：。])\\s*|\\s+)(.+)$`, "iu").exec(text);
  return caption ? { title: caption[2], explicit: true, punctuation: Boolean(caption[1]) } : null;
}

function neighbours(line: Line, lines: Line[], unit: number): { previous?: Line; next?: Line } {
  const aligned = lines.filter((other) => other !== line && Math.abs(other.x - line.x) <= unit * 2);
  return {
    previous: aligned.filter((other) => other.y > line.y + 3).sort((a, b) => a.y - b.y)[0],
    next: aligned.filter((other) => other.y < line.y - 3).sort((a, b) => b.y - a.y)[0],
  };
}

/**
 * Only typographically distinct headings are automatic destinations. Plain
 * short numbered lines remain candidates; lists and TOC entries are excluded.
 */
export function headingCandidates(page: BibliographyPage, ref: Pick<PaperRef, "kind" | "label">): HeadingCandidate[] {
  if (ref.kind === "equation") return [];
  const current = layout(page);
  const unit = current.bodyHeight ?? 10;
  const candidates: HeadingCandidate[] = [];
  for (const line of current.lines) {
    const match = matchHeading(line.text, ref);
    if (!match || !/\p{L}/u.test(match.title)) continue;
    // A table of contents or list of figures has a page number at the end.
    if (/(?:\.{2,}|…|·{2,})/.test(line.text) || /\s\d+\s*$/.test(match.title)) continue;
    const title = match.title.trim();
    if (/^(?:shows?|illustrates?|presents?|provides?|depicts?|reports?|demonstrates?|indicates?|describes?|is|are|was|were)\b/i.test(title)) continue;
    const section = ref.kind === "section" || ref.kind === "appendix";
    const textChunks = line.chunks.filter((chunk) => letters(chunk.str));
    const count = textChunks.reduce((sum, chunk) => sum + letters(chunk.str), 0);
    const different = current.bodyFont && textChunks.reduce((sum, chunk) => sum + (chunk.fontName && chunk.fontName !== current.bodyFont ? letters(chunk.str) : 0), 0) / count > 0.9;
    const larger = current.bodyHeight && textChunks.reduce((sum, chunk) => sum + (chunk.height && chunk.height > current.bodyHeight! * 1.035 ? letters(chunk.str) : 0), 0) / count > 0.9;
    const { previous, next } = neighbours(line, current.lines, unit);
    const beforeGap = previous ? previous.y - line.y : Infinity;
    const afterGap = next ? line.y - next.y : Infinity;
    const separated = beforeGap >= current.pitch * 1.15 && afterGap >= current.pitch * 1.15;
    let confidence: HeadingCandidate["confidence"] = "candidate";
    if (section) {
      // Numbered prose and enumerated algorithm steps often start with the
      // same numeral; punctuation inside a sentence is stronger evidence.
      if (title.length > 150 || title.split(/\s+/).length > 18 || /[.!?;:：]\s+\p{L}|[:：]$/u.test(title)) continue;
      if (/[.!?。！？]$/.test(title) && !different && !larger) continue;
      const prefixFont = line.chunks[0]?.fontName;
      const continuation = next && next.x - line.x > unit * 0.45 && afterGap <= current.pitch * 1.12;
      if (continuation && !larger && (!different || prefixFont === current.bodyFont)) continue;
      if (!/^[\p{Lu}\p{Lo}\d]/u.test(title)) {
        if (!different && !larger) continue;
      } else if ((different || larger) && (separated || afterGap >= current.pitch * 1.15)) confidence = "high";
    } else if (match.punctuation || different || larger) confidence = "high";
    candidates.push({
      target: { pageNumber: page.pageNumber, kind: "XYZ", left: line.x, top: line.y + 10, zoom: null },
      text: line.text,
      confidence,
    });
  }
  return candidates;
}
