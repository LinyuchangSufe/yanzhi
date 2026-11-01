import type { ResolvedPdfDestination } from "../../lib/pdf-reference/destinations";

interface PreviewViewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}

/** A full-width band retains both the formula body and its margin number. */
export function referencePreviewGeometry(
  viewport: PreviewViewport,
  pageView: readonly number[],
  target: ResolvedPdfDestination,
  source: string,
): { width: number; height: number; sourceY: number } | null {
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) ||
      viewport.width <= 0 || viewport.height <= 0) return null;
  const [left, , , top] = pageView;
  const [, convertedY] = viewport.convertToViewportPoint(target.left ?? left, target.top ?? top);
  const y = Number.isFinite(convertedY) ? convertedY : 0;
  const height = Math.min(source === "equation" ? 270 : 205, viewport.height);
  const above = source === "equation" ? 110 : 45;
  const sourceY = Math.max(0, Math.min(viewport.height - height, y - above));
  return { width: Math.max(1, Math.ceil(viewport.width)), height: Math.max(1, Math.ceil(height)), sourceY };
}
