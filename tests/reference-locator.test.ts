import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { locatePdfReference, type ReferencePageCache } from "../src/lib/pdf-reference/resolver";

async function fixture(duplicateEquation = false, outline?: string[]) {
  const file = await PDFDocument.create();
  const regular = await file.embedFont(StandardFonts.Helvetica);
  const bold = await file.embedFont(StandardFonts.HelveticaBold);
  const pages = [file.addPage([600, 800]), file.addPage([600, 800])];
  pages.forEach((page, index) => {
    page.drawText(`ORIGINAL SOFTWARE TEST FIXTURE ${index + 1}`, { x: 50, y: 760, size: 10, font: regular });
    for (const y of [730, 710, 690]) page.drawText("This paragraph is synthetic test material, with enough prose to identify the text margins.", { x: 50, y, size: 11, font: regular });
  });
  pages[0].drawText("2 Methods", { x: 50, y: 630, size: 16, font: bold });
  pages[0].drawText("2. A numbered list item is not the chapter heading.", { x: 65, y: 580, size: 11, font: regular });
  pages[0].drawText("See Eq. (1) for the synthetic test equation.", { x: 50, y: 550, size: 11, font: regular });
  for (const page of duplicateEquation ? pages : [pages[1]]) {
    page.drawText("x + y = 1", { x: 170, y: 460, size: 13, font: regular });
    page.drawText("(1)", { x: 480, y: 460, size: 13, font: regular });
  }
  for (const page of pages) page.drawText("Figure 3: Synthetic conflicting caption.", { x: 50, y: 350, size: 11, font: regular });
  // An unusual placement is a candidate, never an automatic jump.
  pages[0].drawText("z + w = 2", { x: 60, y: 250, size: 13, font: regular });
  pages[0].drawText("(2)", { x: 310, y: 250, size: 13, font: regular });
  if (outline?.length) {
    const parent = file.context.obj({ Type: "Outlines", Count: outline.length });
    const parentRef = file.context.register(parent);
    const items = outline.map((title, index) => file.context.obj({ Title: PDFString.of(title), Parent: parentRef,
      Dest: [pages[index % pages.length].ref, PDFName.of("XYZ"), 50, 630, null] }));
    const refs = items.map((item) => file.context.register(item));
    items.forEach((item, index) => {
      if (index) item.set(PDFName.of("Prev"), refs[index - 1]);
      if (index < refs.length - 1) item.set(PDFName.of("Next"), refs[index + 1]);
    });
    parent.set(PDFName.of("First"), refs[0]); parent.set(PDFName.of("Last"), refs.at(-1)!);
    file.catalog.set(PDFName.of("Outlines"), parentRef);
  }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: await file.save(), useSystemFonts: true, disableFontFace: true });
  return { task, document: await task.promise };
}

test("unanchored formula tags locate real equation geometry while prose mentions are ignored", async () => {
  const { task, document } = await fixture();
  try {
    const destinations = await document.getDestinations();
    assert.equal(destinations instanceof Map ? destinations.size : Object.keys(destinations).length, 0);
    const result = await locatePdfReference(document, { kind: "equation", label: "1" }, new Map());
    assert.equal(result.target?.pageNumber, 2);
    assert.ok((result.target?.top ?? 0) > 460);
    assert.equal(result.candidates, undefined);
    const section = await locatePdfReference(document, { kind: "section", label: "2" }, new Map());
    assert.equal(section.target?.pageNumber, 1);
    assert.ok((section.target?.top ?? 0) > 630);
  } finally { await task.destroy(); }
});

test("conflicting captions return real candidate pages and text instead of blocking the reader", async () => {
  const { task, document } = await fixture();
  try {
    const result = await locatePdfReference(document, { kind: "figure", label: "3" }, new Map());
    assert.equal(result.target, null);
    assert.deepEqual(result.candidates?.map((item) => item.target.pageNumber), [1, 2]);
    assert.ok(result.candidates?.every((item) => item.source === "caption" && item.text.includes("Figure 3")));
    assert.match(result.reason ?? "", /候选/);
  } finally { await task.destroy(); }
});

