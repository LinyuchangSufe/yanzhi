import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captureAnchor,
  layoutPages,
  mostVisiblePage,
  restoreAnchor,
  stepZoom,
  mergeReadingPositions,
} from "../src/components/pdf/continuous";
import type { ReadingPosition } from "../src/lib/types";

const pages = [
  { width: 600, height: 800, rotation: 0 },
  { width: 600, height: 800, rotation: 0 },
  { width: 600, height: 800, rotation: 90 },
];
const close = (actual: number, expected: number) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-8,
    `${actual} should be ${expected}`,
  );

test("continuous placeholders retain exact physical page sizes, rotation and inter-page offsets", () => {
  const layouts = layoutPages(pages, 1.5, 700, 0);
  assert.deepEqual(
    layouts.map((page) => [page.width, page.height, page.top]),
    [
      [900, 1200, 16],
      [900, 1200, 1232],
      [1200, 900, 2448],
    ],
  );
  const rotated = layoutPages(pages, 1, 700, 90);
  assert.deepEqual(
    rotated.map((page) => [page.width, page.height]),
    [
      [800, 600],
      [800, 600],
      [600, 800],
    ],
  );
});

test("fit width sizes every page without needing a canvas, including an unrendered landscape page", () => {
  const layouts = layoutPages(pages, "page-width", 720, 0);
  assert.deepEqual(
    layouts.map((page) => [page.width, page.height]),
    [
      [720, 960],
      [720, 960],
      [720, 540],
    ],
  );
  close(layouts[2].scale, 0.9);
});

test("scroll tracking chooses the most visible physical page, never its printed page label", () => {
  const layouts = layoutPages(pages, 1, 700, 0);
  assert.equal(mostVisiblePage(layouts, 0, 600), 0);
  assert.equal(mostVisiblePage(layouts, 700, 600), 1);
  assert.equal(mostVisiblePage(layouts, 1600, 600), 2);
});

test("zoom preserves the page and fractional position at the viewport top", () => {
  const before = layoutPages(pages, 1, 700, 0);
  const anchor = captureAnchor(before, before[1].top + 200, 90, 700);
  assert.ok(anchor);
  assert.equal(anchor.pageIndex, 1);
  close(anchor.fraction, 0.25);
  const after = layoutPages(pages, 2, 700, 0);
  const restored = restoreAnchor(after, anchor, 700);
  close(restored.top, after[1].top + 400);
  assert.equal(mostVisiblePage(after, restored.top, 500), 1);
});

test("anchor uses the top page even when most of the viewport shows the following page", () => {
  const layouts = layoutPages(pages, 1, 700, 0);
  assert.equal(mostVisiblePage(layouts, 700, 600), 1);
  const anchor = captureAnchor(layouts, 700, 0, 700);
  assert.ok(anchor);
  assert.equal(anchor.pageIndex, 0);
  close(anchor.fraction, (700 - 16) / 800);
});

test("resize and rotate anchors remain on the same unrendered physical page", () => {
  const before = layoutPages(pages, "page-width", 720, 0);
  const anchor = captureAnchor(
    before,
    before[2].top + before[2].height * 0.4,
    0,
    752,
  );
  assert.ok(anchor);
  const after = layoutPages(pages, "page-width", 960, 90);
  const restored = restoreAnchor(after, anchor, 992);
  assert.equal(anchor.pageIndex, 2);
  close(restored.top, after[2].top + after[2].height * 0.4);
});

test("zoom buttons use the actual fit scale and bounded numeric increments", () => {
  assert.equal(stepZoom("page-width", 1.5, 1), 1.8);
  assert.equal(stepZoom("page-width", 1.5, -1), 1.25);
  assert.equal(stepZoom(4, 4, 1), 4);
  assert.equal(stepZoom(0.25, 0.25, -1), 0.25);
});

const position = (
  attachmentId: string,
  pageIndex: number,
  updatedAt: string,
): ReadingPosition => ({
  paperId: "paper",
  attachmentId,
  pageIndex,
  scale: 1.5,
  rotation: 90,
  updatedAt,
});

test("a restarted reader seeds every attachment version, so switching from latest B restores historical A", () => {
  const cache = new Map<string, ReadingPosition>();
  const historical = position("A", 2, "2026-10-28T10:00:00.000Z");
  const latest = position("B", 1, "2026-10-28T11:00:00.000Z");
  mergeReadingPositions(cache, [historical, latest], "paper");
  assert.equal(cache.get("B")?.pageIndex, 1);
  assert.equal(cache.get("A")?.pageIndex, 2);
  assert.equal(cache.get("A")?.scale, 1.5);
  assert.equal(cache.get("A")?.rotation, 90);
});

test("late server snapshots cannot overwrite a local page observed before its persistence debounce", () => {
  const cache = new Map<string, ReadingPosition>();
  const original = position("A", 0, "2026-10-28T10:00:00.000Z");
  mergeReadingPositions(cache, [original], "paper");
  // This is what onPositionObserved does synchronously, before its 450ms save.
  const local = position("A", 2, "2026-10-28T10:00:01.000Z");
  cache.set("A", local);
  const observed = new Set(["A"]);
  mergeReadingPositions(
    cache,
    [
      position("A", 0, "2026-10-28T10:00:02.000Z"),
      position("B", 1, "2026-10-28T10:00:02.000Z"),
    ],
    "paper",
    observed,
  );
  assert.equal(cache.get("A"), local);
  assert.equal(cache.get("B")?.pageIndex, 1);
});

test("saved position synchronization selects newer records per attachment and excludes another paper", () => {
  const cache = new Map<string, ReadingPosition>();
  const newer = position("A", 2, "2026-10-28T11:00:00.000Z");
  mergeReadingPositions(
    cache,
    [
      newer,
      position("A", 0, "2026-10-28T10:00:00.000Z"),
      { ...position("C", 5, "2026-10-28T12:00:00.000Z"), paperId: "other" },
    ],
    "paper",
  );
  assert.equal(cache.get("A"), newer);
  assert.equal(cache.has("C"), false);
});
