import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { KBStore } from "../src/lib/db";
import { createBackup, exportMarkdown, restoreBackup } from "../src/lib/archive";
import { aggregateTextSegments } from "../src/lib/annotation-segments";
import { actionSchemas, snapshotSchema } from "../src/lib/validation";
import type { Annotation, AnnotationTextSegment, KBState, Paper } from "../src/lib/types";

const segments: AnnotationTextSegment[] = [
  { rects: [{ x: 0.1, y: 0.7, width: 0.4, height: 0.02 }], selectedText: "First disconnected excerpt" },
  { rects: [{ x: 0.2, y: 0.3, width: 0.5, height: 0.02 }], selectedText: "Second separated source passage" },
];
const fixture = Buffer.from("%PDF-1.7\nExplicit annotation storage fixture, not a real paper.\n%%EOF");

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-annotation-segments-"));
  const dir = path.join(root, "source");
  let store = new KBStore(dir);
  const paper = store.dispatch("paper.create", { title: "TEST · Disconnected quotations" }) as Paper;
  const attachment = store.addAttachment(paper.id, "fixture.pdf", fixture);
  const payload = {
    paperId: paper.id,
    attachmentId: attachment.id,
    kind: "highlight" as const,
    pageIndex: 2,
    pageLabel: "1",
    ...aggregateTextSegments(segments),
    textSegments: segments,
    comment: "One comment for both separated passages",
  };
  return {
    root, dir, paper, attachment, payload,
    get store() { return store; },
    restart() { store.close(); store = new KBStore(dir); },
    cleanup() { if (store.db.isOpen) store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("one multi-excerpt annotation survives restart, search and comment edits without losing its segment geometry", () => {
  const ctx = setup();
  try {
    // Clients cannot substitute false flat quotation text or coordinates.
    const created = ctx.store.dispatch("annotation.create", {
      ...ctx.payload,
      selectedText: "Incorrect flat text must not become source evidence",
      rects: [{ x: 0.01, y: 0.01, width: 0.1, height: 0.1 }],
    }) as Annotation;
    assert.deepEqual(created.textSegments, segments);
    assert.deepEqual(created.rects, aggregateTextSegments(segments).rects);
    assert.equal(created.selectedText, "First disconnected excerpt\n\nSecond separated source passage");
    assert.equal(created.pageIndex, 2);
    ctx.restart();
    assert.deepEqual(ctx.store.snapshot().annotations, [created]);
    assert.ok(ctx.store.snapshot("Second separated").searchResults?.some((result) => result.id === created.id));
    const edited = ctx.store.dispatch("annotation.update", {
      id: created.id, revision: created.revision, comment: "Only the personal comment changed",
    }) as Annotation;
    assert.deepEqual(edited.textSegments, segments);
    assert.deepEqual(edited.rects, created.rects);
    assert.equal(edited.selectedText, created.selectedText);
    const falseSummary = ctx.store.dispatch("annotation.update", {
      id: edited.id, revision: edited.revision, selectedText: "replacement evidence",
      rects: [{ x: 0.01, y: 0.01, width: 0.1, height: 0.1 }],
    }) as Annotation;
    assert.equal(falseSummary.selectedText, created.selectedText);
    assert.deepEqual(falseSummary.rects, created.rects);
    ctx.restart();
    assert.deepEqual(ctx.store.snapshot().annotations, [falseSummary]);
  } finally { ctx.cleanup(); }
});

test("segment updates recompute both legacy summary fields and reject turning grouped text into a region", () => {
  const ctx = setup();
  try {
    const created = ctx.store.dispatch("annotation.create", ctx.payload) as Annotation;
    const replacement = [segments[1]];
    const edited = ctx.store.dispatch("annotation.update", {
      id: created.id, revision: created.revision, textSegments: replacement,
    }) as Annotation;
    assert.deepEqual(edited.textSegments, replacement);
    assert.deepEqual(edited.rects, replacement[0].rects);
    assert.equal(edited.selectedText, replacement[0].selectedText);
    assert.throws(() => ctx.store.dispatch("annotation.update", {
      id: edited.id, revision: edited.revision, kind: "region",
    }), /只有文字高亮/);
    assert.deepEqual(ctx.store.snapshot().annotations, [edited]);
    // Clearing the optional grouping is explicit and remains backward compatible.
    const legacy = ctx.store.dispatch("annotation.update", {
      id: edited.id, revision: edited.revision, textSegments: null,
    }) as Annotation;
    assert.equal(legacy.textSegments, null);
    assert.equal(legacy.selectedText, replacement[0].selectedText);
  } finally { ctx.cleanup(); }
});

test("segment schemas bound total geometry and text, reject empty or region selections and detect fabricated backup summaries", () => {
  const ctx = setup();
  try {
    const schema = actionSchemas["annotation.create"];
    assert.equal(schema.safeParse({ ...ctx.payload, textSegments: Array.from({ length: 30 }, () => segments[0]) }).success, true);
    for (const textSegments of [
      [],
      Array.from({ length: 31 }, () => segments[0]),
      [{ ...segments[0], selectedText: " \n\t" }],
      [{ ...segments[0], rects: [] }],
      [{ ...segments[0], rects: [{ x: 0.9, y: 0.1, width: 0.5, height: 0.1 }] }],
      [{ ...segments[0], extraSourcePage: 100 }],
      [{ ...segments[0], selectedText: "a".repeat(60000) }, { ...segments[1], selectedText: "b".repeat(50000) }],
      [{ ...segments[0], rects: Array.from({ length: 300 }, () => segments[0].rects[0]) }, { ...segments[1], rects: Array.from({ length: 201 }, () => segments[1].rects[0]) }],
    ]) assert.equal(schema.safeParse({ ...ctx.payload, textSegments }).success, false);
    assert.equal(schema.safeParse({ ...ctx.payload, kind: "region" }).success, false);
    assert.equal(schema.safeParse({ ...ctx.payload, textSegments: [{ ...segments[0], selectedText: "a".repeat(100000) }] }).success, true);
    assert.equal(schema.safeParse({ ...ctx.payload, textSegments: [
      { ...segments[0], rects: Array.from({ length: 250 }, () => segments[0].rects[0]) },
      { ...segments[1], rects: Array.from({ length: 250 }, () => segments[1].rects[0]) },
    ] }).success, true);
    ctx.store.dispatch("annotation.create", ctx.payload);
    const snapshot = ctx.store.snapshot();
    assert.equal(snapshotSchema.safeParse(snapshot).success, true);
    for (const changes of [
      { selectedText: "false evidence" },
      { rects: [segments[0].rects[0]] },
      { kind: "region" },
    ]) {
      const changed = structuredClone(snapshot);
      Object.assign(changed.annotations[0], changes);
      assert.equal(snapshotSchema.safeParse(changed).success, false);
    }
  } finally { ctx.cleanup(); }
});

test("additive migration reads an actual old SQLite schema without rewriting original annotation fields", () => {
  const ctx = setup();
  try {
    const { textSegments: _segments, ...single } = ctx.payload;
    const created = ctx.store.dispatch("annotation.create", single) as Annotation;
    ctx.store.close();
    const legacy = new DatabaseSync(path.join(ctx.dir, "knowledge.sqlite"));
    legacy.exec("ALTER TABLE annotations DROP COLUMN text_segments");
    const before = legacy.prepare("SELECT * FROM annotations").get();
    legacy.close();
    // restart() cannot close an already-closed connection, so migrate separately.
    const migrated = new KBStore(ctx.dir);
    try {
      const after = migrated.db.prepare("SELECT * FROM annotations").get()!;
      const { text_segments, ...originalColumns } = after;
      assert.equal(text_segments, null);
      assert.deepEqual(originalColumns, { ...before });
      const restored = migrated.snapshot().annotations[0];
      assert.equal(restored.id, created.id);
      assert.equal(restored.revision, created.revision);
      assert.equal(restored.updatedAt, created.updatedAt);
      assert.equal(restored.selectedText, created.selectedText);
      assert.equal(restored.textSegments, null);
    } finally { migrated.close(); }
  } finally {
    ctx.cleanup();
  }
});

test("full backup restore preserves discontinuous quotes, Markdown source references and original attachment identity", () => {
  const ctx = setup();
  let restored: KBStore | undefined;
  try {
    const annotation = ctx.store.dispatch("annotation.create", ctx.payload) as Annotation;
    const note = ctx.store.snapshot().notes[0];
    const body = `Both excerpts support my comment.\n\n[Original source](kb://annotation/${annotation.id})`;
    ctx.store.dispatch("note.update", { id: note.id, revision: note.revision, body });
    const expected = ctx.store.snapshot();
    const report = restoreBackup(createBackup(ctx.store), ctx.root);
    restored = new KBStore(report.restoredDirectory);
    assert.deepEqual(restored.snapshot(), expected);
    assert.deepEqual(restored.snapshot().annotations[0].textSegments, segments);
    assert.equal(restored.snapshot().annotations[0].attachmentId, ctx.attachment.id);
    assert.equal(readFileSync(restored.attachmentPath(ctx.attachment.id)).compare(fixture), 0);
    const markdown = exportMarkdown(restored.snapshot(), note.id);
    assert.match(markdown, /First disconnected excerpt/);
    assert.match(markdown, /Second separated source passage/);
    assert.match(markdown, /物理页 3/);
    assert.match(markdown, new RegExp(annotation.id));
    assert.match(readFileSync(path.join(report.restoredDirectory, "notes", `${note.id}.md`), "utf8"), /Both excerpts/);
  } finally { restored?.close(); ctx.cleanup(); }
});

test("old backups without textSegments still restore and new backups reject inconsistent source geometry", () => {
  const ctx = setup();
  let restored: KBStore | undefined;
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
    return JSON.stringify(value);
  };
  interface Manifest { snapshot: KBState; snapshotSha256: string }
  const repack = (manifest: Manifest) => {
    manifest.snapshotSha256 = createHash("sha256").update(canonical(manifest.snapshot)).digest("hex");
    return gzipSync(JSON.stringify(manifest));
  };
  try {
    const { textSegments: _segments, ...single } = ctx.payload;
    const old = ctx.store.dispatch("annotation.create", single) as Annotation;
    const manifest = JSON.parse(gunzipSync(createBackup(ctx.store)).toString("utf8")) as Manifest;
    delete manifest.snapshot.annotations[0].textSegments;
    const report = restoreBackup(repack(manifest), ctx.root);
    restored = new KBStore(report.restoredDirectory);
    assert.equal(restored.snapshot().annotations[0].textSegments, null);
    assert.equal(restored.snapshot().annotations[0].id, old.id);
    assert.equal(restored.snapshot().annotations[0].selectedText, old.selectedText);
    // Valid envelope hash does not allow conflicting quote/geometry metadata.
    manifest.snapshot.annotations[0].textSegments = segments;
    manifest.snapshot.annotations[0].selectedText = "fabricated flat quote";
    assert.throws(() => restoreBackup(repack(manifest), ctx.root), /文字选段与批注汇总不一致/);
  } finally { restored?.close(); ctx.cleanup(); }
});
