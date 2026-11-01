import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { KBStore, StoreError } from "../src/lib/db";
import type { Annotation, Note, Paper, Topic } from "../src/lib/types";

const pdf = Buffer.from(
  "%PDF-1.7\nExplicit storage test fixture, not a readable paper.\n%%EOF",
);
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "research-kb-storage-"));
  let store = new KBStore(dir);
  return {
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
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function paper(store: KBStore, fields = {}) {
  return store.dispatch("paper.create", {
    title: "测试论文",
    ...fields,
  }) as Paper;
}
function annotation(store: KBStore, paperId: string, attachmentId: string) {
  return store.dispatch("annotation.create", {
    paperId,
    attachmentId,
    kind: "region",
    pageIndex: 2,
    pageLabel: "1",
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }],
    comment: "conditional independence",
  }) as Annotation;
}

test("link-only paper, editable metadata and user note survive restart then PDF enrichment", () => {
  const ctx = setup();
  try {
    const p = paper(ctx.store, {
      sourceUrl: "https://example.org/paper",
      tags: ["统计", "Online"],
    });
    const note = ctx.store.snapshot().notes[0];
    const body = "# 我的推导\n相关性不能忽略。 $x^2$";
    ctx.store.dispatch("note.update", {
      id: note.id,
      revision: note.revision,
      body,
    });
    const updated = ctx.store.dispatch("paper.update", {
      id: p.id,
      revision: p.revision,
      title: "新标题",
      readingStatus: "reading",
    }) as Paper;
    ctx.restart();
    assert.equal(ctx.store.snapshot().papers[0].id, p.id);
    assert.equal(ctx.store.snapshot().papers[0].readingStatus, "reading");
    const attachment = ctx.store.addAttachment(p.id, "论文.pdf", pdf);
    assert.equal(attachment.paperId, p.id);
    assert.equal(ctx.store.snapshot().papers.length, 1);
    assert.equal(ctx.store.snapshot().notes[0].body, body);
    assert.equal(updated.title, "新标题");
    assert.match(
      readFileSync(path.join(ctx.dir, "notes", `${note.id}.md`), "utf8"),
      /相关性不能忽略/,
    );
    assert.equal(
      ctx.store.snapshot("相关性不能忽略").searchResults?.[0].id,
      note.id,
    );
  } finally {
    ctx.cleanup();
  }
});

test("normalized DOI/arXiv identities reject duplicates without overwriting user content", () => {
  const ctx = setup();
  try {
    const p = paper(ctx.store, { doi: "https://doi.org/10.1234/AbC" });
    assert.equal(p.doi, "10.1234/abc");
    assert.throws(
      () => paper(ctx.store, { doi: "doi:10.1234/ABC" }),
      (e: unknown) =>
        e instanceof StoreError &&
        e.status === 409 &&
        (e.details as { existingPaperId: string }).existingPaperId === p.id,
    );
    const arxiv = paper(ctx.store, {
      arxivId: "https://arxiv.org/pdf/2401.12345v2.pdf",
    });
    assert.equal(arxiv.arxivId, "2401.12345");
    assert.equal(arxiv.arxivVersion, 2);
    assert.throws(
      () =>
        paper(ctx.store, { sourceUrl: "https://arxiv.org/abs/2401.12345v3" }),
      /已存在/,
    );
    assert.equal(ctx.store.snapshot().papers.length, 2);
  } finally {
    ctx.cleanup();
  }
});

test("revision conflicts prevent silent multi-window overwrite", () => {
  const ctx = setup();
  try {
    const p = paper(ctx.store);
    const note = ctx.store.snapshot().notes[0];
    ctx.store.dispatch("note.update", {
      id: note.id,
      revision: 1,
      body: "窗口A写入",
    });
    assert.throws(
      () =>
        ctx.store.dispatch("note.update", {
          id: note.id,
          revision: 1,
          body: "窗口B覆盖",
        }),
      (e: unknown) => e instanceof StoreError && e.status === 409,
    );
    assert.equal(ctx.store.snapshot().notes[0].body, "窗口A写入");
    assert.throws(
      () =>
        ctx.store.dispatch("paper.update", {
          id: p.id,
          revision: 99,
          title: "覆盖",
        }),
      /其他窗口/,
    );
  } finally {
    ctx.cleanup();
  }
});

