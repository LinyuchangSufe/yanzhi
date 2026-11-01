import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { KBStore, StoreError } from "../src/lib/db";
import { createBackup, restoreBackup } from "../src/lib/archive";
import { actionSchemas, snapshotSchema } from "../src/lib/validation";
import type { AIContent, KBState, Note, Paper, Topic } from "../src/lib/types";

// Storage fixture only: no model inference and no real research claims.
const pdf = Buffer.from("%PDF-1.7\nTEST reversible paper trash fixture\n%%EOF");
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-paper-trash-"));
  const dir = path.join(root, "source");
  const store = new KBStore(dir);
  return {
    root,
    dir,
    store,
    cleanup() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function createPaper(store: KBStore, input = {}) {
  return store.dispatch("paper.create", {
    title: "TEST shared phrase",
    ...input,
  }) as Paper;
}
function trash(store: KBStore, paper: Paper) {
  return store.dispatch("paper.trash", {
    id: paper.id,
    revision: paper.revision,
  }) as Paper;
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

test("trash and restore preserve original PDF bytes, personal Markdown, tags and every relation", () => {
  const ctx = setup();
  try {
    const paper = createPaper(ctx.store, { tags: ["TEST tag"] });
    const attachment = ctx.store.addAttachment(paper.id, "fixture.pdf", pdf);
    const note = ctx.store.snapshot().notes[0];
    ctx.store.dispatch("note.update", {
      id: note.id,
      revision: note.revision,
      body: "我的推导 $x^2$，必须完整保留。",
    });
    ctx.store.dispatch("annotation.create", {
      paperId: paper.id,
      attachmentId: attachment.id,
      kind: "highlight",
      pageIndex: 0,
      rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.03 }],
      selectedText: "shared phrase",
      comment: "原始评论",
    });
    ctx.store.dispatch("reading.set", {
      paperId: paper.id,
      attachmentId: attachment.id,
      pageIndex: 0,
      scale: 1.5,
    });
    const before = ctx.store.snapshot();
    const markdown = readFileSync(path.join(ctx.dir, "notes", `${note.id}.md`));
    const recycled = trash(ctx.store, paper);
    assert.ok(recycled.deletedAt);
    assert.equal(recycled.revision, paper.revision + 1);
    const { papers: _oldPapers, ...unaffected } = before;
    const { papers: _newPapers, ...afterTrash } = ctx.store.snapshot();
    assert.deepEqual(afterTrash, unaffected);
    assert.equal(
      readFileSync(ctx.store.attachmentPath(attachment.id)).compare(pdf),
      0,
    );
    assert.equal(
      readFileSync(path.join(ctx.dir, "notes", `${note.id}.md`)).compare(
        markdown,
      ),
      0,
    );
    const restored = ctx.store.dispatch("paper.restore", {
      id: paper.id,
      revision: recycled.revision,
    }) as Paper;
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.revision, paper.revision + 2);
    const {
      revision: _r,
      updatedAt: _u,
      deletedAt: _d,
      ...metadata
    } = restored;
    const {
      revision: _oldR,
      updatedAt: _oldU,
      deletedAt: _oldD,
      ...original
    } = paper;
    assert.deepEqual(metadata, original);
    const { papers: _restoredPapers, ...afterRestore } = ctx.store.snapshot();
    assert.deepEqual(afterRestore, unaffected);
  } finally {
    ctx.cleanup();
  }
});

test("search hides recycled papers and their personal notes, annotations and AI while retaining independent ideas and topics", () => {
  const ctx = setup();
  try {
    const paper = createPaper(ctx.store);
    const attachment = ctx.store.addAttachment(paper.id, "fixture.pdf", pdf);
    const paperNote = ctx.store.snapshot().notes[0];
    ctx.store.dispatch("note.update", {
      id: paperNote.id,
      revision: paperNote.revision,
      body: "TEST shared phrase in paper note",
    });
    ctx.store.dispatch("annotation.create", {
      paperId: paper.id,
      attachmentId: attachment.id,
      kind: "highlight",
      pageIndex: 0,
      rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.03 }],
      comment: "shared phrase",
    });
    const ai = ctx.store.saveAI({
      paperId: paper.id,
      kind: "summary",
      body: "shared phrase fixture",
      provider: "test-only",
      model: "no-model",
      sourceScope: "abstract",
      sourceAttachmentId: null,
      sourcePageIndices: [],
      sourceText: "",
      status: "completed",
    });
    const idea = ctx.store.dispatch("note.create", {
      title: "TEST shared phrase idea",
      body: "still mine",
      purpose: "idea",
      paperIds: [paper.id],
    }) as Note;
    const topic = ctx.store.dispatch("topic.create", {
      title: "TEST shared phrase topic",
    }) as Topic;
    ctx.store.dispatch("note.update", {
      id: topic.noteId,
      revision: 1,
      body: "shared phrase in synthesis",
    });
    const before = ctx.store.snapshot("shared phrase").searchResults!;
    assert.ok(before.some((r) => r.id === paper.id));
    assert.ok(before.some((r) => r.id === ai.id));
    const recycled = trash(ctx.store, paper);
    const after = ctx.store.snapshot("shared phrase").searchResults!;
    assert.deepEqual(
      new Set(after.map((r) => r.id)),
      new Set([idea.id, topic.id, topic.noteId]),
    );
    assert.equal(after.find((r) => r.id === idea.id)?.paperId, undefined);
    ctx.store.dispatch("paper.restore", {
      id: paper.id,
      revision: recycled.revision,
    });
    assert.deepEqual(ctx.store.snapshot("shared phrase").searchResults, before);
  } finally {
    ctx.cleanup();
  }
});

