import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  normalizedToViewportRect,
  viewportToNormalizedRect,
} from "../src/components/pdf/geometry";

const fixtures = path.resolve("tests/fixtures");
const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-8);

// Uses the actual PDF.js parser and PageViewport. The legacy Node entry point
// installs its real @napi-rs/canvas DOMMatrix polyfill when needed. These are
// document/coordinate contracts, not a claim of browser text-selection testing.
async function openPdf(filename: string) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = await fs.readFile(path.join(fixtures, filename));
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: true,
  });
  return { document: await task.promise, task, bytes };
}

describe("real PDF reader contracts", () => {
  it("reads the synthetic fixture, distinct page labels, real outline and selected-text source", async () => {
    const { document, task, bytes } = await openPdf("reading-fixture.pdf");
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(fixtures, "reading-fixture.json"), "utf8"),
      ) as { sha256: string };
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        manifest.sha256,
      );
      assert.equal(document.numPages, 3);
      assert.deepEqual(await document.getPageLabels(), ["i", "1", "2"]);
      const page = await document.getPage(2);
      assert.equal(page.pageNumber - 1, 1); // printed "1" is physical index 1.
      const text = (await page.getTextContent()).items
        .flatMap((item) => ("str" in item ? [item.str] : []))
        .join(" ");
      assert.match(text, /TEST FIXTURE/);
      assert.match(text, /Select this exact sentence/);
      assert.match(text, /SYNTHETIC FORMULA REGION/);
      const outline = await document.getOutline();
      assert.equal(outline.length, 3);
      assert.match(outline[1].title, /physical page 2/);
      const destination = outline[1].dest;
      assert.ok(Array.isArray(destination));
      assert.equal(await document.getPageIndex(destination[0]), 1);
    } finally {
      await task.destroy();
    }
  });

  it("reprojects a region on the actual 90-degree page through zoom and additional rotation", async () => {
    const { document, task } = await openPdf("reading-fixture.pdf");
    try {
      const page = await document.getPage(3);
      assert.equal(page.rotate, 90);
      const canonical = {
        x: 70 / 600,
        y: 350 / 800,
        width: 460 / 600,
        height: 120 / 800,
      };
      for (const rotation of [0, 90, 180, 270]) {
        for (const scale of [0.5, 1, 2]) {
          const viewport = page.getViewport({
            scale,
            rotation: (page.rotate + rotation) % 360,
          });
          const screen = normalizedToViewportRect(
            canonical,
            viewport,
            page.view,
          );
          const restored = viewportToNormalizedRect(
            screen,
            viewport,
            page.view,
          );
          close(restored.x, canonical.x);
          close(restored.y, canonical.y);
          close(restored.width, canonical.width);
          close(restored.height, canonical.height);
          assert.ok(screen.width > 0 && screen.height > 0);
        }
      }
    } finally {
      await task.destroy();
    }
  });

  it("parses the optionally downloaded, unmodified LoRA v2 open-access PDF", async (context) => {
    try {
      await fs.access(path.join(fixtures, "lora-2106.09685v2.pdf"));
    } catch {
      context.skip(
        "Optional arXiv PDF was not downloaded; see tests/fixtures/README.md.",
      );
      return;
    }
    const { document, task } = await openPdf("lora-2106.09685v2.pdf");
    try {
      assert.ok(document.numPages > 5);
      const page = await document.getPage(1);
      const text = (await page.getTextContent()).items
        .flatMap((item) => ("str" in item ? [item.str] : []))
        .join(" ");
      // Small caps are separate text runs, so do not assume title word spacing.
      assert.match(text, /LoRA/);
      assert.match(text, /2106\.09685v2/);
      assert.match(text, /Hu/);
      assert.ok((await document.getPage(document.numPages)).view[2] > 0);
    } finally {
      await task.destroy();
    }
  });
});
