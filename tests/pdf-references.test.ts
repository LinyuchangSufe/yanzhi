import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFNull, PDFString, StandardFonts } from "pdf-lib";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import { buildBibliography, matchCitation, type BibliographyPage } from "../src/lib/pdf-reference/bibliography";
import { findCitations } from "../src/lib/pdf-reference/citations";
import { captionPattern, destinationCandidates, findPaperRefs } from "../src/lib/pdf-reference/paper-refs";
import { parseReferenceRequest, referenceMatchesScope, referenceRouting } from "../src/lib/pdf-reference/events";
import { locatePdfReference, referencePage, scanBibliography, type ReferencePageCache } from "../src/lib/pdf-reference/resolver";
import { resolvePdfDestination } from "../src/lib/pdf-reference/destinations";
import { remarkPaperReferences } from "../src/lib/pdf-reference/remark-references";

const page = (lines: [string, number][]): BibliographyPage => ({
  pageNumber: 3, pageWidth: 600,
  chunks: lines.map(([str, y]) => ({ str, y, x: 50, width: 450 })),
});

describe("Papernook reference modules adapted to the local reader", () => {
  it("requires an actual reference section before numeric hotspots are actionable", () => {
    const body = page([["An interval [0, 1] is not a bibliography", 600], ["[1] Sample text", 560], ["[2] More text", 540]]);
    assert.equal(buildBibliography([body]), null);
    const bibliography = buildBibliography([page([
      ["References", 700], ["[1] Smith, J. 2020. One paper.", 660], ["[2] Brown, A. 2021. Two papers.", 620],
    ])]);
    assert.ok(bibliography);
    assert.equal(bibliography.style, "numbered");
    const matches = findCitations("See [2, 9] for details.").map((citation) => matchCitation(bibliography, citation.key));
    assert.match(matches[0]?.text ?? "", /Brown/);
    assert.equal(matches[1], null);
    assert.equal(matchCitation(bibliography, { kind: "authorYear", surname: "Smith", year: "2020", suffix: null })?.number, 1);
  });

  it("resolves author-year surnames and rejects ambiguous years", () => {
    const bibliography = buildBibliography([page([
      ["Bibliography", 750], ["Smith, J. 2020a. First work", 700], ["Journal of tests.", 688],
      ["Smith, J. 2020b. Another work", 660], ["Journal of tests.", 648],
      ["Brown, A. 2021. A third work", 620], ["Journal of tests.", 608],
    ])]);
    assert.ok(bibliography);
    assert.equal(bibliography.style, "author-year");
    const citations = findCitations("Smith et al. (2020a), Brown 2021, Smith (2020)");
    assert.equal(citations.length, 3);
    assert.match(matchCitation(bibliography, citations[0].key)?.text ?? "", /First work/);
    assert.match(matchCitation(bibliography, citations[1].key)?.text ?? "", /third work/);
    assert.equal(matchCitation(bibliography, citations[2].key), null);
    assert.equal(matchCitation(bibliography, { kind: "numeric", number: 1 }), null);
  });

  it("finds Chinese and English locators, preserving exact visible offsets", () => {
    const text = "见图 3、公式（5）、第2.1节，以及 Figure 4、Eq. (A.1) 和 Section 2。";
    const refs = findPaperRefs(text);
    assert.deepEqual(refs.map((ref) => [ref.kind, ref.label]), [
      ["figure", "3"], ["equation", "5"], ["section", "2.1"],
      ["figure", "4"], ["equation", "A.1"], ["section", "2"],
    ]);
    assert.equal(text.slice(refs[1].start, refs[1].end), "公式（5）");
    assert.deepEqual(findPaperRefs("Figure 3 of [12], Sec. 2 in Smith et al."), []);
    assert.ok(captionPattern({ kind: "figure", label: "3" })?.test("图3：方法框架"));
    assert.equal(captionPattern({ kind: "figure", label: "3" })?.test("Figure 30: Another caption"), false);
    assert.equal(captionPattern({ kind: "figure", label: "3" })?.test("Figure 3.1 Decimal caption"), false);
    assert.equal(captionPattern({ kind: "algorithm", label: "1" })?.test("Algorithm 1.1 Decimal caption"), false);
    assert.equal(captionPattern({ kind: "figure", label: "3.1" })?.test("Figure 3.1: Decimal caption"), true);
    assert.equal(captionPattern({ kind: "section", label: "2" })?.test("2.1 Next section"), false);
    assert.deepEqual(destinationCandidates({ kind: "section", label: "2.1" }), ["subsection.2.1", "section.2.1"]);
  });

  it("scopes reference requests to one paper and PDF version", () => {
    const request = parseReferenceRequest({ paperId: "paper-1", attachmentId: "version-1", kind: "figure", label: "3" });
    assert.ok(request);
    assert.equal(referenceMatchesScope(request, { paperId: "paper-1", attachmentId: "version-1" }), true);
    assert.equal(referenceMatchesScope(request, { paperId: "paper-2", attachmentId: "version-1" }), false);
    assert.equal(referenceMatchesScope(request, { paperId: "paper-1", attachmentId: "version-2" }), false);
    const attachments = [{ id: "version-1", paperId: "paper-1", status: "available" }];
    assert.equal(referenceRouting(request, { paperId: "paper-1", attachmentId: "version-2" }, attachments), "switch");
    assert.equal(referenceRouting(request, { paperId: "paper-2", attachmentId: "version-2" }, attachments), "ignore");
    assert.equal(referenceRouting(request, { paperId: "paper-1", attachmentId: "version-1" }, attachments), "current");
    assert.equal(referenceRouting(request, { paperId: "paper-1", attachmentId: "version-2" }, []), "missing");
    assert.equal(referenceRouting(request, { paperId: "paper-1", attachmentId: "version-2" }, [{ ...attachments[0], status: "missing" }]), "missing");
    assert.equal(referenceRouting(request, { paperId: "paper-1", attachmentId: "version-2" }, [{ ...attachments[0], paperId: "paper-2" }]), "missing");
    assert.equal(parseReferenceRequest({ paperId: "paper-1", kind: "url", label: "3" }), null);
    assert.equal(parseReferenceRequest({ paperId: "paper-1", kind: "figure", label: "../../../data" }), null);
    assert.equal(parseReferenceRequest({ paperId: "paper-1", attachmentId: 123, kind: "figure", label: "3" }), null);
  });

  it("decorates prose while leaving code, math and existing hyperlinks untouched", async () => {
    const processor = unified().use(remarkParse).use(remarkMath).use(remarkPaperReferences);
    const body = "Figure 3 and 图2\n\n`Figure 4` $Section 5$ [Figure 6](https://example.test)\n\n```\nFigure 7\n```";
    const tree = await processor.run(processor.parse(body));
    const text = JSON.stringify(tree);
    assert.match(text, /#paper-ref:figure:3/);
    assert.match(text, /#paper-ref:figure:2/);
    assert.doesNotMatch(text, /#paper-ref:figure:[467]|#paper-ref:section:5/);
    assert.match(text, /https:\/\/example.test/);
  });

  it("rejects out-of-range or malformed PDF destinations", async () => {
    const document = { numPages: 2, getDestination: async () => null, getPageIndex: async () => 4 };
    assert.equal(await resolvePdfDestination(document, [-1, { name: "XYZ" }, 0, 0]), null);
    assert.equal(await resolvePdfDestination(document, [{ num: 1, gen: 0 }, { name: "XYZ" }, 0, 0]), null);
    assert.equal(await resolvePdfDestination(document, [1.5, { name: "XYZ" }, 0, 0]), null);
    assert.equal((await resolvePdfDestination(document, [1, { name: "XYZ" }, 30, 500]))?.pageNumber, 2);
    assert.equal((await resolvePdfDestination(document, [1, { name: "FitH" }, 500]))?.top, 500);
    assert.equal((await resolvePdfDestination(document, [1, { name: "FitR" }, 30, 100, 200, 500]))?.top, 500);
  });
});

async function syntheticPdf(duplicateCaption = false) {
  const file = await PDFDocument.create();
  const font = await file.embedFont(StandardFonts.Helvetica);
  const first = file.addPage([600, 800]);
  first.drawText("Read Figure 3 and Eq. (5), citing [1, 2].", { x: 50, y: 720, size: 12, font });
  const second = file.addPage([600, 800]);
  second.drawText("2 Methods", { x: 50, y: 710, size: 14, font });
  second.drawText("Figure 3: Synthetic method overview.", { x: 50, y: 600, size: 12, font });
  const references = file.addPage([600, 800]);
  for (const [text, y] of [["References", 720], ["[1] Smith, J. 2020. A synthetic paper.", 680], ["[2] Brown, A. 2021. Another synthetic paper.", 650], ["[3] Green, T. 2022. Tests only.", 620]] as const)
    references.drawText(text, { x: 50, y, size: 12, font });
  if (duplicateCaption) references.drawText("Figure 3: A second conflicting caption.", { x: 50, y: 550, size: 12, font });
  file.catalog.set(PDFName.of("Names"), file.context.obj({ Dests: { Names: [
    PDFString.of("equation.5"), [second.ref, PDFName.of("XYZ"), 80, 500, PDFNull],
  ] } }));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: await file.save(), useSystemFonts: true, disableFontFace: true });
  return { task, document: await task.promise };
}

describe("real PDF.js reference resolution over generated documents", () => {
  it("previews real bibliography entries and locates real named equation/figure/section sources", async () => {
    const { task, document } = await syntheticPdf();
    const cache: ReferencePageCache = new Map();
    try {
      const bibliography = await scanBibliography(document, cache);
      assert.ok(bibliography);
      assert.equal(bibliography.entries.length, 3);
      assert.equal(matchCitation(bibliography, { kind: "numeric", number: 2 })?.pageNumber, 3);
      assert.match(matchCitation(bibliography, { kind: "numeric", number: 2 })?.text ?? "", /Brown/);
      const equation = await locatePdfReference(document, { kind: "equation", label: "5" }, cache);
      assert.deepEqual(equation.target, { pageNumber: 2, kind: "XYZ", left: 80, top: 500, zoom: null });
      const figure = await locatePdfReference(document, { kind: "figure", label: "3" }, cache);
      assert.equal(figure.target?.pageNumber, 2);
      assert.equal(figure.target?.top, 610);
      const section = await locatePdfReference(document, { kind: "section", label: "2" }, cache);
      assert.equal(section.target?.pageNumber, 2);
      assert.equal(section.target?.top, 720);
      const firstPage = referencePage(document, 1, cache);
      assert.equal(firstPage, referencePage(document, 1, cache));
    } finally { await task.destroy(); }
  });

  it("keeps the current location when a number is absent, ambiguous, or cannot be verified", async () => {
    const { task, document } = await syntheticPdf(true);
    try {
      const cache: ReferencePageCache = new Map();
      const ambiguous = await locatePdfReference(document, { kind: "figure", label: "3" }, cache);
      assert.equal(ambiguous.target, null);
      assert.match(ambiguous.reason ?? "", /多处/);
      const missing = await locatePdfReference(document, { kind: "figure", label: "99" }, cache);
      assert.equal(missing.target, null);
      assert.match(missing.reason ?? "", /未找到/);
      const unanchored = await locatePdfReference(document, { kind: "equation", label: "99" }, cache);
      assert.equal(unanchored.target, null);
      assert.match(unanchored.reason ?? "", /未找到.*公式编号/);
      const cancelled = await locatePdfReference(document, { kind: "figure", label: "3" }, cache, () => true);
      assert.equal(cancelled.target, null);
    } finally { await task.destroy(); }
  });
});