test("stale revisions and repeated transitions fail without changing data", () => {
  const ctx = setup();
  try {
    const paper = createPaper(ctx.store);
    const edited = ctx.store.dispatch("paper.update", {
      id: paper.id,
      revision: paper.revision,
      title: "TEST newer metadata",
    }) as Paper;
    const before = ctx.store.snapshot();
    assert.throws(() => trash(ctx.store, paper), conflict);
    assert.deepEqual(ctx.store.snapshot(), before);
    const recycled = trash(ctx.store, edited);
    const trashedState = ctx.store.snapshot();
    assert.throws(() => trash(ctx.store, recycled), conflict);
    assert.throws(
      () =>
        ctx.store.dispatch("paper.restore", {
          id: paper.id,
          revision: edited.revision,
        }),
      conflict,
    );
    assert.throws(
      () =>
        ctx.store.dispatch("paper.update", {
          id: paper.id,
          revision: recycled.revision,
          title: "lost update",
        }),
      /先恢复/,
    );
    assert.deepEqual(ctx.store.snapshot(), trashedState);
    const restored = ctx.store.dispatch("paper.restore", {
      id: paper.id,
      revision: recycled.revision,
    }) as Paper;
    const active = ctx.store.snapshot();
    assert.throws(
      () =>
        ctx.store.dispatch("paper.restore", {
          id: restored.id,
          revision: restored.revision,
        }),
      conflict,
    );
    assert.deepEqual(ctx.store.snapshot(), active);
    assert.equal(
      actionSchemas["paper.trash"].safeParse({ id: paper.id }).success,
      false,
    );
    assert.equal(
      actionSchemas["paper.restore"].safeParse({ id: paper.id, revision: 0 })
        .success,
      false,
    );
  } finally {
    ctx.cleanup();
  }
});

test("DOI, arXiv and duplicate PDFs in trash require restoring their original record", () => {
  const ctx = setup();
  try {
    const paper = createPaper(ctx.store, {
      doi: "10.1234/TRASH",
      arxivId: "2401.12345v2",
    });
    const attachment = ctx.store.addAttachment(paper.id, "fixture.pdf", pdf);
    const active = createPaper(ctx.store, {
      title: "TEST active import target",
    });
    const recycled = trash(ctx.store, paper);
    const before = ctx.store.snapshot();
    const recycledDuplicate = (error: unknown) =>
      error instanceof StoreError &&
      error.status === 409 &&
      /先恢复/.test(error.message) &&
      (error.details as { existingPaperId: string; trashed: boolean })
        .existingPaperId === paper.id &&
      (error.details as { trashed: boolean }).trashed;
    assert.throws(
      () => createPaper(ctx.store, { doi: "https://doi.org/10.1234/trash" }),
      recycledDuplicate,
    );
    assert.throws(
      () => createPaper(ctx.store, { arxivId: "2401.12345v3" }),
      recycledDuplicate,
    );
    assert.throws(
      () =>
        ctx.store.dispatch("paper.update", {
          id: active.id,
          revision: active.revision,
          doi: paper.doi,
        }),
      recycledDuplicate,
    );
    assert.throws(
      () => ctx.store.addAttachment(active.id, "duplicate.pdf", pdf),
      recycledDuplicate,
    );
    assert.throws(
      () => ctx.store.addAttachment(paper.id, "supplement.pdf", pdf),
      recycledDuplicate,
    );
    assert.deepEqual(ctx.store.snapshot(), before);
    ctx.store.dispatch("paper.restore", {
      id: paper.id,
      revision: recycled.revision,
    });
    assert.equal(
      ctx.store.addAttachment(paper.id, "same.pdf", pdf).id,
      attachment.id,
    );
  } finally {
    ctx.cleanup();
  }
});

