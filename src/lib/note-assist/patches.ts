import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import { StoreError } from "../store-error";
import type {
  NoteAssistance,
  NoteAssistEdit,
  NoteAssistSelection,
} from "./types";

interface Node {
  type: string;
  url?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
interface Range {
  from: number;
  to: number;
}
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
/** Conservative literal protection: generated prose must retain formulas, code and citations. */
function protectedRanges(body: string): Range[] {
  const ranges: Range[] = [];
  const visit = (node: Node) => {
    if (
      [
        "code",
        "inlineCode",
        "math",
        "inlineMath",
        "image",
        "imageReference",
        "link",
        "linkReference",
        "definition",
        "html",
      ].includes(node.type)
    ) {
      const from = node.position?.start.offset,
        to = node.position?.end.offset;
      if (from !== undefined && to !== undefined) ranges.push({ from, to });
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(parser.parse(body) as Node);
  // The reader also accepts exported LaTeX delimiters, which remark treats as prose.
  for (const match of body.matchAll(
    /(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)|(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g,
  )) {
    const from = match.index!,
      to = from + match[0].length;
    const math = (match[1] ?? match[2] ?? "").trim();
    if (
      math &&
      !math.includes("$") &&
      !ranges.some((range) => from < range.to && to > range.from)
    )
      ranges.push({ from, to });
  }
  return ranges.sort((a, b) => a.from - b.from);
}
function assertProtectedBody(before: string, after: string): void {
  const tokens = (body: string) =>
    protectedRanges(body).map((part) => body.slice(part.from, part.to));
  if (JSON.stringify(tokens(before)) !== JSON.stringify(tokens(after)))
    throw new StoreError(
      "AI 修改不得改变公式、代码、图片或引用的整体结构",
      422,
    );
}
/** Insertions retain every source character, and must not split a protected Markdown token. */
export function assertSafeInsertion(body: string, position: number): void {
  if (
    !Number.isInteger(position) ||
    position < 0 ||
    position > body.length ||
    (position > 0 &&
      /[\uD800-\uDBFF]/.test(body[position - 1]) &&
      /[\uDC00-\uDFFF]/.test(body[position] ?? ""))
  )
    throw new StoreError("插入位置无效，请重新选择位置", 422);
  if (
    protectedRanges(body).some(
      (range) => position > range.from && position < range.to,
    )
  )
    throw new StoreError(
      "插入位置位于公式、代码、图片、引用或 HTML 内。请将光标移到其外部，或选择追加到笔记末尾；当前正文未改变",
      422,
    );
}
function applyRanges(
  body: string,
  edits: NoteAssistEdit[],
  ranges: Range[],
  indices: number[],
): string {
  for (const i of [...indices].sort((a, b) => ranges[b].from - ranges[a].from))
    body =
      body.slice(0, ranges[i].from) + edits[i].after + body.slice(ranges[i].to);
  return body;
}
/** Only parsed markup counts; code examples and math are never treated as clickable resources. */
export function noteMarkupReferences(body: string): {
  urls: string[];
  hasImages: boolean;
  hasHtml: boolean;
} {
  const result = { urls: [] as string[], hasImages: false, hasHtml: false };
  const visit = (node: Node) => {
    if (node.url) result.urls.push(node.url);
    if (node.type === "image" || node.type === "imageReference")
      result.hasImages = true;
    if (node.type === "html") result.hasHtml = true;
    for (const child of node.children ?? []) visit(child);
  };
  visit(parser.parse(body) as Node);
  return result;
}
function rangesFor(
  baseBody: string,
  selection: NoteAssistSelection | null,
  edits: NoteAssistEdit[],
): Range[] {
  if (
    selection &&
    (selection.from < 0 ||
      selection.to > baseBody.length ||
      selection.to <= selection.from ||
      baseBody.slice(selection.from, selection.to) !== selection.text)
  )
    throw new StoreError("选段已改变，不能定位 AI 修改", 409);
  const from = selection?.from ?? 0,
    to = selection?.to ?? baseBody.length;
  const scope = baseBody.slice(from, to);
  return edits.map((edit) => {
    const offset = scope.indexOf(edit.before);
    if (
      !edit.before ||
      offset < 0 ||
      scope.indexOf(edit.before, offset + 1) >= 0
    )
      throw new StoreError("AI 修改的原文必须在所选范围内唯一匹配", 422);
    return { from: from + offset, to: from + offset + edit.before.length };
  });
}
export function validateEdits(
  baseBody: string,
  selection: NoteAssistSelection | null,
  edits: NoteAssistEdit[],
): void {
  const ranges = rangesFor(baseBody, selection, edits);
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i].from < sorted[i - 1].to)
      throw new StoreError("AI 修改原文范围重叠，不能安全采纳", 422);
  const protectedParts = protectedRanges(baseBody);
  edits.forEach((edit, i) => {
    const range = ranges[i];
    for (const part of protectedParts) {
      if (
        range.from < part.to &&
        range.to > part.from &&
        (range.from > part.from || range.to < part.to)
      )
        throw new StoreError("AI 修改不可截断公式、代码、图片或引用", 422);
    }
    const before = protectedRanges(edit.before).map((p) =>
      edit.before.slice(p.from, p.to),
    );
    const after = protectedRanges(edit.after).map((p) =>
      edit.after.slice(p.from, p.to),
    );
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new StoreError(
        "AI 修改不得改变公式、代码、图片或引用；请手动核对后编辑",
        422,
      );
    if (edit.before === edit.after)
      throw new StoreError("AI 修改没有实际变化", 422);
    assertProtectedBody(baseBody, applyRanges(baseBody, edits, ranges, [i]));
  });
  assertProtectedBody(
    baseBody,
    applyRanges(
      baseBody,
      edits,
      ranges,
      edits.map((_, i) => i),
    ),
  );
}
/** Locate all edits against the immutable base, then replace backwards (never cascading replacements). */
export function buildRevisedText(
  record: Pick<
    NoteAssistance,
    "baseBody" | "selection" | "result" | "appliedEdits"
  >,
  appliedIndices = record.appliedEdits,
): string {
  validateEdits(record.baseBody, record.selection, record.result.edits);
  const all = rangesFor(record.baseBody, record.selection, record.result.edits);
  const indices = new Set(appliedIndices);
  if (
    indices.size !== appliedIndices.length ||
    [...indices].some((i) => !Number.isInteger(i) || i < 0 || i >= all.length)
  )
    throw new StoreError("已采纳修改记录无效", 422);
  const body = applyRanges(record.baseBody, record.result.edits, all, [
    ...indices,
  ]);
  assertProtectedBody(record.baseBody, body);
  if (body.length > 2_000_000)
    throw new StoreError("采纳后的笔记超过容量上限", 413);
  return body;
}
