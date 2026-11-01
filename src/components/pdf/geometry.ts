import type { AnnotationRect } from "../../lib/types";

export interface ViewportTransform {
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportPoint(x: number, y: number): number[];
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const unit = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Persist unrotated PDF coordinates normalized against page.view (CropBox).
 * x points right and y points up. This is independent of zoom, CSS pixels,
 * devicePixelRatio, intrinsic page rotation, and the reader's rotation.
 */
export function viewportToNormalizedRect(
  rect: PixelRect,
  viewport: ViewportTransform,
  pageView: readonly number[],
): AnnotationRect {
  const [left, bottom, right, top] = pageView;
  const points = [
    viewport.convertToPdfPoint(rect.x, rect.y),
    viewport.convertToPdfPoint(rect.x + rect.width, rect.y),
    viewport.convertToPdfPoint(rect.x, rect.y + rect.height),
    viewport.convertToPdfPoint(rect.x + rect.width, rect.y + rect.height),
  ];
  const minX = unit(
    (Math.min(...points.map((point) => point[0])) - left) / (right - left),
  );
  const maxX = unit(
    (Math.max(...points.map((point) => point[0])) - left) / (right - left),
  );
  const minY = unit(
    (Math.min(...points.map((point) => point[1])) - bottom) / (top - bottom),
  );
  const maxY = unit(
    (Math.max(...points.map((point) => point[1])) - bottom) / (top - bottom),
  );
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function normalizedToViewportRect(
  rect: AnnotationRect,
  viewport: ViewportTransform,
  pageView: readonly number[],
): PixelRect {
  const [left, bottom, right, top] = pageView;
  const x1 = left + rect.x * (right - left);
  const y1 = bottom + rect.y * (top - bottom);
  const x2 = x1 + rect.width * (right - left);
  const y2 = y1 + rect.height * (top - bottom);
  const points = [
    viewport.convertToViewportPoint(x1, y1),
    viewport.convertToViewportPoint(x2, y1),
    viewport.convertToViewportPoint(x1, y2),
    viewport.convertToViewportPoint(x2, y2),
  ];
  const x = Math.min(...points.map((point) => point[0]));
  const y = Math.min(...points.map((point) => point[1]));
  return {
    x,
    y,
    width: Math.max(...points.map((point) => point[0])) - x,
    height: Math.max(...points.map((point) => point[1])) - y,
  };
}

/** Clip DOM selection rectangles to the current physical page. */
export function clipPixelRect(
  rect: PixelRect,
  width: number,
  height: number,
): PixelRect | null {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const right = Math.min(width, rect.x + rect.width);
  const bottom = Math.min(height, rect.y + rect.height);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
}

export function clampPageIndex(index: number, count: number): number {
  return Math.max(
    0,
    Math.min(
      Math.max(0, count - 1),
      Number.isFinite(index) ? Math.floor(index) : 0,
    ),
  );
}
