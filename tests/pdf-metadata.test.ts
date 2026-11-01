import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  inspectPdfFile,
  parsePdfMetadata,
  type PdfMetadataInput,
  type PdfMetadataTextItem,
} from "../src/lib/import/pdf-metadata";

const item = (
  str: string,
  x: number,
  y: number,
  size = 10,
): PdfMetadataTextItem => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width: str.length * size * 0.5,
  height: size,
});
const input = (
  overrides: Partial<PdfMetadataInput> = {},
): PdfMetadataInput => ({
  filename: "x9.pdf",
  info: {},
  pageView: [0, 0, 600, 800],
  items: [],
  ...overrides,
});

test("PDF embedded title and authors beat an arbitrary filename; explicit publication date beats CreationDate", () => {
  const result = parsePdfMetadata(
    input({
      info: {
        Title: "TEST FIXTURE: Local Research Metadata",
        Author: "Alice Example; Bob Example",
        CreationDate: "D:20261028000000Z",
      },
      items: [
        item("Published: 2024", 50, 600),
        item("doi: 10.0000/test-fixture-metadata", 50, 575),
      ],
    }),
  );
  assert.equal(result.metadata.title, "TEST FIXTURE: Local Research Metadata");
  assert.deepEqual(result.metadata.authors, ["Alice Example", "Bob Example"]);
  assert.equal(result.metadata.year, 2024);
  assert.equal(result.metadata.doi, "10.0000/test-fixture-metadata");
  assert.match(result.sources.title ?? "", /内嵌/);
  assert.match(result.sources.year ?? "", /首页明确/);
});

test("garbage LaTeX/software metadata is ignored in favor of first-page font layout", () => {
  const result = parsePdfMetadata(
    input({
      info: { Title: "LaTeX document", Author: "Microsoft Word" },
      items: [
        item("A Conservative Reading Method", 50, 700, 18),
        item("Alice Example; Bob Example", 50, 660, 11),
        item("Published: 2023", 50, 630, 10),
        item("Abstract", 50, 590, 11),
        item("The body cites results from 1998 and 2017.", 50, 560),
      ],
    }),
  );
  assert.equal(result.metadata.title, "A Conservative Reading Method");
  assert.deepEqual(result.metadata.authors, ["Alice Example", "Bob Example"]);
  assert.equal(result.metadata.year, 2023);
  assert.match(result.sources.title ?? "", /候选/);
  assert.match(result.warnings.join(" "), /推断/);
});

test("an embedded title copied from a random filename does not override a clear first-page title", () => {
  const result = parsePdfMetadata(
    input({
      filename: "9df4ab7e88a11c6f.pdf",
      info: { Title: "9df4ab7e88a11c6f" },
      items: [
        item("A Conservative Reading Method", 50, 700, 18),
        item("Alice Example; Bob Example", 50, 660, 11),
        item("Abstract", 50, 590, 11),
        item("The abstract uses a smaller font than the title.", 50, 560),
      ],
    }),
  );
  assert.equal(result.metadata.title, "A Conservative Reading Method");
  assert.match(result.sources.title ?? "", /首页/);
  assert.match(result.warnings.join(" "), /文件名副本/);
});

test("creation dates and arbitrary body citation years do not become publication years", () => {
  const result = parsePdfMetadata(
    input({
      info: {
        Title: "A Useful Embedded Title",
        CreationDate: "D:20261028000000Z",
      },
      items: [
        item("Abstract", 50, 700, 12),
        item("Prior work (2018) improves on 1995 and 2021 results.", 50, 670),
      ],
    }),
  );
  assert.equal(result.metadata.year, undefined);
  assert.match(result.warnings.join(" "), /创建日期不等于/);
});

test("XMP publication dates and creators are explicit sources, not font guesses", () => {
  const result = parsePdfMetadata(
    input({
      xmp: {
        "dc:title": "An XMP Research Title",
        "dc:creator": ["Alice Example", "Bob Example"],
        "prism:publicationDate": "2022-06-08",
      },
    }),
  );
  assert.equal(result.metadata.year, 2022);
  assert.deepEqual(result.metadata.authors, ["Alice Example", "Bob Example"]);
  assert.match(result.sources.year ?? "", /prism:publicationDate/);
});

test("filename is only the last fallback, and its year remains an explicitly labelled candidate", () => {
  const result = parsePdfMetadata(
    input({ filename: "2020__A_Study_of_Stability.pdf" }),
  );
  assert.equal(result.metadata.title, "2020 A Study of Stability");
  assert.equal(result.metadata.year, 2020);
  assert.match(result.sources.year ?? "", /候选年份/);
  const ambiguous = parsePdfMetadata(
    input({ filename: "Study_2019_2020.pdf" }),
  );
  assert.equal(ambiguous.metadata.year, undefined);
});

test("arXiv IDs retain version and label their year as preprint rather than formal publication", () => {
  const result = parsePdfMetadata(
    input({ items: [item("arXiv:2106.09685v2 [cs.CL] 16 Oct 2021", 50, 70)] }),
  );
  assert.equal(result.metadata.arxivId, "2106.09685");
  assert.equal(result.metadata.arxivVersion, 2);
  assert.equal(result.metadata.year, 2021);
  assert.match(result.sources.year ?? "", /不是正式出版年/);
});

