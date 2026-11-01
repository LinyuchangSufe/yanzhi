import type { BibliographyPage, PdfTextChunk } from "./bibliography";
import type { ResolvedPdfDestination } from "./destinations";

export interface EquationCandidate {
  target: ResolvedPdfDestination;
  text: string;
  confidence: "high" | "candidate";
}

interface Column { left: number; right: number; contentRight: number }
interface Marker { chunks: PdfTextChunk[]; x: number; y: number; right: number; height: number }
const MATH_OPERATOR = /[=<>≤≥≈≃≡≠∈∉∑∫∏√±×÷→↦∝∂∇∞⊂⊆−+*/^_\\]/u;
const MATH_WORDS = new Set([
  "sin", "cos", "tan", "cot", "log", "ln", "exp", "min", "max", "arg", "sup", "inf",
  "lim", "det", "diag", "rank", "trace", "softmax", "sigmoid", "subject", "such", "that",
]);

function size(chunk: PdfTextChunk): number {
  return typeof chunk.height === "number" && Number.isFinite(chunk.height) && chunk.height > 0
    ? Math.min(40, Math.max(5, chunk.height)) : 10;
}
function right(chunk: PdfTextChunk): number {
  return chunk.x + (typeof chunk.width === "number" && Number.isFinite(chunk.width) && chunk.width >= 0
    ? chunk.width : chunk.str.length * size(chunk) * 0.45);
}
function normalized(value: string): string {
  return value.replace(/（/gu, "(").replace(/）/gu, ")").replace(/\s+/gu, "").toUpperCase();
}
function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}
function prose(chunk: PdfTextChunk): boolean {
  return (chunk.str.match(/[A-Za-z]{2,}/gu)?.length ?? 0) >= 4;
}

/** Infer a gutter from repeated paragraph starts, never from equal y values across columns. */
function columns(page: BibliographyPage, chunks: PdfTextChunk[]): Column[] {
  const longLines = chunks.filter((chunk) => prose(chunk) && right(chunk) - chunk.x > page.pageWidth * 0.18);
  const starts: { x: number; count: number }[] = [];
  for (const chunk of [...longLines].sort((a, b) => a.x - b.x)) {
    const cluster = starts.find((entry) => Math.abs(chunk.x - entry.x) <= 4);
    if (cluster) cluster.count++;
    else starts.push({ x: chunk.x, count: 1 });
  }
  const repeated = starts.filter((entry) => entry.count >= 3).sort((a, b) => b.count - a.count);
  const first = repeated.find((entry) => entry.x < page.pageWidth * 0.35);
  const second = repeated.find((entry) => entry.x > page.pageWidth * 0.45 && entry.x < page.pageWidth * 0.75);
  if (first && second && second.x - first.x >= page.pageWidth * 0.25) {
    const leftLines = longLines.filter((chunk) => chunk.x < (first.x + second.x) / 2);
    const crossing = leftLines.filter((chunk) => right(chunk) > second.x);
    if (crossing.length <= leftLines.length * 0.2) {
      const leftEdge = percentile(leftLines.filter((chunk) => right(chunk) <= second.x).map(right), 0.9);
      const gutter = leftEdge > first.x ? (leftEdge + second.x) / 2 : page.pageWidth / 2;
      return [
        { left: 0, right: gutter, contentRight: leftEdge || gutter - 8 },
        { left: gutter, right: page.pageWidth, contentRight: percentile(longLines.filter((chunk) => chunk.x >= gutter).map(right), 0.9) || page.pageWidth * 0.92 },
      ];
    }
  }
  return [{ left: 0, right: page.pageWidth, contentRight: percentile(longLines.map(right), 0.9) || page.pageWidth * 0.92 }];
}

function markers(chunks: PdfTextChunk[], label: string): Marker[] {
  const expected = `(${label})`;
  const result: Marker[] = [];
  for (const chunk of chunks) {
    const initial = normalized(chunk.str);
    if (!initial.startsWith("(") || initial.length > expected.length) continue;
    const height = size(chunk);
    const row = chunks.filter((item) => item.x >= chunk.x && Math.abs(item.y - chunk.y) <= height * 0.25)
      .sort((a, b) => a.x - b.x);
    const assembled: PdfTextChunk[] = [];
    let text = "";
    let end = chunk.x;
    for (const item of row) {
      if (assembled.length && item.x - end > Math.max(4, height * 0.45)) break;
      assembled.push(item);
      text += normalized(item.str);
      end = right(item);
      if (text === expected) {
        result.push({ chunks: assembled, x: chunk.x, y: chunk.y, right: end, height });
        break;
      }
      if (!expected.startsWith(text) || assembled.length >= 8) break;
    }
  }
  return result;
}

