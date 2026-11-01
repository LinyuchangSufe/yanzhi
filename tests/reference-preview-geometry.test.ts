import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { referencePreviewGeometry } from "../src/components/pdf/reference-preview-geometry";

test("candidate previews retain real PDF targets across page edges, zoom and rotation", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await fs.readFile("tests/fixtures/reading-fixture.pdf"));
  const task = pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true });
  try {
    const document = await task.promise;
    const page = await document.getPage(3);
    const [left, bottom, right, top] = page.view;
    for (const rotation of [0, 90, 180, 270]) {
      for (const scale of [0.15, 0.75, 1.5]) {
        const viewport = page.getViewport({ rotation, scale });
        for (const position of [[left + 1, bottom + 1], [right - 1, top - 1], [(left + right) / 2, (top + bottom) / 2]]) {
          for (const source of ["equation", "heading"]) {
            const [x, y] = position;
            const crop = referencePreviewGeometry(viewport, page.view, {
              pageNumber: 3, kind: "XYZ", left: x, top: y, zoom: null,
            }, source);
            assert.ok(crop);
            const [, targetY] = viewport.convertToViewportPoint(x, y);
            assert.ok(targetY >= crop.sourceY && targetY <= crop.sourceY + crop.height,
              `${rotation} degrees at ${scale}: target remains in the crop`);
            assert.equal(crop.width, Math.ceil(viewport.width), "retain the formula body and margin number together");
            assert.ok(crop.sourceY >= 0 && crop.sourceY + crop.height <= Math.ceil(viewport.height));
            assert.ok(crop.height > 0);
          }
        }
      }
    }
  } finally { await task.destroy(); }
});

test("candidate previews tolerate missing coordinates and reject unreadable page dimensions", () => {
  const target = { pageNumber: 1, kind: "Fit", left: null, top: null, zoom: null };
  const crop = referencePreviewGeometry({ width: 600, height: 800, convertToViewportPoint: (_x, y) => [0, 800 - y] },
    [0, 0, 600, 800], target, "outline");
  assert.equal(crop?.sourceY, 0);
  for (const size of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(referencePreviewGeometry({ width: size, height: 800, convertToViewportPoint: () => [0, 0] },
      [0, 0, 600, 800], target, "outline"), null);
  }
});
