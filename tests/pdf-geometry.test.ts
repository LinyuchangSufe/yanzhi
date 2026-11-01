import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clampPageIndex,
  clipPixelRect,
  normalizedToViewportRect,
  viewportToNormalizedRect,
  type ViewportTransform,
} from "../src/components/pdf/geometry";

const close = (actual: number, expected: number) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-8,
    `${actual} should equal ${expected}`,
  );

// PDF.js viewport's four orthogonal transforms, with a nonzero CropBox origin.
// Keep these independent from the persistence helpers so an origin/flip error
// cannot pass by using the same implementation twice.
function viewport(rotation: number, scale: number): ViewportTransform {
  return {
    convertToViewportPoint(x, y) {
      switch (rotation) {
        case 90:
          return [(y - 20) * scale, (x - 10) * scale];
        case 180:
          return [(610 - x) * scale, (y - 20) * scale];
        case 270:
          return [(820 - y) * scale, (610 - x) * scale];
        default:
          return [(x - 10) * scale, (820 - y) * scale];
      }
    },
    convertToPdfPoint(x, y) {
      switch (rotation) {
        case 90:
          return [10 + y / scale, 20 + x / scale];
        case 180:
          return [610 - x / scale, 20 + y / scale];
        case 270:
          return [610 - y / scale, 820 - x / scale];
        default:
          return [10 + x / scale, 820 - y / scale];
      }
    },
  };
}

describe("PDF annotation coordinates", () => {
  const cropBox = [10, 20, 610, 820];
  const persisted = { x: 0.1, y: 0.2, width: 0.25, height: 0.05 };

  it("stores canonical y-up coordinates instead of top-down screen pixels", () => {
    const result = viewportToNormalizedRect(
      { x: 120, y: 1200, width: 300, height: 80 },
      viewport(0, 2),
      cropBox,
    );
    close(result.x, 0.1);
    close(result.y, 0.2);
    close(result.width, 0.25);
    close(result.height, 0.05);
  });

  for (const rotation of [0, 90, 180, 270]) {
    for (const scale of [0.5, 1, 2, 3.25]) {
      it(`restores the same region at rotation ${rotation} and scale ${scale}`, () => {
        const transform = viewport(rotation, scale);
        const shown = normalizedToViewportRect(persisted, transform, cropBox);
        const saved = viewportToNormalizedRect(shown, transform, cropBox);
        close(saved.x, persisted.x);
        close(saved.y, persisted.y);
        close(saved.width, persisted.width);
        close(saved.height, persisted.height);
      });
    }
  }

  it("maps a region selected on a rotated page back to the unrotated page", () => {
    const selected = viewportToNormalizedRect(
      { x: 320, y: 120, width: 80, height: 300 },
      viewport(90, 2),
      cropBox,
    );
    const upright = normalizedToViewportRect(selected, viewport(0, 1), cropBox);
    close(upright.x, 60);
    close(upright.y, 600);
    close(upright.width, 150);
    close(upright.height, 40);
  });

  it("clips drag and selection edges to the page, never adjacent UI", () => {
    assert.deepEqual(
      clipPixelRect({ x: -5, y: 10, width: 30, height: 90 }, 50, 50),
      { x: 0, y: 10, width: 25, height: 40 },
    );
    assert.equal(
      clipPixelRect({ x: 55, y: 10, width: 30, height: 90 }, 50, 50),
      null,
    );
    const saved = viewportToNormalizedRect(
      { x: -100, y: -100, width: 2000, height: 2000 },
      viewport(0, 1),
      cropBox,
    );
    assert.deepEqual(saved, { x: 0, y: 0, width: 1, height: 1 });
  });

  it("uses zero-based physical indices independently of page labels", () => {
    assert.equal(clampPageIndex(3, 7), 3);
    assert.equal(clampPageIndex(20, 7), 6);
    assert.equal(clampPageIndex(-1, 7), 0);
    assert.equal(clampPageIndex(Number.NaN, 7), 0);
  });
});
