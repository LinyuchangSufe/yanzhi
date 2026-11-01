import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
} from "pdf-lib";

// Synthetic fixture only. No paper claims, user library records or AI output.
// Fixed metadata and standard fonts make repeated generation byte-reproducible.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "tests/fixtures");
const document = await PDFDocument.create();
const fixedTime = new Date("2026-10-28T00:00:00.000Z");
document.setTitle("TEST FIXTURE - Research Reader Coordinate Contract");
document.setAuthor("AIlib local test suite");
document.setSubject("Synthetic test material, not a research publication");
document.setCreator("AIlib make-fixture.mjs");
document.setProducer("pdf-lib fixture generator");
document.setCreationDate(fixedTime);
document.setModificationDate(fixedTime);
const regular = await document.embedFont(StandardFonts.Helvetica);
const bold = await document.embedFont(StandardFonts.HelveticaBold);
const mono = await document.embedFont(StandardFonts.Courier);
const pages = [
  document.addPage([600, 800]),
  document.addPage([600, 800]),
  document.addPage([600, 800]),
];
const labels = ["i", "1", "2"];
const titles = [
  "Cover - physical page 1",
  "Reading text - physical page 2",
  "Rotated content - physical page 3",
];
for (let index = 0; index < pages.length; index++) {
  const page = pages[index];
  page.drawRectangle({
    x: 0,
    y: 755,
    width: 600,
    height: 45,
    color: rgb(0.9, 0.93, 0.9),
  });
  page.drawText("TEST FIXTURE - NOT A RESEARCH PAPER", {
    x: 40,
    y: 772,
    font: bold,
    size: 13,
    color: rgb(0.2, 0.35, 0.24),
  });
  page.drawText(titles[index], { x: 48, y: 710, font: bold, size: 20 });
  page.drawText(
    `Physical page index: ${index}; printed page label: ${labels[index]}`,
    { x: 48, y: 678, font: regular, size: 12 },
  );
  page.drawText(
    "This document is generated exclusively for reader verification.",
    { x: 48, y: 638, font: regular, size: 12 },
  );
  page.drawText(
    "Select this exact sentence to create a persistent text highlight.",
    { x: 48, y: 612, font: regular, size: 12 },
  );
  page.drawText(
    "A saved annotation must return to this attachment and physical page.",
    { x: 48, y: 588, font: regular, size: 11 },
  );
  page.drawRectangle({
    x: 70,
    y: 350,
    width: 460,
    height: 120,
    borderWidth: 1.5,
    borderColor: rgb(0.25, 0.45, 0.65),
    color: rgb(0.95, 0.97, 0.99),
  });
  page.drawText("SYNTHETIC FORMULA REGION", {
    x: 90,
    y: 440,
    font: bold,
    size: 12,
  });
  page.drawText("x_(t+1) = x_t - eta_t * g_t", {
    x: 90,
    y: 409,
    font: mono,
    size: 14,
  });
  page.drawText("E[||x_(t+1)-x*||^2] <= C / (t+1)", {
    x: 90,
    y: 380,
    font: mono,
    size: 13,
  });
  page.drawText(
    "Equations above are test strings, not validated mathematical claims.",
    { x: 48, y: 310, font: regular, size: 10 },
  );
  page.drawText(labels[index], { x: 292, y: 35, font: regular, size: 12 });
}
pages[2].setRotation(degrees(90));
document.catalog.set(
  PDFName.of("PageLabels"),
  document.context.obj({
    Nums: [0, { S: PDFName.of("r"), St: 1 }, 1, { S: PDFName.of("D"), St: 1 }],
  }),
);
const outline = document.context.obj({
  Type: PDFName.of("Outlines"),
  Count: 3,
});
const outlineRef = document.context.register(outline);
const items = pages.map((page, index) =>
  document.context.obj({
    Title: PDFString.of(titles[index]),
    Parent: outlineRef,
    Dest: [page.ref, PDFName.of("FitH"), 750],
  }),
);
const refs = items.map((item) => document.context.register(item));
items.forEach((item, index) => {
  if (index > 0) item.set(PDFName.of("Prev"), refs[index - 1]);
  if (index < items.length - 1) item.set(PDFName.of("Next"), refs[index + 1]);
});
outline.set(PDFName.of("First"), refs[0]);
outline.set(PDFName.of("Last"), refs[refs.length - 1]);
document.catalog.set(PDFName.of("Outlines"), outlineRef);
const bytes = await document.save({
  useObjectStreams: false,
  addDefaultPage: false,
});
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, "reading-fixture.pdf"), bytes);
const sha256 = createHash("sha256").update(bytes).digest("hex");
await fs.writeFile(
  path.join(output, "reading-fixture.json"),
  `${JSON.stringify({ kind: "synthetic-test-fixture", generator: "scripts/make-fixture.mjs", sha256, physicalPages: 3, pageLabels: labels, rotations: [0, 0, 90], formulaRegionPdfCoordinates: { x: 70, y: 350, width: 460, height: 120 }, metadataTime: fixedTime.toISOString() }, null, 2)}\n`,
);
console.log(
  `Generated synthetic PDF fixture: ${bytes.length} bytes; SHA256 ${sha256}`,
);