test("repeated equation numbers and unique uncertain placements require explicit candidate confirmation", async () => {
  const { task, document } = await fixture(true);
  try {
    const repeated = await locatePdfReference(document, { kind: "equation", label: "1" }, new Map());
    assert.equal(repeated.target, null);
    assert.equal(repeated.candidates?.length, 2);
    const uncertain = await locatePdfReference(document, { kind: "equation", label: "2" }, new Map());
    assert.equal(uncertain.target, null);
    assert.equal(uncertain.candidates?.length, 1);
    assert.equal(uncertain.candidates?.[0].confidence, "candidate");
  } finally { await task.destroy(); }
});

test("real outline destinations support custom anchors, duplicate titles, and exact numbering boundaries", async () => {
  for (const titles of [["Section 2 Methods"], ["Section 2 Methods", "Section 2 Other methods"], ["Section 1st steps"]]) {
    const { task, document } = await fixture(false, titles);
    try {
      const label = titles[0].startsWith("Section 1st") ? "1" : "2";
      const result = await locatePdfReference(document, { kind: "section", label }, new Map());
      if (label === "1") { assert.equal(result.target, null); assert.equal(result.candidates?.length ?? 0, 0); }
      else if (titles.length === 1) assert.equal(result.target?.pageNumber, 1);
      else { assert.equal(result.target, null); assert.equal(result.candidates?.length, 2); assert.equal(result.candidates?.[1].source, "outline"); }
    } finally { await task.destroy(); }
  }
});

test("limited scans and cancellation never imply a unique source", async () => {
  const { task, document } = await fixture();
  try {
    const cache: ReferencePageCache = new Map();
    const sample = await document.getPage(2);
    const limited = {
      numPages: 251, getDestination: async () => null, getOutline: async () => null,
      getPage: async () => sample,
    } as unknown as PDFDocumentProxy;
    // Reuse positioned PDF text only on one page; every other page is empty.
    for (let number = 2; number <= 250; number++) cache.set(number, Promise.resolve({ pageNumber: number, pageWidth: 600, chunks: [] }));
    const result = await locatePdfReference(limited, { kind: "equation", label: "1" }, cache);
    assert.equal(result.target, null); assert.equal(result.candidates?.length, 1);
    assert.match(result.reason ?? "", /范围有限/);
    const cancelled = await locatePdfReference(document, { kind: "equation", label: "1" }, new Map(), () => true);
    assert.deepEqual(cancelled, { target: null });
  } finally { await task.destroy(); }
});

test("cancellation during anchor resolution and truncated outlines never produce an automatic target", async () => {
  let cancelled = false;
  const interrupted = {numPages: 2, getDestination: async () => {cancelled = true; return [0, {name: "XYZ"}, 50, 500];}} as unknown as PDFDocumentProxy;
  assert.deepEqual(await locatePdfReference(interrupted, {kind: "equation", label: "1"}, new Map(), () => cancelled), {target: null});
  const {task, document} = await fixture();
  try {
    const outline = [...Array.from({length: 5000}, () => ({title: "Other entry"})), {title: "Section 2 Other methods", dest: [1, {name: "XYZ"}, 50, 500]}];
    const bounded = {numPages: document.numPages, getDestination: async () => null,
      getOutline: async () => outline, getPage: document.getPage.bind(document)} as unknown as PDFDocumentProxy;
    const result = await locatePdfReference(bounded, {kind: "section", label: "2"}, new Map());
    assert.equal(result.target, null); assert.equal(result.candidates?.length, 1);
    assert.match(result.reason ?? "", /范围有限/);
  } finally {await task.destroy();}
});

test("a decimal outline label cannot impersonate its shorter figure number", async () => {
  const {task, document} = await fixture(false, ["Figure 3.1 Full decimal caption"]);
  try {
    const result = await locatePdfReference(document, {kind: "figure", label: "3"}, new Map());
    assert.equal(result.target, null);
    assert.equal(result.candidates?.length, 2);
    assert.ok(result.candidates?.every((candidate) => candidate.source === "caption"));
  } finally {await task.destroy();}
});
