import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { BibliographyPage } from "../src/lib/pdf-reference/bibliography";
import { headingCandidates } from "../src/lib/pdf-reference/heading-locator";
import { pdfTextChunks, pdfTextItems } from "../src/lib/pdf-reference/text-items";

/** Original software-test document: no borrowed papers, AI output or bookmarks. */
async function fixture() {
  const file = await PDFDocument.create();
  const regular = await file.embedFont(StandardFonts.Helvetica);
  const bold = await file.embedFont(StandardFonts.HelveticaBold);
  const pages = [file.addPage([600, 800]), file.addPage([600, 800]), file.addPage([600, 800])];
  const draw = (page: number, text: string, x: number, y: number, size = 10, strong = false) =>
    pages[page].drawText(text, { x, y, size, font: strong ? bold : regular });
  for (let number = 0; number < 3; number++) {
    for (const y of [750, 738, 726, 714]) draw(number, "Ordinary text identifies the regular paragraph font and normal line spacing.", 50, y);
  }
  draw(0, "1. Introduction .......... 2", 50, 650);
  draw(0, "3. Algorithm   3", 50, 630);
  draw(0, "1. A numbered list item is not the chapter heading.", 65, 570);
  draw(0, "Its continuation uses the same paragraph typography.", 76, 558);
  // A bold list lead-in followed by prose used to be split into extra columns.
  draw(0, "3.", 312, 490);
  draw(0, "Pessimism in Reduced Space:", 323, 490, 10, true);
  draw(0, "Finally we construct the", 460, 490);
  draw(0, "confidence region using the next part of the numbered algorithm.", 323, 478);
  draw(1, "1. Introduction", 50, 650, 14, true);
  draw(1, "The first paragraph starts below a genuine section heading.", 50, 628);
  draw(1, "2 Methods.", 50, 570, 14, true);
  draw(1, "The trailing period does not hide the heading typography.", 50, 548);
  draw(2, "3. Algorithm", 50, 650, 14, true);
  draw(2, "This paragraph belongs to the third section.", 50, 628);
  // Some PDFs expose duplicate visible/OCR text at effectively one coordinate.
  draw(2, "3. Algorithm", 50.2, 650.2, 14, true);
  draw(2, "Figure 3. Synthetic overview caption.", 50, 550);
  draw(2, "Figure 3 shows the result in the surrounding prose.", 50, 500);
  draw(2, "Figure 30: A different counter must not match.", 50, 450);
  draw(2, "Algorithm 4: Original test procedure.", 50, 400, 10, true);
  draw(2, "Theorem 5. Every test uses original synthetic text.", 50, 350, 10, true);
  draw(2, "Appendix A. Supplementary details", 50, 280, 14, true);
  draw(2, "This paragraph belongs to the test appendix.", 50, 258);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: await file.save(), useSystemFonts: true, disableFontFace: true });
  const document = await task.promise;
  const textPages: BibliographyPage[] = [];
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    textPages.push({ pageNumber: number, pageWidth: page.view[2] - page.view[0], chunks: pdfTextChunks(await pdfTextItems(page)) });
  }
  return { task, textPages };
}

test("real PDF geometry separates numbered prose and TOC entries from true chapter headings", async () => {
  const { task, textPages } = await fixture();
  try {
    for (const [label, expectedPage] of [["1", 2], ["3", 3]] as const) {
      const candidates = textPages.flatMap((page) => headingCandidates(page, { kind: "section", label }));
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].confidence, "high");
      assert.equal(candidates[0].target.pageNumber, expectedPage);
      assert.ok(Math.abs((candidates[0].target.top ?? 0) - 660) < 1);
    }
    assert.equal(headingCandidates(textPages[1], { kind: "section", label: "2" })[0]?.confidence, "high");
  } finally { await task.destroy(); }
});

test("real captions support printed periods, exact counters, algorithms, theorems and appendices", async () => {
  const { task, textPages } = await fixture();
  try {
    for (const [kind, label] of [["figure", "3"], ["algorithm", "4"], ["theorem", "5"], ["appendix", "A"]] as const) {
      const candidates = headingCandidates(textPages[2], { kind, label });
      assert.equal(candidates.length, 1, `${kind} ${label}`);
      assert.equal(candidates[0].confidence, "high");
      assert.equal(candidates[0].target.pageNumber, 3);
    }
    assert.deepEqual(headingCandidates(textPages[2], { kind: "figure", label: "30.1" }), []);
    assert.deepEqual(headingCandidates(textPages[2], { kind: "equation", label: "3" }), []);
  } finally { await task.destroy(); }
});

test("plain short numbered text without typography stays uncertain and does not invent a unique heading", () => {
  const page: BibliographyPage = { pageNumber: 8, pageWidth: 600, chunks: [
    { str: "4 Preliminary Results", x: 50, y: 600, width: 180 },
    { str: "The ordinary text continues here.", x: 50, y: 588, width: 250 },
  ] };
  assert.equal(headingCandidates(page, { kind: "section", label: "4" })[0]?.confidence, "candidate");
  assert.deepEqual(headingCandidates(page, { kind: "section", label: "4.1" }), []);
});

test("Chinese captions and chapter headings share the conservative typography requirements", () => {
  const page: BibliographyPage = { pageNumber: 2, pageWidth: 600, chunks: [
    { str: "这段正文用来识别普通文字所用的字号和字体，随后给出章节标题。", x: 50, y: 700, width: 400, height: 10, fontName: "regular" },
    { str: "这段正文延续相同的行距和文字样式，明确标题上下文。", x: 50, y: 688, width: 400, height: 10, fontName: "regular" },
    { str: "第2章 方法", x: 50, y: 630, width: 100, height: 14, fontName: "bold" },
    { str: "这是标题后面的正文，介绍本节所使用的方法。", x: 50, y: 608, width: 300, height: 10, fontName: "regular" },
    { str: "图3：方法流程", x: 50, y: 500, width: 100, height: 10, fontName: "regular" },
  ] };
  assert.equal(headingCandidates(page, { kind: "section", label: "2" })[0]?.confidence, "high");
  assert.equal(headingCandidates(page, { kind: "figure", label: "3" })[0]?.confidence, "high");
});
