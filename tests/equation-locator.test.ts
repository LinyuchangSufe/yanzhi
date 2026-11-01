import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type { BibliographyPage, PdfTextChunk } from "../src/lib/pdf-reference/bibliography";
import { equationCandidates } from "../src/lib/pdf-reference/equation-locator";
import { pdfTextChunks, pdfTextItems } from "../src/lib/pdf-reference/text-items";

function chunk(str: string, x: number, y: number, width = str.length * 5): PdfTextChunk {
  return { str, x, y, width, height: 10, fontName: "fixture" };
}
function page(chunks: PdfTextChunk[]): BibliographyPage {
  return { pageNumber: 4, pageWidth: 600, chunks };
}

describe("equation text geometry", () => {
  it("keeps a weak isolated match as a candidate and rejects unsupported labels", () => {
    const weak = page([chunk("x + y = 1", 100, 600), chunk("(1)", 430, 600)]);
    assert.equal(equationCandidates(weak, "1")[0]?.confidence, "candidate");
    assert.deepEqual(equationCandidates(weak, "../1"), []);
    assert.deepEqual(equationCandidates({ ...weak, pageWidth: Number.NaN }, "1"), []);
    assert.deepEqual(equationCandidates(page([]), "1"), []);
  });

  it("does not turn inline mentions, numbered lists, page numbers, or bibliography mentions into formulas", () => {
    for (const chunks of [
      [chunk("As x = 1", 100, 600), chunk("(1)", 540, 600)],
      [chunk("We refer to the result in", 100, 600), chunk("(1)", 540, 600)],
      [chunk("(1)", 50, 600), chunk("The first contribution", 75, 600)],
      [chunk("(1)", 300, 20)],
      [chunk("References", 50, 720), chunk("x + y = 1", 100, 600), chunk("(1)", 540, 600)],
      [chunk("x + y = 1 (1) is discussed in this sentence", 50, 600)],
    ]) assert.deepEqual(equationCandidates(page(chunks), "1"), []);
  });

  it("reassembles split tags, respects parentheses, and retains missing-metadata compatibility", () => {
    const split = page([
      { str: "x + y = 1", x: 100, y: 600, width: 80 },
      { str: "(", x: 535, y: 600, width: 3 },
      { str: "A.", x: 538, y: 600, width: 9 },
      { str: "1", x: 547, y: 600, width: 5 },
      { str: ")", x: 552, y: 600, width: 3 },
    ]);
    const matches = equationCandidates(split, "A.1");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].confidence, "high");
    assert.equal(matches[0].target.pageNumber, 4);
    assert.equal(matches[0].target.top, 620);
    assert.deepEqual(equationCandidates(split, "1"), []);
    assert.equal(equationCandidates(page([chunk("x = 1", 100, 600), chunk("（1）", 540, 600)]), "1").length, 1);
  });

  it("never silently chooses one of two genuine occurrences", () => {
    const matches = equationCandidates(page([
      chunk("x = 1", 100, 600), chunk("(1)", 540, 600),
      chunk("y = 2", 100, 400), chunk("(1)", 540, 400),
    ]), "1");
    assert.equal(matches.length, 2);
    assert.deepEqual(matches.map((match) => match.confidence), ["high", "high"]);
    assert.deepEqual(matches.map((match) => match.target.top), [620, 420]);
  });
});

function paragraphs(page: PDFPage, font: PDFFont, x: number, width: number) {
  const text = "Several researchers study related models in this text.";
  // Fit a prose line exactly to the fixture's column width without adding a new font dependency.
  const size = width / font.widthOfTextAtSize(text, 1);
  for (const y of [740, 725, 710]) page.drawText(text, { x, y, font, size });
}

async function fixture() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const one = pdf.addPage([600, 800]);
  paragraphs(one, font, 50, 500);
  one.drawText("x + y = 1", { x: 150, y: 600, size: 11, font });
  one.drawText("(1)", { x: 535, y: 600, size: 11, font });
  const split = pdf.addPage([600, 800]);
  paragraphs(split, font, 50, 500);
  split.drawText("z = x * y", { x: 150, y: 600, size: 11, font });
  let cursor = 530;
  for (const text of ["(", "A", ".", "1", ")"]) {
    split.drawText(text, { x: cursor, y: 600, size: 11, font });
    cursor += font.widthOfTextAtSize(text, 11);
  }
  const two = pdf.addPage([600, 800]);
  paragraphs(two, font, 40, 240);
  paragraphs(two, font, 315, 240);
  two.drawText("a + b = 1", { x: 80, y: 600, size: 10, font });
  two.drawText("(2)", { x: 266, y: 600, size: 10, font });
  two.drawText("c + d = 2", { x: 350, y: 600, size: 10, font });
  two.drawText("(3)", { x: 542, y: 600, size: 10, font });
  // A prose mention in the opposite column at the same baseline must not poison the left equation.
  two.drawText("The result (2) remains valid.", { x: 315, y: 570, size: 10, font });
  two.drawText("a = b", { x: 80, y: 570, size: 10, font });
  two.drawText("(4)", { x: 266, y: 570, size: 10, font });
  const multi = pdf.addPage([600, 800]);
  paragraphs(multi, font, 50, 500);
  multi.drawText("L(x) = x * x +", { x: 150, y: 620, size: 11, font });
  multi.drawText("y * y", { x: 180, y: 600, size: 11, font });
  multi.drawText("(5)", { x: 535, y: 600, size: 11, font });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: await pdf.save(), useSystemFonts: true, disableFontFace: true });
  return { task, document: await task.promise };
}

describe("actual PDF.js extraction from original equation fixtures", () => {
  it("locates whole and split equation tags, appendix tags, two columns, and multi-line geometry", async () => {
    const { task, document } = await fixture();
    try {
      const extracted: BibliographyPage[] = [];
      for (let n = 1; n <= document.numPages; n++) {
        const pdfPage = await document.getPage(n);
        extracted.push({ pageNumber: n, pageWidth: pdfPage.view[2] - pdfPage.view[0], chunks: pdfTextChunks(await pdfTextItems(pdfPage)) });
      }
      const first = equationCandidates(extracted[0], "1");
      assert.equal(first.length, 1);
      assert.equal(first[0].confidence, "high");
      assert.equal(first[0].target.pageNumber, 1);
      assert.ok((first[0].target.top ?? 0) >= 613);
      assert.equal(equationCandidates(extracted[1], "A.1")[0]?.confidence, "high");
      assert.deepEqual(equationCandidates(extracted[1], "1"), []);
      for (const [label, side] of [["2", "left"], ["3", "right"], ["4", "left"]] as const) {
        const matches = equationCandidates(extracted[2], label);
        assert.equal(matches.length, 1, label);
        assert.equal(matches[0].confidence, "high", label);
        if (side === "left") assert.ok((matches[0].target.left ?? 600) < 300, label);
        else assert.ok((matches[0].target.left ?? 0) > 300, label);
      }
      const multi = equationCandidates(extracted[3], "5");
      assert.equal(multi.length, 1);
      assert.ok((multi[0].target.top ?? 0) >= 632);
      assert.equal(multi[0].target.left, 150);
      assert.equal(extracted[0].chunks.some((item) => typeof item.height === "number" && typeof item.fontName === "string"), true);
      assert.deepEqual(extracted.flatMap((p) => equationCandidates(p, "99")), []);
    } finally { await task.destroy(); }
  });
});