test("a filename year never overrides the preprint year identified inside the PDF", () => {
  const result = parsePdfMetadata(
    input({
      filename: "2024_random_download.pdf",
      items: [item("arXiv:2106.09685v2 [cs.CL] 16 Oct 2021", 50, 70)],
    }),
  );
  assert.equal(result.metadata.year, 2021);
  assert.match(result.sources.year ?? "", /arXiv/);
  assert.doesNotMatch(result.sources.year ?? "", /文件名/);
});

test("parenthesized DOIs preserve balanced syntax while sentence punctuation is removed", () => {
  const result = parsePdfMetadata(
    input({ items: [item("doi: 10.0000/(test-fixture)).", 50, 600)] }),
  );
  assert.equal(result.metadata.doi, "10.0000/(test-fixture)");
});

test("ambiguous first-page identifiers are not silently treated as this paper", () => {
  const result = parsePdfMetadata(
    input({
      items: [
        item("doi: 10.0000/first-fixture and 10.0000/second-fixture", 50, 600),
        item("arXiv:2106.09685 and arXiv:2201.00001", 50, 575),
      ],
    }),
  );
  assert.equal(result.metadata.doi, undefined);
  assert.equal(result.metadata.arxivId, undefined);
  assert.equal(result.metadata.year, undefined);
  assert.match(result.warnings.join(" "), /多个不同 DOI/);
  assert.match(result.warnings.join(" "), /多个不同 arXiv/);
  const explicit = parsePdfMetadata(
    input({
      xmp: { "prism:doi": "10.0000/primary-fixture" },
      items: [item("10.0000/other-fixture", 50, 600)],
    }),
  );
  assert.equal(explicit.metadata.doi, "10.0000/primary-fixture");
  assert.match(explicit.sources.doi ?? "", /XMP/);
});

test("the browser entry point rejects Node use without importing browser PDF.js", async () => {
  await assert.rejects(
    inspectPdfFile(new File(["%PDF-"], "x9.pdf", { type: "application/pdf" })),
    /浏览器/,
  );
});

test("a small real PDF fixture with arbitrary filename supplies embedded data and page date; writes browser upload fixture", async () => {
  const document = await PDFDocument.create();
  document.setTitle("TEST FIXTURE: PDF Metadata");
  document.setAuthor("Alice Example; Bob Example");
  document.setCreationDate(new Date("2026-10-28T00:00:00Z"));
  document.setModificationDate(new Date("2026-10-28T00:00:00Z"));
  document.setCreator("AIlib synthetic metadata test");
  document.setProducer("AIlib synthetic metadata test");
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([420, 600]);
  for (const [str, y, size] of [
    ["SYNTHETIC TEST DOCUMENT", 565, 9],
    ["TEST FIXTURE: PDF Metadata", 510, 18],
    ["Alice Example; Bob Example", 475, 11],
    ["Published: 2024 (synthetic test date)", 440, 11],
    ["doi: 10.0000/test-fixture-metadata", 415, 10],
    ["This is not a real publication or citation.", 365, 10],
  ] as const)
    page.drawText(str, { x: 30, y, size, font });
  const bytes = await document.save({ useObjectStreams: false });
  await fs.mkdir("test-results", { recursive: true });
  await fs.writeFile("test-results/x9.pdf", bytes);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: true,
  });
  try {
    const parsed = await task.promise;
    const embedded = await parsed.getMetadata();
    const first = await parsed.getPage(1);
    const content = await first.getTextContent();
    const result = parsePdfMetadata(
      input({
        info: embedded.info as Record<string, unknown>,
        pageView: first.view,
        items: content.items.flatMap((run) => ("str" in run ? [run] : [])),
      }),
    );
    assert.equal(result.metadata.title, "TEST FIXTURE: PDF Metadata");
    assert.deepEqual(result.metadata.authors, ["Alice Example", "Bob Example"]);
    assert.equal(result.metadata.year, 2024);
    assert.equal(result.metadata.doi, "10.0000/test-fixture-metadata");
  } finally {
    await task.destroy();
  }
});

test("optional real LoRA PDF identifies title and all authors despite an arbitrary filename", async (context) => {
  const filename = path.resolve("tests/fixtures/lora-2106.09685v2.pdf");
  try {
    await fs.access(filename);
  } catch {
    context.skip("Optional official arXiv PDF unavailable");
    return;
  }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(await fs.readFile(filename)),
    disableFontFace: true,
    useSystemFonts: true,
  });
  try {
    const document = await task.promise;
    const embedded = await document.getMetadata();
    const page = await document.getPage(1);
    const text = await page.getTextContent();
    const result = parsePdfMetadata(
      input({
        info: embedded.info as Record<string, unknown>,
        pageView: page.view,
        items: text.items.flatMap((run) => ("str" in run ? [run] : [])),
      }),
    );
    assert.match(
      result.metadata.title ?? "",
      /^LORA: LOW-RANK ADAPTATION OF LARGE LANGUAGE MODELS$/,
    );
    assert.equal(result.metadata.authors?.length, 8);
    assert.ok(result.metadata.authors?.includes("Edward Hu"));
    assert.ok(result.metadata.authors?.includes("Weizhu Chen"));
    assert.equal(result.metadata.arxivId, "2106.09685");
    assert.equal(result.metadata.arxivVersion, 2);
    assert.equal(result.metadata.year, 2021);
    assert.match(result.sources.year ?? "", /不是正式出版年/);
  } finally {
    await task.destroy();
  }
});
