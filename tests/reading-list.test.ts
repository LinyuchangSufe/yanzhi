import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { createBackup, restoreBackup } from "../src/lib/archive";
import { KBStore, StoreError } from "../src/lib/db";
import { actionSchemas, snapshotSchema } from "../src/lib/validation";
import type { KBState, Paper, ReadingListOperation } from "../src/lib/types";

// Original storage fixtures only; no model calls or external research content.
const pdf = Buffer.from("%PDF-1.7\nTEST independent reading queue\n%%EOF");
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-reading-list-"));
  const dir = path.join(root, "source");
  let store = new KBStore(dir);
  return {
    root,
    dir,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new KBStore(dir);
    },
    cleanup() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function paper(store: KBStore, fields = {}) {
  return store.dispatch("paper.create", {
    title: "TEST reading queue",
    ...fields,
  }) as Paper;
}
function batch(
  store: KBStore,
  papers: Paper[],
  operation: ReadingListOperation,
) {
  return store.dispatch("paper.reading-list", {
    papers: papers.map(({ id, revision }) => ({ id, revision })),
    operation,
  }) as { papers: Paper[]; changed: number };
}
function conflict(error: unknown) {
  return error instanceof StoreError && error.status === 409;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

test("new papers are unread outside the queue unless explicitly selected; SQL snapshots expose booleans", () => {
  const ctx = setup();
  try {
    const plain = paper(ctx.store);
    const explicitUnread = paper(ctx.store, { readingStatus: "unread" });
    const selected = paper(ctx.store, { inReadingList: true });
    const finished = paper(ctx.store, {
      readingStatus: "read",
      inReadingList: true,
    });
    assert.equal(plain.readingStatus, "unread");
    assert.equal(plain.inReadingList, false);
    assert.equal(explicitUnread.inReadingList, false);
    assert.equal(selected.inReadingList, true);
    assert.equal(finished.inReadingList, false);
    assert.equal(
      ctx.store.db
        .prepare("SELECT in_reading_list FROM papers WHERE id=?")
        .get(selected.id)?.in_reading_list,
      1,
    );
    ctx.restart();
    for (const entry of ctx.store.snapshot().papers)
      assert.equal(typeof entry.inReadingList, "boolean");
    assert.equal(
      ctx.store.snapshot().papers.find((entry) => entry.id === plain.id)
        ?.inReadingList,
      false,
    );
    assert.throws(
      () =>
        ctx.store.db
          .prepare("UPDATE papers SET in_reading_list=2 WHERE id=?")
          .run(plain.id),
      /CHECK/,
    );
  } finally {
    ctx.cleanup();
  }
});

test("batch add is selective and preserves every legacy reading status", () => {
  const ctx = setup();
  try {
    const unread = paper(ctx.store);
    const reading = paper(ctx.store, { readingStatus: "reading" });
    const read = paper(ctx.store, { readingStatus: "read" });
    const excluded = paper(ctx.store, { title: "TEST not selected" });
    const result = batch(ctx.store, [unread, reading, read], "add");
    assert.equal(result.changed, 3);
    assert.deepEqual(
      result.papers.map((entry) => [
        entry.readingStatus,
        entry.inReadingList,
        entry.revision,
      ]),
      [
        ["unread", true, 2],
        ["reading", true, 2],
        ["read", true, 2],
      ],
    );
    assert.deepEqual(
      ctx.store.snapshot().papers.find((entry) => entry.id === excluded.id),
      excluded,
    );
    const before = ctx.store.snapshot();
    const repeated = batch(ctx.store, result.papers, "add");
    assert.equal(repeated.changed, 0);
    assert.deepEqual(repeated.papers, result.papers);
    assert.deepEqual(ctx.store.snapshot(), before);
  } finally {
    ctx.cleanup();
  }
});

test("removing from the queue never changes the reading progress or removes library records", () => {
  const ctx = setup();
  try {
    const unread = paper(ctx.store, { inReadingList: true });
    const reading = paper(ctx.store, {
      readingStatus: "reading",
      inReadingList: true,
    });
    const read = batch(ctx.store, [paper(ctx.store, { readingStatus: "read" })], "add").papers[0];
    const result = batch(ctx.store, [unread, reading, read], "remove");
    assert.equal(result.changed, 3);
    assert.deepEqual(
      result.papers.map((entry) => [
        entry.readingStatus,
        entry.inReadingList,
        entry.deletedAt,
      ]),
      [
        ["unread", false, null],
        ["reading", false, null],
        ["read", false, null],
      ],
    );
    assert.equal(ctx.store.snapshot().papers.length, 3);
    const before = ctx.store.snapshot();
    assert.equal(batch(ctx.store, result.papers, "remove").changed, 0);
    assert.deepEqual(ctx.store.snapshot(), before);
    ctx.restart();
    assert.ok(
      ctx.store
        .snapshot()
        .papers.every((entry) => entry.inReadingList === false),
    );
  } finally {
    ctx.cleanup();
  }
});

test("legacy read, reading and unread API operations retain their compatibility behavior", () => {
  const ctx = setup();
  try {
    let current = paper(ctx.store);
    current = batch(ctx.store, [current], "reading").papers[0];
    assert.deepEqual(
      [current.readingStatus, current.inReadingList],
      ["reading", true],
    );
    current = batch(ctx.store, [current], "unread").papers[0];
    assert.deepEqual(
      [current.readingStatus, current.inReadingList],
      ["unread", true],
    );
    current = batch(ctx.store, [current], "read").papers[0];
    assert.deepEqual(
      [current.readingStatus, current.inReadingList],
      ["read", false],
    );
    current = batch(ctx.store, [current], "unread").papers[0];
    assert.deepEqual(
      [current.readingStatus, current.inReadingList],
      ["unread", false],
    );
  } finally {
    ctx.cleanup();
  }
});

test("ordinary metadata updates preserve membership and marking read also removes it", () => {
  const ctx = setup();
  try {
    let current = paper(ctx.store, { inReadingList: true });
    current = ctx.store.dispatch("paper.update", {
      id: current.id,
      revision: current.revision,
      title: "TEST edited title",
    }) as Paper;
    assert.equal(current.inReadingList, true);
    current = ctx.store.dispatch("paper.update", {
      id: current.id,
      revision: current.revision,
      readingStatus: "read",
      inReadingList: true,
    }) as Paper;
    assert.deepEqual(
      [current.readingStatus, current.inReadingList],
      ["read", false],
    );
    current = ctx.store.dispatch("paper.update", {
      id: current.id,
      revision: current.revision,
      inReadingList: true,
    }) as Paper;
    assert.deepEqual(
      [current.readingStatus, current.inReadingList],
      ["unread", true],
    );
    current = ctx.store.dispatch("paper.update", {
      id: current.id,
      revision: current.revision,
      inReadingList: false,
    }) as Paper;
    assert.deepEqual(
      [current.readingStatus, current.inReadingList],
      ["unread", false],
    );
  } finally {
    ctx.cleanup();
  }
});

test("a stale revision anywhere rolls back the entire batch, including no-op records", () => {
  const ctx = setup();
  try {
    const first = paper(ctx.store);
    const second = paper(ctx.store);
    const changed = ctx.store.dispatch("paper.update", {
      id: second.id,
      revision: second.revision,
      title: "TEST concurrent edit",
    }) as Paper;
    const before = ctx.store.snapshot();
    assert.throws(() => batch(ctx.store, [first, second], "add"), conflict);
    assert.deepEqual(ctx.store.snapshot(), before);
    // Even a remove that would have no visible effect must reject stale input.
    assert.throws(() => batch(ctx.store, [first, second], "remove"), conflict);
    assert.deepEqual(ctx.store.snapshot(), before);
    assert.equal(batch(ctx.store, [first, changed], "add").changed, 2);
  } finally {
    ctx.cleanup();
  }
});

test("missing and recycled papers prevent all requested reading-list changes", () => {
  const ctx = setup();
  try {
    const first = paper(ctx.store);
    const second = paper(ctx.store);
    const recycled = ctx.store.dispatch("paper.trash", {
      id: second.id,
      revision: second.revision,
    }) as Paper;
    const before = ctx.store.snapshot();
    assert.throws(() => batch(ctx.store, [first, recycled], "add"), conflict);
    assert.deepEqual(ctx.store.snapshot(), before);
    assert.throws(
      () =>
        ctx.store.dispatch("paper.reading-list", {
          papers: [
            { id: first.id, revision: first.revision },
            { id: randomUUID(), revision: 1 },
          ],
          operation: "read",
        }),
      (error: unknown) => error instanceof StoreError && error.status === 404,
    );
    assert.deepEqual(ctx.store.snapshot(), before);
  } finally {
    ctx.cleanup();
  }
});

test("a database write failure after the first update rolls back the full batch", () => {
  const ctx = setup();
  try {
    const first = paper(ctx.store);
    const second = paper(ctx.store);
    const before = ctx.store.snapshot();
    // UUID is generated by the store, never accepted as free-form SQL input.
    ctx.store.db.exec(`CREATE TRIGGER test_reading_list_rollback
      BEFORE UPDATE OF in_reading_list ON papers WHEN NEW.id='${second.id}'
      BEGIN SELECT RAISE(ABORT, 'TEST reading list write failure'); END`);
    assert.throws(
      () => batch(ctx.store, [first, second], "add"),
      /TEST reading list write failure/,
    );
    assert.deepEqual(ctx.store.snapshot(), before);
    ctx.store.db.exec("DROP TRIGGER test_reading_list_rollback");
    assert.equal(batch(ctx.store, [first, second], "add").changed, 2);
  } finally {
    ctx.cleanup();
  }
});

test("batch schema rejects duplicate IDs, empty and oversized lists, invalid revisions and extra fields", () => {
  const schema = actionSchemas["paper.reading-list"];
  const entry = { id: randomUUID(), revision: 1 };
  assert.equal(
    schema.safeParse({ papers: [entry], operation: "add" }).success,
    true,
  );
  for (const payload of [
    { papers: [], operation: "add" },
    { papers: [entry, entry], operation: "add" },
    {
      papers: Array.from({ length: 501 }, () => ({
        id: randomUUID(),
        revision: 1,
      })),
      operation: "add",
    },
    { papers: [{ ...entry, revision: 0 }], operation: "add" },
    { papers: [{ ...entry, title: "ignored?" }], operation: "add" },
    { papers: [entry], operation: "delete" },
    { papers: [entry], operation: "add", tags: ["unrelated"] },
  ])
    assert.equal(schema.safeParse(payload).success, false);
});

test("reading-list changes preserve personal Markdown, PDF fingerprints, annotations, tags, relations and positions", () => {
  const ctx = setup();
  try {
    const current = paper(ctx.store, {
      authors: ["TEST author"],
      tags: ["TEST tag"],
      abstract: "TEST abstract",
    });
    const attachment = ctx.store.addAttachment(current.id, "original.pdf", pdf);
    const note = ctx.store.snapshot().notes[0];
    ctx.store.dispatch("note.update", {
      id: note.id,
      revision: note.revision,
      body: "我的原稿 $x^2$，不得覆盖。",
    });
    ctx.store.dispatch("annotation.create", {
      paperId: current.id,
      attachmentId: attachment.id,
      kind: "highlight",
      pageIndex: 0,
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
      comment: "TEST personal comment",
    });
    ctx.store.dispatch("reading.set", {
      paperId: current.id,
      attachmentId: attachment.id,
      pageIndex: 0,
      scale: 1.4,
    });
    const before = ctx.store.snapshot();
    const notePath = path.join(ctx.dir, "notes", `${note.id}.md`);
    const originalMarkdown = readFileSync(notePath);
    let changed = batch(ctx.store, [current], "add").papers[0];
    changed = batch(ctx.store, [changed], "remove").papers[0];
    changed = batch(ctx.store, [changed], "add").papers[0];
    const { papers: _oldPapers, ...oldContent } = before;
    const { papers: _newPapers, ...newContent } = ctx.store.snapshot();
    assert.deepEqual(newContent, oldContent);
    const {
      inReadingList: _l,
      updatedAt: _u,
      revision: _r,
      ...original
    } = current;
    const {
      inReadingList: _l2,
      updatedAt: _u2,
      revision: _r2,
      ...updated
    } = changed;
    assert.deepEqual(updated, original);
    assert.equal(readFileSync(notePath).compare(originalMarkdown), 0);
    assert.equal(
      readFileSync(ctx.store.attachmentPath(attachment.id)).compare(pdf),
      0,
    );
    assert.equal(
      createHash("sha256")
        .update(readFileSync(ctx.store.attachmentPath(attachment.id)))
        .digest("hex"),
      attachment.sha256,
    );
  } finally {
    ctx.cleanup();
  }
});

test("real legacy SQL migration retains only the former unread queue, preserves original columns and runs once", () => {
  const ctx = setup();
  const unread = paper(ctx.store);
  paper(ctx.store, { readingStatus: "reading" });
  paper(ctx.store, { readingStatus: "read" });
  const before = ctx.store.snapshot();
  const notePath = path.join(ctx.dir, "notes", `${before.notes[0].id}.md`);
  const markdown = readFileSync(notePath);
  ctx.store.close();
  let migrated: KBStore | undefined;
  try {
    const legacy = new DatabaseSync(path.join(ctx.dir, "knowledge.sqlite"));
    legacy.exec("ALTER TABLE papers DROP COLUMN in_reading_list");
    const originals = legacy
      .prepare("SELECT * FROM papers ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
    legacy.close();
    migrated = new KBStore(ctx.dir);
    const rows = migrated.db.prepare("SELECT * FROM papers ORDER BY id").all();
    assert.deepEqual(
      rows.map(({ in_reading_list: _l, ...original }) => original),
      originals,
    );
    for (const entry of migrated.snapshot().papers)
      assert.equal(entry.inReadingList, entry.readingStatus === "unread");
    assert.equal(readFileSync(notePath).compare(markdown), 0);
    const { papers: _oldPapers, ...oldContent } = before;
    const { papers: _newPapers, ...newContent } = migrated.snapshot();
    assert.deepEqual(newContent, oldContent);
    batch(
      migrated,
      [migrated.snapshot().papers.find((entry) => entry.id === unread.id)!],
      "remove",
    );
    migrated.close();
    migrated = new KBStore(ctx.dir);
    assert.equal(
      migrated.snapshot().papers.find((entry) => entry.id === unread.id)
        ?.inReadingList,
      false,
    );
  } finally {
    migrated?.close();
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("new full backups preserve explicit true and false membership alongside PDF and personal notes", () => {
  const ctx = setup();
  let restored: KBStore | undefined;
  try {
    paper(ctx.store, { inReadingList: false });
    const selected = paper(ctx.store, { inReadingList: true });
    const legacyRead = paper(ctx.store, { title: "TEST legacy read in queue", readingStatus: "read" });
    batch(ctx.store, [legacyRead], "add");
    const attachment = ctx.store.addAttachment(
      selected.id,
      "original.pdf",
      pdf,
    );
    const expected = ctx.store.snapshot();
    const report = restoreBackup(createBackup(ctx.store), ctx.root);
    restored = new KBStore(report.restoredDirectory);
    assert.deepEqual(restored.snapshot(), expected);
    assert.equal(
      readFileSync(restored.attachmentPath(attachment.id)).compare(pdf),
      0,
    );
    assert.deepEqual(ctx.store.snapshot(), expected);
  } finally {
    restored?.close();
    ctx.cleanup();
  }
});

test("old backups without membership restore the former unread queue, while explicit false wins over compatibility defaults", () => {
  const ctx = setup();
  let restored: KBStore | undefined;
  try {
    const unread = paper(ctx.store);
    const reading = paper(ctx.store, { readingStatus: "reading" });
    const read = paper(ctx.store, { readingStatus: "read" });
    const explicitFalse = paper(ctx.store, { inReadingList: false });
    const archive = JSON.parse(
      gunzipSync(createBackup(ctx.store)).toString(),
    ) as { snapshot: KBState; snapshotSha256: string };
    for (const entry of archive.snapshot.papers)
      if (entry.id !== explicitFalse.id) delete entry.inReadingList;
    const parsed = snapshotSchema.parse(archive.snapshot);
    const membership = new Map(
      parsed.papers.map((entry) => [entry.id, entry.inReadingList]),
    );
    assert.equal(membership.get(unread.id), true);
    assert.equal(membership.get(reading.id), false);
    assert.equal(membership.get(read.id), false);
    assert.equal(membership.get(explicitFalse.id), false);
    archive.snapshotSha256 = createHash("sha256")
      .update(canonical(archive.snapshot))
      .digest("hex");
    const report = restoreBackup(gzipSync(JSON.stringify(archive)), ctx.root);
    restored = new KBStore(report.restoredDirectory);
    assert.deepEqual(restored.snapshot().papers, parsed.papers);
    const invalid = structuredClone(archive.snapshot);
    Object.assign(invalid.papers[0], { inReadingList: 1 });
    assert.equal(snapshotSchema.safeParse(invalid).success, false);
  } finally {
    restored?.close();
    ctx.cleanup();
  }
});