function languageWords(chunks: PdfTextChunk[]): number {
  const text = chunks.map((chunk) => chunk.str).join(" ");
  if (/\b(?:as|we|is|are|by|see|from|where|then|thus|using|therefore|equations?|eq)\b/iu.test(text)
    || /\p{Script=Han}{3,}/u.test(text)) return 2;
  return chunks.flatMap((chunk) => chunk.str.match(/[A-Za-z]{3,}/gu) ?? [])
    .filter((word) => !MATH_WORDS.has(word.toLowerCase())).length;
}

/**
 * Only independently typeset parenthesized tags are eligible. A tag next to prose is
 * a mention, not an equation destination. A unique low-confidence match must still
 * be shown to the reader for confirmation by the caller.
 */
export function equationCandidates(page: BibliographyPage, label: string): EquationCandidate[] {
  const cleanLabel = normalized(label).replace(/^\(|\)$/gu, "");
  if (!/^(?:[A-Z]\.)?\d{1,4}(?:\.\d{1,4})*(?:[A-Z])?$/u.test(cleanLabel)
    || !Number.isFinite(page.pageWidth) || page.pageWidth <= 0) return [];
  const chunks = page.chunks.filter((chunk) => chunk.str.trim() && Number.isFinite(chunk.x) && Number.isFinite(chunk.y));
  const layout = columns(page, chunks);
  const results: EquationCandidate[] = [];
  for (const marker of markers(chunks, cleanLabel)) {
    const column = layout.find((entry) => marker.x >= entry.left && marker.right <= entry.right + 2);
    if (!column) continue;
    const content = chunks.filter((chunk) => chunk.x >= column.left && right(chunk) <= column.right + 2 && !marker.chunks.includes(chunk));
    if (content.some((chunk) => /^(?:references|bibliography|参考文献)[.:]?$/iu.test(chunk.str.replace(/\s+/gu, "")) && chunk.y > marker.y)) continue;
    const row = content.filter((chunk) => chunk.x < marker.x && Math.abs(chunk.y - marker.y) <= marker.height * 0.65);
    if (!row.length || content.some((chunk) => chunk.x > marker.right + 2 && Math.abs(chunk.y - marker.y) <= marker.height * 0.4)) continue;
    const rowRight = Math.max(...row.map(right));
    const gap = marker.x - rowRight;
    if (gap < Math.max(4, marker.height * 0.45) || languageWords(row) >= 2) continue;
    const body = content.filter((chunk) => chunk.x < marker.x && Math.abs(chunk.y - marker.y) <= marker.height * 3.2);
    const equationBody = body.filter((chunk) => !prose(chunk));
    const text = row.sort((a, b) => a.x - b.x).map((chunk) => chunk.str).join(" ")
      .replace(/[\u0000-\u001f\u007f]/gu, "").replace(/\s+/gu, " ").trim();
    if (!text || (!MATH_OPERATOR.test(text) && languageWords(row) > 0)) continue;
    const nearEdge = Math.abs(marker.right - column.contentRight) <= Math.max(marker.height * 2.2, (column.right - column.left) * 0.09);
    const separatedFromProse = !body.some((chunk) => prose(chunk) && Math.abs(chunk.y - marker.y) < marker.height * 1.3);
    const strongMath = MATH_OPERATOR.test(text) && languageWords(row) === 0;
    const top = Math.max(marker.y + marker.height * 2, ...equationBody.map((chunk) => chunk.y + size(chunk) * 1.25));
    results.push({
      target: { pageNumber: page.pageNumber, kind: "XYZ", left: Math.min(...equationBody.map((chunk) => chunk.x)), top, zoom: null },
      text: `${text.slice(0, 220)} (${cleanLabel})`,
      confidence: nearEdge && separatedFromProse && strongMath && marker.y > 35 ? "high" : "candidate",
    });
  }
  return results.filter((result, index) => !results.slice(0, index).some((previous) =>
    Math.abs((previous.target.top ?? 0) - (result.target.top ?? 0)) < 2 && Math.abs((previous.target.left ?? 0) - (result.target.left ?? 0)) < 2));
}
