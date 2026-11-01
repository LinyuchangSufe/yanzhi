import { clipPixelRect, type PixelRect } from "./geometry";

export interface HighlightGeometryOptions {
  /** The total PDF.js viewport rotation, including the page's own rotation. */
  rotation?: number;
  bounds?: { width: number; height: number };
}

const right = (rect: PixelRect) => rect.x + rect.width;
const bottom = (rect: PixelRect) => rect.y + rect.height;
const center = (rect: PixelRect) => rect.y + rect.height / 2;
const area = (rect: PixelRect) => rect.width * rect.height;

function contains(outer: PixelRect, inner: PixelRect) {
  const tolerance = Math.min(0.25, inner.height * 0.02);
  return (
    outer.x <= inner.x + tolerance &&
    outer.y <= inner.y + tolerance &&
    right(outer) >= right(inner) - tolerance &&
    bottom(outer) >= bottom(inner) - tolerance
  );
}

function equivalent(a: PixelRect, b: PixelRect) {
  const tolerance = Math.min(0.3, Math.min(a.height, b.height) * 0.015);
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(right(a) - right(b)) <= tolerance &&
    Math.abs(bottom(a) - bottom(b)) <= tolerance
  );
}

function distance(a: PixelRect, b: PixelRect) {
  return Math.max(0, a.x - right(b), b.x - right(a));
}

function sameLine(a: PixelRect, b: PixelRect) {
  const large = Math.max(a.height, b.height);
  const small = Math.min(a.height, b.height);
  const overlap = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
  const centerDistance = Math.abs(center(a) - center(b));
  if (small / large >= 0.65)
    return overlap >= small * 0.55 && centerDistance <= large * 0.45;
  // Superscripts and subscripts may only touch the body glyph's vertical box.
  // They must remain close to its baseline; a neighboring body line never
  // becomes eligible merely because a previous script enlarged the paint box.
  return overlap >= -large * 0.1 && centerDistance <= large * 0.75;
}

function hull(rects: readonly PixelRect[]): PixelRect {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  return {
    x,
    y,
    width: Math.max(...rects.map(right)) - x,
    height: Math.max(...rects.map(bottom)) - y,
  };
}

/**
 * Range.getClientRects() can include an element's broad box as well as its
 * individual text descendants. Prefer the leaves when two independent child
 * boxes establish that the parent is a container, rather than painting the
 * whitespace between paragraphs/columns. A single contained text box is kept:
 * it may just be a formula's small subscript inside a genuine body-text box.
 */
function removeContainers(rects: readonly PixelRect[]) {
  return rects.filter((rect, index) => {
    const children = rects.filter(
      (child, childIndex) =>
        index !== childIndex &&
        area(child) < area(rect) * 0.98 &&
        contains(rect, child),
    );
    return !children.some((child, childIndex) =>
      children.some(
        (other, otherIndex) =>
          childIndex !== otherIndex &&
          !contains(child, other) &&
          !contains(other, child),
      ),
    );
  });
}

/** Exact rectangular union: no returned paint boxes overlap and darken twice. */
function disjointUnion(rects: readonly PixelRect[]): PixelRect[] {
  const edges = [
    ...new Set(rects.flatMap((rect) => [rect.y, bottom(rect)])),
  ].sort((a, b) => a - b);
  const result: PixelRect[] = [];
  let previous = new Map<string, PixelRect>();
  for (let index = 0; index + 1 < edges.length; index++) {
    const top = edges[index];
    const end = edges[index + 1];
    if (end <= top) continue;
    const intervals = rects
      .filter((rect) => rect.y < end && bottom(rect) > top)
      .map((rect) => [rect.x, right(rect)] as const)
      .sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [start, stop] of intervals) {
      const last = merged.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], stop);
      else merged.push([start, stop]);
    }
    const next = new Map<string, PixelRect>();
    for (const [start, stop] of merged) {
      const key = `${start}:${stop}`;
      const last = previous.get(key);
      if (last && bottom(last) === top) {
        last.height = end - last.y;
        next.set(key, last);
      } else {
        const rect = {
          x: start,
          y: top,
          width: stop - start,
          height: end - top,
        };
        result.push(rect);
        next.set(key, rect);
      }
    }
    previous = next;
  }
  return result;
}

