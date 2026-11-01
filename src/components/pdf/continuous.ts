import type { ReadingPosition } from "../../lib/types";

export const PAGE_GAP = 16;
export const STAGE_PADDING = 16;
export interface PageSize {
  width: number;
  height: number;
  rotation: number;
}
export interface PageLayout {
  pageIndex: number;
  top: number;
  width: number;
  height: number;
  scale: number;
}
export interface ScrollAnchor {
  pageIndex: number;
  fraction: number;
  horizontalFraction: number;
}

/** Exact page placeholders need only PDF page boxes, not rendered canvases. */
export function layoutPages(
  pages: PageSize[],
  scale: number | "page-width",
  width: number,
  rotation: number,
): PageLayout[] {
  let top = STAGE_PADDING;
  return pages.map((page, pageIndex) => {
    const rotated = (((page.rotation + rotation) % 180) + 180) % 180 !== 0;
    const baseWidth = rotated ? page.height : page.width;
    const baseHeight = rotated ? page.width : page.height;
    const actualScale =
      scale === "page-width" ? Math.max(1, width) / baseWidth : scale;
    const result = {
      pageIndex,
      top,
      width: baseWidth * actualScale,
      height: baseHeight * actualScale,
      scale: actualScale,
    };
    top += result.height + PAGE_GAP;
    return result;
  });
}

/** Most visible physical page, independent from printed labels and render state. */
export function mostVisiblePage(
  layouts: PageLayout[],
  scrollTop: number,
  viewportHeight: number,
): number {
  let selected = 0;
  let best = -1;
  for (const page of layouts) {
    const overlap = Math.max(
      0,
      Math.min(page.top + page.height, scrollTop + viewportHeight) -
        Math.max(page.top, scrollTop),
    );
    if (overlap > best) {
      best = overlap;
      selected = page.pageIndex;
    }
  }
  return selected;
}

/** Capture the page at the viewport top, even when a later page is most visible. */
export function captureAnchor(
  layouts: PageLayout[],
  scrollTop: number,
  scrollLeft: number,
  viewportWidth: number,
): ScrollAnchor | null {
  if (!layouts.length) return null;
  const page =
    [...layouts].reverse().find((item) => item.top <= scrollTop) ?? layouts[0];
  const maxWidth =
    Math.max(...layouts.map((item) => item.width)) + STAGE_PADDING * 2;
  return {
    pageIndex: page.pageIndex,
    fraction: Math.max(0, Math.min(1, (scrollTop - page.top) / page.height)),
    horizontalFraction: Math.max(
      0,
      Math.min(1, scrollLeft / Math.max(1, maxWidth - viewportWidth)),
    ),
  };
}

export function restoreAnchor(
  layouts: PageLayout[],
  anchor: ScrollAnchor,
  viewportWidth: number,
): { top: number; left: number } {
  const page = layouts[Math.min(anchor.pageIndex, layouts.length - 1)];
  if (!page) return { top: 0, left: 0 };
  const maxWidth =
    Math.max(...layouts.map((item) => item.width)) + STAGE_PADDING * 2;
  return {
    top: page.top + page.height * anchor.fraction,
    left: Math.max(0, maxWidth - viewportWidth) * anchor.horizontalFraction,
  };
}

export function stepZoom(
  scale: number | "page-width",
  effectiveScale: number,
  direction: 1 | -1,
): number {
  const base = scale === "page-width" ? effectiveScale : scale;
  return Math.max(
    0.25,
    Math.min(
      4,
      Math.round(base * (direction === 1 ? 1.2 : 1 / 1.2) * 100) / 100,
    ),
  );
}

/** Merge saved versions without replacing an in-session position with a late snapshot. */
export function mergeReadingPositions(
  cache: Map<string, ReadingPosition>,
  positions: readonly ReadingPosition[],
  paperId: string,
  locallyObserved: ReadonlySet<string> = new Set(),
): void {
  for (const position of positions) {
    if (
      position.paperId !== paperId ||
      locallyObserved.has(position.attachmentId)
    )
      continue;
    const current = cache.get(position.attachmentId);
    if (!current || position.updatedAt > current.updatedAt)
      cache.set(position.attachmentId, position);
  }
}