test("real filesystem write failure rolls back the note and its source index", () => {
  const ctx = setup();
  try {
    const p = paper(ctx.store);
    const file = ctx.store.addAttachment(p.id, "fixture.pdf", pdf);
    const a = annotation(ctx.store, p.id, file.id);
    const note = ctx.store.snapshot().notes[0];
    renameSync(
      path.join(ctx.dir, "notes"),
      path.join(ctx.dir, "notes-unavailable"),
    );
    try {
      assert.throws(() =>
        ctx.store.dispatch("note.update", {
          id: note.id,
          revision: note.revision,
          body: `[原文](kb://annotation/${a.id})`,
        }),
      );
    } finally {
      renameSync(
        path.join(ctx.dir, "notes-unavailable"),
        path.join(ctx.dir, "notes"),
      );
    }
    assert.equal(ctx.store.snapshot().notes[0].body, "");
    assert.equal(ctx.store.snapshot().notes[0].revision, 1);
    assert.equal(
      ctx.store.snapshot().relations.filter((r) => r.purpose === "reference")
        .length,
      0,
    );
  } finally {
    ctx.cleanup();
  }
});

test("Markdown source links persist backlinks atomically; quoted code creates no false backlinks", () => {
  const ctx = setup();
  try {
    const p = paper(ctx.store);
    const file = ctx.store.addAttachment(p.id, "a.pdf", pdf);
    const a = annotation(ctx.store, p.id, file.id);
    const note = ctx.store.snapshot().notes[0];
    const body = `> 摘录\n\n[出处](kb://annotation/${a.id})\n\n我的独立解释。`;
    const saved = ctx.store.dispatch("note.update", {
      id: note.id,
      revision: 1,
      body,
    }) as Note;
    assert.equal(
      ctx.store
        .snapshot()
        .relations.filter((r) => r.purpose === "reference" && r.toId === a.id)
        .length,
      1,
    );
    assert.throws(
      () => ctx.store.dispatch("annotation.delete", { id: a.id }),
      /已被笔记引用/,
    );
    ctx.store.dispatch("annotation.update", {
      id: a.id,
      revision: a.revision,
      comment: "新的批注评论",
    });
    assert.equal(ctx.store.snapshot().notes[0].body, body);
    ctx.restart();
    assert.equal(ctx.store.snapshot().annotations[0].pageIndex, 2);
    assert.equal(ctx.store.snapshot().annotations[0].pageLabel, "1");
    ctx.store.dispatch("note.update", {
      id: note.id,
      revision: saved.revision,
      body: `\`[出处](kb://annotation/${a.id})\`\n\n我的独立解释。`,
    });
    assert.equal(
      ctx.store.snapshot().relations.filter((r) => r.purpose === "reference")
        .length,
      0,
    );
    ctx.store.dispatch("annotation.delete", { id: a.id });
    assert.equal(ctx.store.snapshot().annotations.length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("topics and independent ideas share records; removing associations never cascades content", () => {
  const ctx = setup();
  try {
    const p = paper(ctx.store);
    const a = ctx.store.dispatch("topic.create", { title: "问题A" }) as Topic;
    const b = ctx.store.dispatch("topic.create", { title: "问题B" }) as Topic;
    const idea = ctx.store.dispatch("note.create", {
      title: "独立想法",
      body: "先写一句话",
      purpose: "idea",
    }) as Note;
    for (const topic of [a, b])
      ctx.store.dispatch("link.set", {
        fromType: "paper",
        fromId: p.id,
        toType: "topic",
        toId: topic.id,
      });
    ctx.store.dispatch("link.set", {
      fromType: "note",
      fromId: idea.id,
      toType: "topic",
      toId: a.id,
    });
    ctx.store.dispatch("link.set", {
      fromType: "note",
      fromId: idea.id,
      toType: "paper",
      toId: p.id,
    });
    ctx.store.dispatch("topic.delete", { id: a.id });
    const state = ctx.store.snapshot();
    assert.equal(state.papers.length, 1);
    assert.ok(state.notes.some((n) => n.id === idea.id));
    assert.ok(
      state.notes.some((n) => n.id === a.noteId && n.purpose === "idea"),
    );
    assert.ok(
      state.relations.some((r) => r.fromId === p.id && r.toId === b.id),
    );
  } finally {
    ctx.cleanup();
  }
});

test("immutable attachment versions, missing-file relink and fingerprint protection", () => {
  const ctx = setup();
  try {
    const p = paper(ctx.store);
    const first = ctx.store.addAttachment(p.id, "v1.pdf", pdf);
    const a = annotation(ctx.store, p.id, first.id);
    const next = ctx.store.addAttachment(
      p.id,
      "v2.pdf",
      Buffer.from("%PDF-1.7\nsecond explicit fixture\n%%EOF"),
    );
    assert.notEqual(next.id, first.id);
    assert.equal(
      ctx.store.snapshot().annotations[0].attachmentId,
      a.attachmentId,
    );
    unlinkSync(ctx.store.attachmentPath(first.id));
    assert.equal(
      ctx.store.snapshot().attachments.find((item) => item.id === first.id)
        ?.status,
      "missing",
    );
    assert.equal(
      ctx.store.addAttachment(p.id, "restore.pdf", pdf).id,
      first.id,
    );
    assert.equal(ctx.store.snapshot().attachments.length, 2);
    writeFileSync(path.join(ctx.dir, first.relativePath), "%PDF-tampered");
    assert.throws(() => ctx.store.attachmentPath(first.id), /指纹已改变/);
    assert.throws(
      () => ctx.store.addAttachment(p.id, "restore.pdf", pdf),
      /外部改变/,
    );
  } finally {
    ctx.cleanup();
  }
});

test("failed foreign-key link rolls back note creation and duplicate PDF reports existing paper", () => {
  const ctx = setup();
  try {
    const p = paper(ctx.store);
    const other = paper(ctx.store);
    ctx.store.addAttachment(p.id, "a.pdf", pdf);
    assert.throws(
      () => ctx.store.addAttachment(other.id, "duplicate.pdf", pdf),
      /另一篇文献/,
    );
    const count = ctx.store.snapshot().notes.length;
    assert.throws(
      () =>
        ctx.store.dispatch("note.create", {
          title: "失败",
          body: "失败",
          purpose: "idea",
          paperIds: ["00000000-0000-4000-8000-000000000001"],
        }),
      /对象不存在/,
    );
    assert.equal(ctx.store.snapshot().notes.length, count);
  } finally {
    ctx.cleanup();
  }
});

test("saved AI content is searchable and never changes personal notes", () => {
  const ctx = setup();
  try {
    const p = paper(ctx.store);
    const before = ctx.store.snapshot().notes;
    ctx.store.saveAI({
      paperId: p.id,
      kind: "summary",
      body: "Generated unique evidence phrase",
      provider: "test-boundary",
      model: "explicit-test-fixture",
      sourceScope: "abstract",
      sourceAttachmentId: null,
      sourcePageIndices: [],
      sourceText: "Source abstract",
      status: "completed",
    });
    assert.deepEqual(ctx.store.snapshot().notes, before);
    assert.equal(
      ctx.store.snapshot("unique evidence phrase").searchResults?.[0].type,
      "ai",
    );
  } finally {
    ctx.cleanup();
  }
});

test("snapshot restore preserves stable IDs/revisions, rejects nonempty target and broken relations", () => {
  const source = setup();
  const target = setup();
  const broken = setup();
  try {
    const p = paper(source.store, { doi: "10.1234/restore" });
    const file = source.store.addAttachment(p.id, "fixture.pdf", pdf);
    const a = annotation(source.store, p.id, file.id);
    const note = source.store.snapshot().notes[0];
    source.store.dispatch("note.update", {
      id: note.id,
      revision: 1,
      body: `[原文](kb://annotation/${a.id})\n跨目录恢复`,
    });
    const state = source.store.snapshot();
    target.store.importSnapshot(state);
    const restored = target.store.snapshot();
    assert.equal(restored.papers[0].id, p.id);
    assert.equal(restored.notes[0].revision, 2);
    assert.equal(restored.notes[0].body, state.notes[0].body);
    assert.deepEqual(restored.relations, state.relations);
    assert.equal(restored.attachments[0].status, "missing");
    assert.equal(
      target.store.addAttachment(p.id, "restored.pdf", pdf).id,
      file.id,
    );
    target.restart();
    assert.equal(
      target.store.snapshot("跨目录恢复").searchResults?.[0].id,
      note.id,
    );
    assert.throws(() => target.store.importSnapshot(state), /全新的空数据目录/);
    const tampered = structuredClone(state);
    tampered.relations = state.relations.filter(
      (r) => r.purpose !== "reference",
    );
    assert.throws(
      () => broken.store.importSnapshot(tampered),
      /缺少笔记引用索引/,
    );
    assert.equal(broken.store.snapshot().papers.length, 0);
  } finally {
    source.cleanup();
    target.cleanup();
    broken.cleanup();
  }
});
