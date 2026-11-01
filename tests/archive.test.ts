import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  createBackup,
  exportMarkdown,
  restoreBackup,
} from "../src/lib/archive";
import { KBStore } from "../src/lib/db";
import type { Annotation, KBState, Note, Paper, Topic } from "../src/lib/types";

// This is a storage fixture, not a readable PDF or a fabricated research result.
const fixture = Buffer.from(
  "%PDF-1.7\narchive fixture with explicit test content\n%%EOF",
);
interface Manifest {
  format: string;
  version: number;
  createdAt: string;
  snapshotSha256: string;
  snapshot: KBState;
  files: Array<{ path: string; sha256: string; data: string }>;
}
function unpack(bytes: Buffer) {
  return JSON.parse(gunzipSync(bytes).toString("utf8")) as Manifest;
}
function pack(value: Manifest) {
  return gzipSync(JSON.stringify(value));
}
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "research-kb-archive-"));
  const store = new KBStore(path.join(root, "source"));
  return {
    root,
    store,
    cleanup() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function createLibrary(store: KBStore) {
  const paper = store.dispatch("paper.create", {
    title: "带封面的测试论文",
    doi: "10.1234/archive-fixture",
    tags: ["中文标签"],
  }) as Paper;
  const other = store.dispatch("paper.create", {
    title: "另一篇仅元数据文献",
    sourceUrl: "https://example.org/metadata-only",
  }) as Paper;
  const first = store.addAttachment(paper.id, "封面.pdf", fixture);
  store.addAttachment(
    paper.id,
    "第二历史版本.pdf",
    Buffer.from("%PDF-1.7\nsecond historical fixture\n%%EOF"),
  );
  const annotation = store.dispatch("annotation.create", {
    paperId: paper.id,
    attachmentId: first.id,
    kind: "highlight",
    pageIndex: 3,
    pageLabel: "2",
    rects: [{ x: 0.15, y: 0.7, width: 0.3, height: 0.025 }],
    selectedText: "Unique source excerpt",
    comment: "我的原文评论",
  }) as Annotation;
  const topic = store.dispatch("topic.create", {
    title: "跨论文研究问题",
    description: "仅作验收示例",
  }) as Topic;
  store.dispatch("link.set", {
    fromType: "paper",
    fromId: paper.id,
    toType: "topic",
    toId: topic.id,
  });
  store.dispatch("link.set", {
    fromType: "paper",
    fromId: other.id,
    toType: "topic",
    toId: topic.id,
  });
  const note = store.snapshot().notes.find((n) => n.id === topic.noteId)!;
  store.dispatch("note.update", {
    id: note.id,
    revision: note.revision,
    body: `比较两篇文献，保留自己的推导 $a_n \\to a$。\n\n> Unique source excerpt\n\n[页码出处](kb://annotation/${annotation.id})\n\n[第二篇](kb://paper/${other.id})`,
  });
  const idea = store.dispatch("note.create", {
    title: "独立想法",
    purpose: "idea",
    body: "跨论文复用同一个对象",
    paperIds: [paper.id, other.id],
    topicIds: [topic.id],
  }) as Note;
  store.dispatch("reading.set", {
    paperId: paper.id,
    attachmentId: first.id,
    pageIndex: 3,
    scale: "page-width",
    rotation: 90,
  });
  store.saveAI({
    paperId: paper.id,
    kind: "explanation",
    body: "Explicit AI transport test fixture",
    provider: "test-only",
    model: "no-inference-used",
    sourceScope: "selection",
    sourceAttachmentId: first.id,
    sourcePageIndices: [3],
    sourceText: "Unique source excerpt",
    status: "completed",
  });
  return { paper, annotation, topic, idea, first, other };
}

test("full backup restores into a fresh directory with historical attachments, stable references and Chinese search", () => {
  const ctx = setup();
  let restored: KBStore | undefined;
  try {
    const { annotation, topic, idea, first } = createLibrary(ctx.store);
    const expected = ctx.store.snapshot();
    const bytes = createBackup(ctx.store);
    assert.equal(
      unpack(bytes).files.length,
      2,
      "includes unreferenced historical attachment versions",
    );
    const report = restoreBackup(bytes, ctx.root);
    restored = new KBStore(report.restoredDirectory);
    assert.deepEqual(restored.snapshot(), expected);
    assert.equal(restored.snapshot().topics[0].noteId, topic.noteId);
    assert.equal(
      restored.snapshot().notes.find((n) => n.id === idea.id)?.body,
      "跨论文复用同一个对象",
    );
    assert.equal(restored.snapshot().annotations[0].attachmentId, first.id);
    assert.equal(restored.snapshot().readingPositions[0].rotation, 90);
    assert.equal(
      readFileSync(restored.attachmentPath(first.id)).compare(fixture),
      0,
    );
    restored.close();
    restored = new KBStore(report.restoredDirectory);
    assert.ok(
      restored
        .snapshot("自己的推导")
        .searchResults?.some(
          (r) => r.id === topic.noteId && r.topicId === topic.id,
        ),
    );
    assert.ok(
      restored
        .snapshot()
        .relations.some(
          (r) =>
            r.fromId === topic.noteId &&
            r.toId === annotation.id &&
            r.purpose === "reference",
        ),
    );
    assert.throws(
      () => restored!.dispatch("annotation.delete", { id: annotation.id }),
      /已被笔记引用/,
    );
    const markdown = exportMarkdown(restored.snapshot(), topic.noteId);
    assert.match(markdown, /物理页 4/);
    assert.match(markdown, /显示页码 2/);
    assert.match(markdown, /Unique source excerpt/);
    assert.match(markdown, /\$a_n/);
  } finally {
    restored?.close();
    ctx.cleanup();
  }
});

test("backup rejects payload tampering and required attachment omission without leaving target directories", () => {
  const ctx = setup();
  try {
    createLibrary(ctx.store);
    const bytes = createBackup(ctx.store);
    const before = readdirSync(ctx.root).sort();
    const missing = unpack(bytes);
    missing.files = [];
    assert.throws(() => restoreBackup(pack(missing), ctx.root), /缺少必要附件/);
    assert.deepEqual(readdirSync(ctx.root).sort(), before);
    const damaged = unpack(bytes);
    damaged.files[0].data =
      Buffer.from("%PDF-wrong-content").toString("base64");
    assert.throws(() => restoreBackup(pack(damaged), ctx.root), /附件校验/);
    assert.deepEqual(readdirSync(ctx.root).sort(), before);
    const wrongSnapshot = unpack(bytes);
    wrongSnapshot.snapshot.notes[0].body = "unauthorized snapshot mutation";
    assert.throws(
      () => restoreBackup(pack(wrongSnapshot), ctx.root),
      /快照校验/,
    );
  } finally {
    ctx.cleanup();
  }
});

test("backup rejects path traversal, unlisted files and duplicate attachment paths", () => {
  const ctx = setup();
  try {
    createLibrary(ctx.store);
    const bytes = createBackup(ctx.store);
    const before = readdirSync(ctx.root).sort();
    const traversal = unpack(bytes);
    traversal.files[0].path = "../../escaped.pdf";
    assert.throws(() => restoreBackup(pack(traversal), ctx.root));
    const extra = unpack(bytes);
    extra.files.push({
      ...extra.files[0],
      path: "attachments/00000000-0000-4000-8000-000000000001.pdf",
    });
    assert.throws(
      () => restoreBackup(pack(extra), ctx.root),
      /清单与数据快照不一致/,
    );
    const duplicate = unpack(bytes);
    duplicate.files.push(duplicate.files[0]);
    assert.throws(
      () => restoreBackup(pack(duplicate), ctx.root),
      /重复文件路径/,
    );
    assert.deepEqual(readdirSync(ctx.root).sort(), before);
  } finally {
    ctx.cleanup();
  }
});
