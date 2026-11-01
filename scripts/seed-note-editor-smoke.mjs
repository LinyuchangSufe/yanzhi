// Prepare an isolated browser acceptance library. No AI, external requests, or server startup.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const cwd = fileURLToPath(new URL("..", import.meta.url));
process.chdir(cwd);
const requested =
  process.argv[2] ||
  process.env.KB_NOTE_EDITOR_BASE_URL ||
  "http://127.0.0.1:3115";
const endpoint = new URL(requested);
assert.equal(
  endpoint.protocol,
  "http:",
  "Only a local HTTP acceptance server is allowed",
);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname),
  "Refusing a non-loopback server",
);
assert.ok(
  endpoint.port && endpoint.port !== "3000",
  "Refusing the user library on port 3000 or an implicit port",
);
assert.ok(
  !endpoint.username &&
    !endpoint.password &&
    endpoint.pathname === "/" &&
    !endpoint.search &&
    !endpoint.hash,
  "Supply a plain loopback origin without credentials, paths or parameters",
);
const base = endpoint.origin;
async function json(route, options = {}) {
  const response = await fetch(base + route, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: { Origin: base, ...options.headers },
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
const post = (action, payload) =>
  json("/api/kb", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
const initial = await json("/api/kb");
for (const key of [
  "papers",
  "notes",
  "attachments",
  "topics",
  "annotations",
  "aiContents",
  "relations",
  "tags",
  "noteImages",
]) {
  assert.equal(
    (initial[key] ?? []).length,
    0,
    `Refusing to seed a nonempty library (${key})`,
  );
}

// Original 640 × 240 RGB diagram: three simple cards and arrows, no research data.
const width = 640,
  height = 240;
const pixels = Buffer.alloc(width * height * 3);
function pixel(x, y, color) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const offset = (y * width + x) * 3;
  for (let channel = 0; channel < 3; channel++)
    pixels[offset + channel] = color[channel];
}
function rect(x, y, w, h, color) {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) pixel(xx, yy, color);
}
function circle(cx, cy, radius, color) {
  for (let y = cy - radius; y <= cy + radius; y++)
    for (let x = cx - radius; x <= cx + radius; x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) pixel(x, y, color);
}
const glyphs = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
};
function text(value, x, y, scale, color) {
  for (const letter of value) {
    for (const [row, line] of glyphs[letter].entries())
      for (const [col, bit] of Array.from(line).entries())
        if (bit === "1")
          rect(x + col * scale, y + row * scale, scale, scale, color);
    x += 6 * scale;
  }
}
rect(0, 0, width, height, [245, 249, 246]);
text("TEST", 28, 16, 2, [62, 88, 74]);
const colors = [
  [198, 225, 209],
  [190, 216, 237],
  [210, 229, 219],
];
for (let card = 0; card < 3; card++) {
  const x = 24 + card * 208;
  rect(x, 46, 176, 166, colors[card]);
  circle(x + 88, 95, 24, [255, 255, 255]);
  rect(x + 76, 83, 24, 24, card === 1 ? [65, 122, 165] : [71, 123, 96]);
  const label = ["LOCAL", "IMAGE", "NOTES"][card];
  text(label, x + 44, 135, 3, [44, 77, 65]);
  rect(x + 36, 173, 104, 5, [255, 255, 255]);
  rect(x + 46, 185, 84, 4, [255, 255, 255]);
  if (card < 2) {
    rect(x + 183, 123, 18, 4, [100, 132, 117]);
    for (let step = 0; step < 8; step++)
      rect(x + 194 + step, 118 + step, 1, 15 - step * 2, [100, 132, 117]);
  }
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function chunk(name, data) {
  const type = Buffer.from(name),
    checksumInput = Buffer.concat([type, data]);
  let crc = 0xffffffff;
  for (const byte of checksumInput)
    crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  type.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return output;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const rows = Buffer.alloc((width * 3 + 1) * height);
for (let row = 0; row < height; row++)
  pixels.copy(
    rows,
    row * (width * 3 + 1) + 1,
    row * width * 3,
    (row + 1) * width * 3,
  );
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(rows)),
  chunk("IEND", Buffer.alloc(0)),
]);
const resultDir = path.resolve("test-results");
fs.mkdirSync(resultDir, { recursive: true });
const imagePath = path.join(resultDir, "note-editor-fixture.png");
fs.writeFileSync(imagePath, png);
const invalidImagePath = path.join(resultDir, "invalid-note-image.svg");
fs.writeFileSync(
  invalidImagePath,
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><text x="20" y="40">TEST ONLY: SVG must be rejected</text></svg>\n',
);