/**
 * Convert word/glyph boxes in current viewport CSS pixels to smooth line
 * highlights. The input is not changed or expanded outside the page. Only
 * ordinary word-size gaps on the same visual baseline are filled; separated
 * selections, paragraph gaps and column gutters remain separate.
 *
 * Call this per annotation/evidence (or per discontiguous segment when that
 * boundary is known). Do not merge unrelated annotations together: each keeps
 * its own color, comment and click target. Persistent PDF coordinates remain
 * unchanged; this function only computes display geometry.
 */
export function mergeHighlightRects(
  rects: readonly PixelRect[],
  options: HighlightGeometryOptions = {},
): PixelRect[] {
  const rotation = Number.isFinite(options.rotation)
    ? (options.rotation ?? 0)
    : 0;
  const vertical = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const swap = (rect: PixelRect): PixelRect =>
    vertical
      ? { x: rect.y, y: rect.x, width: rect.height, height: rect.width }
      : { ...rect };
  const candidates: PixelRect[] = [];
  if (
    options.bounds &&
    (!Number.isFinite(options.bounds.width) ||
      !Number.isFinite(options.bounds.height) ||
      options.bounds.width <= 0 ||
      options.bounds.height <= 0)
  )
    return [];
  for (const rect of rects) {
    if (
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.width <= 0 ||
      rect.height <= 0
    )
      continue;
    const clipped = options.bounds
      ? clipPixelRect(rect, options.bounds.width, options.bounds.height)
      : { ...rect };
    if (!clipped || clipped.width < 0.25 || clipped.height < 0.25) continue;
    candidates.push(swap(clipped));
  }
  const clean: PixelRect[] = [];
  for (const aligned of candidates.sort(
    (a, b) => area(b) - area(a) || a.y - b.y || a.x - b.x,
  ))
    if (!clean.some((other) => equivalent(aligned, other))) clean.push(aligned);
  // Start with body text. Formula scripts attach to an established baseline,
  // rather than allowing two neighboring body lines to chain through a script.
  const leaves = removeContainers(clean).sort(
    (a, b) =>
      b.height - a.height || a.y - b.y || a.x - b.x || b.width - a.width,
  );
  const lines: { anchor: PixelRect; rects: PixelRect[] }[] = [];
  for (const rect of leaves) {
    let best: (typeof lines)[number] | undefined;
    let score = Number.POSITIVE_INFINITY;
    for (const line of lines) {
      if (!sameLine(line.anchor, rect)) continue;
      const gap = Math.min(...line.rects.map((other) => distance(other, rect)));
      if (gap > Math.max(line.anchor.height, rect.height) * 0.65) continue;
      const candidate = Math.abs(center(line.anchor) - center(rect)) + gap;
      if (candidate < score) {
        best = line;
        score = candidate;
      }
    }
    if (best) best.rects.push(rect);
    else lines.push({ anchor: rect, rects: [rect] });
  }
  // A slightly shorter word can arrive after two taller words on its sides.
  // Consolidate their line groups once it bridges their ordinary space gaps.
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (let next = index + 1; next < lines.length; next++) {
      const other = lines[next];
      if (!sameLine(line.anchor, other.anchor)) continue;
      const maxGap = Math.max(line.anchor.height, other.anchor.height) * 0.65;
      if (
        !line.rects.some((first) =>
          other.rects.some((second) => distance(first, second) <= maxGap),
        )
      )
        continue;
      line.rects.push(...other.rects);
      lines.splice(next, 1);
      next = index;
    }
  }
  return disjointUnion(lines.map((line) => hull(line.rects)))
    .map(swap)
    .sort(
      (a, b) =>
        a.y - b.y || a.x - b.x || a.height - b.height || a.width - b.width,
    );
}