test("full backup round-trip keeps trash state and all files, and restore reactivates preserved search", () => {
  const ctx = setup();
  let restored: KBStore | undefined;
  try {
    const paper = createPaper(ctx.store);
    const attachment = ctx.store.addAttachment(paper.id, "fixture.pdf", pdf);
    const recycled = trash(ctx.store, paper);
    const expected = ctx.store.snapshot();
    const report = restoreBackup(createBackup(ctx.store), ctx.root);
    restored = new KBStore(report.restoredDirectory);
    assert.deepEqual(restored.snapshot(), expected);
    assert.deepEqual(restored.snapshot("shared phrase").searchResults, []);
    assert.equal(
      readFileSync(restored.attachmentPath(attachment.id)).compare(pdf),
      0,
    );
    restored.dispatch("paper.restore", {
      id: paper.id,
      revision: recycled.revision,
    });
    assert.ok(
      restored
        .snapshot("shared phrase")
        .searchResults?.some((r) => r.id === paper.id),
    );
    assert.deepEqual(ctx.store.snapshot(), expected);
  } finally {
    restored?.close();
    ctx.cleanup();
  }
});

test("legacy backup without deletion field validates and restores as an active library", () => {
  const ctx = setup();
  let restored: KBStore | undefined;
  try {
    const paper = createPaper(ctx.store);
    const archive = JSON.parse(
      gunzipSync(createBackup(ctx.store)).toString(),
    ) as { snapshot: KBState; snapshotSha256: string };
    for (const entry of archive.snapshot.papers) delete entry.deletedAt;
    assert.equal(
      snapshotSchema.parse(archive.snapshot).papers[0].deletedAt,
      null,
    );
    archive.snapshotSha256 = createHash("sha256")
      .update(canonical(archive.snapshot))
      .digest("hex");
    const report = restoreBackup(gzipSync(JSON.stringify(archive)), ctx.root);
    restored = new KBStore(report.restoredDirectory);
    assert.equal(restored.snapshot().papers[0].deletedAt, null);
    assert.ok(
      restored
        .snapshot("shared phrase")
        .searchResults?.some((r) => r.id === paper.id),
    );
    const invalid = structuredClone(restored.snapshot());
    invalid.papers[0].deletedAt = "not a timestamp";
    assert.equal(snapshotSchema.safeParse(invalid).success, false);
  } finally {
    restored?.close();
    ctx.cleanup();
  }
});

test("additive migration of a real legacy database never rewrites paper metadata, revisions or notes", () => {
  const ctx = setup();
  const paper = createPaper(ctx.store);
  const markdownFile = path.join(
    ctx.dir,
    "notes",
    `${ctx.store.snapshot().notes[0].id}.md`,
  );
  const markdown = readFileSync(markdownFile);
  ctx.store.close();
  let migrated: KBStore | undefined;
  try {
    const legacy = new DatabaseSync(path.join(ctx.dir, "knowledge.sqlite"));
    legacy.exec("ALTER TABLE papers DROP COLUMN deleted_at");
    const before = legacy
      .prepare("SELECT * FROM papers WHERE id=?")
      .get(paper.id)!;
    legacy.close();
    migrated = new KBStore(ctx.dir);
    const after = migrated.db
      .prepare("SELECT * FROM papers WHERE id=?")
      .get(paper.id)!;
    const { deleted_at, ...originalColumns } = after;
    assert.equal(deleted_at, null);
    assert.deepEqual(originalColumns, { ...before });
    assert.equal(readFileSync(markdownFile).compare(markdown), 0);
    assert.equal(migrated.snapshot().papers[0].revision, paper.revision);
  } finally {
    migrated?.close();
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("late AI completion for a recycled paper is rejected and does not append records", () => {
  const ctx = setup();
  try {
    const paper = createPaper(ctx.store);
    trash(ctx.store, paper);
    const before = ctx.store.snapshot();
    const content: Omit<AIContent, "id" | "createdAt"> = {
      paperId: paper.id,
      kind: "summary",
      body: "TEST fixture result",
      provider: "test-only",
      model: "no-model",
      sourceScope: "abstract",
      sourceAttachmentId: null,
      sourcePageIndices: [],
      sourceText: "",
      status: "completed",
    };
    assert.throws(() => ctx.store.saveAI(content), /先恢复/);
    assert.deepEqual(ctx.store.snapshot(), before);
  } finally {
    ctx.cleanup();
  }
});