const paperAResponse = await post("paper.create", {
  title: "TEST · Online Learning with Dependent Data",
  authors: ["Ada Example"],
  year: 2024,
  doi: "10.1234/note-editor-smoke",
  readingStatus: "read",
  abstract: "仅用于本地编辑器验收的合成条目，不是真实论文，不含研究结论。",
});
const paperA = paperAResponse.result;
const paperB = (
  await post("paper.create", {
    title: "TEST · Scalar Gradient Methods",
    authors: ["Bo Sample"],
    year: 2023,
    readingStatus: "unread",
    abstract: "仅用于区分已读与未读候选项的合成条目。",
  })
).result;
const pdfPath = path.resolve("tests/fixtures/reading-fixture.pdf");
const pdfBytes = fs.readFileSync(pdfPath);
const attachmentForm = new FormData();
attachmentForm.set("paperId", paperA.id);
attachmentForm.set(
  "file",
  new Blob([pdfBytes], { type: "application/pdf" }),
  "reading-fixture.pdf",
);
const attachment = (
  await json("/api/kb/attachment", { method: "POST", body: attachmentForm })
).result;
const topicResponse = await post("topic.create", {
  title: "TEST · 图片与文献引用",
  description: "独立浏览器验收材料：测试插图、搜索引用以及补录文献。",
});
const topic = topicResponse.result;
const topicNote = topicResponse.state.notes.find(
  (note) => note.id === topic.noteId,
);
const topicBody =
  "这是一段独立的中文测试笔记，用于验证研究问题中的图片与文献引用。这里没有真实研究数据，也不调用 AI。\n\n## 已读文献\n\n\n";
await post("note.update", {
  id: topicNote.id,
  revision: topicNote.revision,
  body: topicBody,
});
const idea = (
  await post("note.create", {
    title: "TEST · 阅读记录",
    purpose: "idea",
    body: "这是一段独立的中文阅读记录，用于验证笔记编辑器。原始段落应在插图、选择文献以及取消补录后完整保留。\n\n## 已读文献\n\n\n",
  })
).result;
const finalState = await json("/api/kb");
assert.equal(finalState.papers.length, 2);
assert.equal(finalState.topics.length, 1);
assert.equal(
  (finalState.noteImages ?? []).length,
  0,
  "Images should be inserted by the browser acceptance flow",
);
assert.equal(
  finalState.relations.filter((relation) => relation.purpose === "reference")
    .length,
  0,
  "References should be inserted by the browser acceptance flow",
);
const report = {
  seededAt: new Date().toISOString(),
  baseUrl: base,
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  workingTreeDirty: Boolean(
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  ),
  fixturePolicy:
    "Synthetic TEST metadata and original diagram only; no real research results or citations; no AI inference or external requests.",
  paperAId: paperA.id,
  paperBId: paperB.id,
  paperANoteId: paperAResponse.state.notes.find(
    (note) =>
      note.purpose === "paper" &&
      paperAResponse.state.relations.some(
        (relation) =>
          relation.fromId === note.id && relation.toId === paperA.id,
      ),
  )?.id,
  attachmentId: attachment.id,
  topicId: topic.id,
  topicNoteId: topic.noteId,
  ideaId: idea.id,
  ideaNoteId: idea.id,
  paths: { imagePath, invalidImagePath, pdfPath },
  testDataDirectory: process.env.KB_NOTE_SMOKE_DATA_DIR || null,
  image: {
    width,
    height,
    sha256: createHash("sha256").update(png).digest("hex"),
    byteSize: png.length,
  },
  counts: {
    papers: finalState.papers.length,
    notes: finalState.notes.length,
    topics: finalState.topics.length,
    noteImages: finalState.noteImages?.length ?? 0,
  },
};
fs.writeFileSync(
  path.join(resultDir, "note-editor-browser.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
