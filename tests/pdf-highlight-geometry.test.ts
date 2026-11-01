import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeHighlightRects } from "../src/components/pdf/highlight-geometry";
import type { PixelRect } from "../src/components/pdf/geometry";

const rect = (x: number, y: number, width: number, height: number): PixelRect => ({ x, y, width, height });
const swap = (item: PixelRect): PixelRect => rect(item.y, item.x, item.height, item.width);
const overlapArea = (a: PixelRect, b: PixelRect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

describe("PDF line highlight geometry", () => {
  it("joins words into one light-paint surface per text line while retaining paragraph gaps", () => {
    // Client rectangles from a two-line selection: spaces are absent from the
    // PDF text runs, but each word belongs to the same visual line.
    assert.deepEqual(mergeHighlightRects([
      rect(45, 110, 35, 19), rect(85, 110, 65, 19), rect(155, 110, 90, 19),
      rect(45, 137, 70, 19), rect(121, 137, 40, 19),
      rect(45, 190, 100, 19),
    ]), [rect(45, 110, 200, 19), rect(45, 137, 116, 19), rect(45, 190, 100, 19)]);
  });

  it("uses text height rather than word length so isolated short words can join", () => {
    assert.deepEqual(mergeHighlightRects([
      rect(0, 0, 4, 18), rect(9, 0, 5, 18), rect(19, 0, 70, 18),
    ]), [rect(0, 0, 89, 18)]);
  });

  it("joins a line when a shorter middle word arrives after its two taller neighbors", () => {
    assert.deepEqual(mergeHighlightRects([
      rect(0, 0, 30, 20), rect(35, 1, 25, 18), rect(65, 0, 35, 20),
    ]), [rect(0, 0, 100, 20)]);
  });

  it("keeps two columns and distant same-line selections separate", () => {
    assert.deepEqual(mergeHighlightRects([
      rect(20, 50, 50, 20), rect(75, 50, 100, 20),
      rect(210, 50, 40, 20), rect(255, 50, 65, 20),
      rect(400, 50, 80, 20),
    ]), [rect(20, 50, 155, 20), rect(210, 50, 110, 20), rect(400, 50, 80, 20)]);
  });

  it("discards duplicate element and text boxes without painting their overlap twice", () => {
    const result = mergeHighlightRects([
      rect(20, 50, 100, 20), rect(20, 50, 100, 20), rect(20.1, 50.1, 99.9, 19.9),
      rect(20, 50, 30, 20), rect(55, 50, 65, 20),
    ]);
    assert.deepEqual(result, [rect(20, 50, 100, 20)]);
  });

  it("filters broad parent boxes over multiple lines or two columns", () => {
    assert.deepEqual(mergeHighlightRects([
      rect(10, 20, 300, 220),
      rect(20, 40, 120, 20), rect(20, 68, 120, 20),
      rect(10, 120, 300, 20),
      rect(20, 120, 120, 20), rect(200, 120, 100, 20),
    ]), [rect(20, 40, 120, 20), rect(20, 68, 120, 20), rect(20, 120, 120, 20), rect(200, 120, 100, 20)]);
  });

  it("joins formula body, superscripts and subscripts without joining the following line", () => {
    assert.deepEqual(mergeHighlightRects([
      rect(10, 110, 75, 20), rect(90, 110, 20, 20),
      rect(109, 103, 9, 10), rect(110, 125, 10, 10),
      rect(122, 110, 90, 20), rect(10, 150, 100, 20),
    ]), [rect(10, 103, 202, 32), rect(10, 150, 100, 20)]);
  });

  for (const rotation of [90, 270, -90, 450]) {
    it(`merges on the vertical visual baseline at rotation ${rotation}`, () => {
      assert.deepEqual(mergeHighlightRects([
        rect(20, 30, 18, 40), rect(20, 75, 18, 60),
        rect(48, 30, 18, 80),
      ], { rotation }), [rect(20, 30, 18, 105), rect(48, 30, 18, 80)]);
    });
  }

  it("preserves line grouping at 180 degrees and under zoom", () => {
    const input = [rect(10, 20, 40, 20), rect(55, 20, 30, 20), rect(10, 50, 30, 20)];
    const scale = 2.75;
    const scaled = (item: PixelRect) => rect(item.x * scale, item.y * scale, item.width * scale, item.height * scale);
    assert.deepEqual(mergeHighlightRects(input.map(scaled), { rotation: 180 }),
      [rect(10, 20, 75, 20), rect(10, 50, 30, 20)].map(scaled));
  });

  it("clips to page bounds, ignores invalid rectangles, and leaves input untouched", () => {
    const input = [rect(-5, -4, 25, 24), rect(25, 0, 40, 20), rect(95, 70, 20, 30),
      rect(Number.NaN, 0, 20, 20), rect(0, 0, -5, 20), rect(0, 0, 0, 20), rect(0, 0, 20, Number.POSITIVE_INFINITY)];
    const original = structuredClone(input);
    assert.deepEqual(mergeHighlightRects(input, { bounds: { width: 100, height: 80 } }),
      [rect(0, 0, 65, 20), rect(95, 70, 5, 10)]);
    assert.deepEqual(input, original);
    assert.deepEqual(mergeHighlightRects(input, { bounds: { width: 0, height: 80 } }), []);
    assert.deepEqual(mergeHighlightRects([], { rotation: Number.NaN }), []);
  });

  it("never overlaps returned boxes even when unusual neighboring font extents overlap", () => {
    const result = mergeHighlightRects([
      rect(10, 0, 80, 20), rect(20, 19, 90, 20),
    ]);
    assert.equal(result.length, 3);
    for (let index = 0; index < result.length; index++)
      for (const other of result.slice(index + 1)) assert.equal(overlapArea(result[index], other), 0);
    assert.equal(result.reduce((sum, item) => sum + item.width * item.height, 0), 80 * 20 + 90 * 20 - 70);
  });

  it("is deterministic for reversed DOM rectangle order and rotated formulas", () => {
    const input = [rect(10, 110, 75, 20), rect(90, 110, 20, 20), rect(109, 103, 9, 10),
      rect(110, 125, 10, 10), rect(122, 110, 90, 20), rect(10, 150, 100, 20)];
    assert.deepEqual(mergeHighlightRects([...input].reverse()), mergeHighlightRects(input));
    assert.deepEqual(mergeHighlightRects(input.map(swap), { rotation: 90 }).map(swap), mergeHighlightRects(input));
  });

  it("reduces a bounded 500-word selection to its 25 visual lines", () => {
    const words = Array.from({ length: 500 }, (_, index) =>
      rect((index % 20) * 15, Math.floor(index / 20) * 28, 10, 20));
    const result = mergeHighlightRects(words);
    assert.equal(result.length, 25);
    assert.deepEqual(result, Array.from({ length: 25 }, (_, index) => rect(0, index * 28, 295, 20)));
  });
});
