import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { KBStore, StoreError } from "../src/lib/db";
import {
  captureNoteRevision,
  saveNoteAssistance,
} from "../src/lib/note-assist/store";
import {
  assertSafeInsertion,
  buildRevisedText,
  validateEdits,
} from "../src/lib/note-assist/patches";
import {
  createBackup,
  restoreBackup,
  exportMarkdown,
} from "../src/lib/archive";
import { exportNoteBundle } from "../src/lib/note-export";
import { addNoteImage } from "../src/lib/note-images";
import type { NoteAssistance } from "../src/lib/note-assist/types";
import type { KBState, Note, NoteImage, Paper } from "../src/lib/types";

const original =
  "模糊的问题。\n\n需要证据。\n\n保留公式 $a_n \\to a$，以及 `x = 1`。";
function setup(body = original) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-note-assist-"));
  const dir = path.join(root, "library");
  let store = new KBStore(dir);
  const note = store.dispatch("note.create", {
    title: "我的研究原稿",
    purpose: "idea",
    body,
  }) as Note;
  return {
    root,
    dir,
    note,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new KBStore(dir);
    },
    cleanup() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
function makeRecord(
  store: KBStore,
  note: Note,
  overrides: Partial<NoteAssistance> = {},
): NoteAssistance {
  captureNoteRevision(store, note, "ai-start");
  return {
    id: randomUUID(),
    noteId: note.id,
    mode: "structure",
    baseRevision: note.revision,
    baseTitle: note.title,
    baseBody: note.body,
    selection: null,
    paperIds: [],
    ideaIds: [],
    sources: [
      {
        id: `note:${note.id}`,
        kind: "note",
        title: note.title,
        text: note.body,
        noteId: note.id,
      },
    ],
    result: {
      overview: "显式测试模型建议，不是真实研究结论。",
      edits: [
        {
          before: "模糊的问题。",
          after: "明确的问题。",
          reason: "说明研究范围",
        },
        {
          before: "需要证据。",
          after: "需要可核对的证据。",
          reason: "区分判断与依据",
        },
      ],
      suggestions: [
        {
          title: "待澄清问题",
          body: "这是待验证设想。",
          basis: "hypothesis",
          evidenceIds: [],
        },
      ],
    },
    provider: "test-only",
    model: "no-inference",
    appliedEdits: [],
    lastAppliedRevision: note.revision,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}
function current(store: KBStore, id: string): Note {
  return store.snapshot().notes.find((n) => n.id === id)!;
}
function apply(
  store: KBStore,
  record: NoteAssistance,
  operation: "all" | "edit" | "insert",
  rest = {},
): Note {
  return store.dispatch("note.assist.apply", {
    noteId: record.noteId,
    revision: current(store, record.noteId).revision,
    assistanceId: record.id,
    operation,
    ...rest,
  }) as Note;
}
const isConflict = (error: unknown) =>
  error instanceof StoreError && error.status === 409;

test("AI records and deduplicated original revisions persist independently without changing human Markdown", () => {
  const ctx = setup();
  try {
    const before = current(ctx.store, ctx.note.id);
    const mirror = fs.readFileSync(
      path.join(ctx.dir, "notes", `${ctx.note.id}.md`),
    );
    const record = makeRecord(ctx.store, before);
    const first = captureNoteRevision(ctx.store, before, "ai-start");
    assert.equal(
      captureNoteRevision(ctx.store, before, "ai-start").id,
      first.id,
    );
    saveNoteAssistance(ctx.store, record);
    assert.deepEqual(current(ctx.store, before.id), before);
    assert.deepEqual(
      fs.readFileSync(path.join(ctx.dir, "notes", `${before.id}.md`)),
      mirror,
    );
    ctx.restart();
    assert.deepEqual(ctx.store.snapshot().noteAssists, [record]);
    assert.equal(ctx.store.snapshot().noteRevisions?.length, 1);
    assert.equal(
      exportMarkdown(ctx.store.snapshot(), before.id).includes(
        record.result.overview,
      ),
      false,
    );
    assert.match(exportMarkdown(ctx.store.snapshot()), /AI 辅助 · 梳理问题/);
  } finally {
    ctx.cleanup();
  }
});

test("edits may be accepted individually in either order then all without cascading replacements", () => {
  const ctx = setup();
  try {
    const record = makeRecord(ctx.store, ctx.note);
    saveNoteAssistance(ctx.store, record);
    const second = apply(ctx.store, record, "edit", { editIndex: 1 });
    assert.equal(
      second.body,
      original.replace("需要证据。", "需要可核对的证据。"),
    );
    assert.deepEqual(ctx.store.snapshot().noteAssists![0].appliedEdits, [1]);
    const all = apply(ctx.store, record, "all");
    assert.equal(
      all.body,
      original
        .replace("模糊的问题。", "明确的问题。")
        .replace("需要证据。", "需要可核对的证据。"),
    );
    assert.deepEqual(ctx.store.snapshot().noteAssists![0].appliedEdits, [0, 1]);
    assert.equal(
      ctx.store.snapshot().noteAssists![0].lastAppliedRevision,
      all.revision,
    );
    assert.throws(() => apply(ctx.store, record, "all"), isConflict);
    assert.equal(ctx.store.snapshot().noteRevisions?.length, 3);
    const base = "first token; second token";
    const noCascade = makeRecord(ctx.store, all, {
      baseBody: base,
      selection: null,
      result: {
        overview: "",
        edits: [
          { before: "first token", after: "second token", reason: "test" },
          { before: "second token", after: "third token", reason: "test" },
        ],
        suggestions: [],
      },
    });
    assert.equal(
      buildRevisedText(noCascade, [0, 1]),
      "second token; third token",
    );
  } finally {
    ctx.cleanup();
  }
});

test("selection is the exact immutable scope; repeated text outside it is never replaced", () => {
  const ctx = setup("相同句。\n\n另一段。\n\n相同句。");
  try {
    const from = ctx.note.body.lastIndexOf("相同句。");
    const selection = { from, to: from + 4, text: "相同句。" };
    const record = makeRecord(ctx.store, ctx.note, {
      selection,
      sources: [
        {
          id: `note:${ctx.note.id}`,
          kind: "note",
          title: ctx.note.title,
          text: selection.text,
          noteId: ctx.note.id,
        },
      ],
      result: {
        overview: "",
        edits: [{ before: "相同句。", after: "选段新句。", reason: "test" }],
        suggestions: [],
      },
    });
    saveNoteAssistance(ctx.store, record);
    assert.equal(
      apply(ctx.store, record, "all").body,
      "相同句。\n\n另一段。\n\n选段新句。",
    );
    assert.throws(
      () =>
        validateEdits(ctx.note.body, selection, [
          { before: "另一段。", after: "不应改", reason: "test" },
        ]),
      /唯一匹配/,
    );
    assert.throws(
      () =>
        validateEdits(ctx.note.body, { ...selection, text: "错误句。" }, []),
      isConflict,
    );
  } finally {
    ctx.cleanup();
  }
});

test("typing during generation and stale multi-window revisions preserve all new text without partial apply", () => {
  const ctx = setup();
  try {
    const record = makeRecord(ctx.store, ctx.note);
    const human = ctx.store.dispatch("note.update", {
      id: ctx.note.id,
      revision: ctx.note.revision,
      body: original + "\n\n生成期间新增文字。",
    }) as Note;
    saveNoteAssistance(ctx.store, record);
    const before = ctx.store.snapshot();
    assert.throws(() => apply(ctx.store, record, "all"), isConflict);
    assert.throws(
      () =>
        ctx.store.dispatch("note.assist.apply", {
          noteId: ctx.note.id,
          revision: 1,
          assistanceId: record.id,
          operation: "all",
        }),
      isConflict,
    );
    assert.deepEqual(ctx.store.snapshot(), before);
    assert.deepEqual(current(ctx.store, ctx.note.id), human);
    assert.throws(
      () => captureNoteRevision(ctx.store, ctx.note, "manual"),
      isConflict,
    );
  } finally {
    ctx.cleanup();
  }
});

test("suggestion insertion uses the fresh document and cursor without deleting text; old edits remain safely stale", () => {
  const ctx = setup();
  try {
    const record = makeRecord(ctx.store, ctx.note);
    saveNoteAssistance(ctx.store, record);
    const changed = ctx.store.dispatch("note.update", {
      id: ctx.note.id,
      revision: 1,
      body: "开头新增。" + original,
    }) as Note;
    const saved = apply(ctx.store, record, "insert", {
      suggestionIndex: 0,
      position: 5,
    });
    assert.ok(saved.body.startsWith("开头新增。\n\n### 待澄清问题"));
    assert.ok(saved.body.endsWith(original));
    assert.equal(changed.body, "开头新增。" + original);
    assert.throws(() => apply(ctx.store, record, "all"), isConflict);
    assert.throws(
      () =>
        apply(ctx.store, record, "insert", {
          suggestionIndex: 0,
          position: saved.body.length + 1,
        }),
      /位置无效/,
    );
    assert.deepEqual(ctx.store.snapshot().noteAssists![0].appliedEdits, []);
  } finally {
    ctx.cleanup();
  }
});

test("suggestion insertion cannot split protected tokens and rejected positions leave all stored state unchanged", () => {
  const snippets = [
    "$x+1$",
    "\\(a+b\\)",
    "\\[c+d\\]",
    "`const x = 1`",
    "```ts\nconst y = 2;\n```",
    "[原文](https://example.invalid/source)",
    "![图片](/api/kb/image?id=00000000-0000-4000-8000-000000000001)",
    "<span>",
  ];
  const body = "普通段落内容。\n\n" + snippets.join("\n\n") + "\n\n最后一句。";
  const ctx = setup(body);
  try {
    const record = makeRecord(ctx.store, ctx.note, {
      result: {
        overview: "测试插入位置保护",
        edits: [],
        suggestions: [
          {
            title: "待验证",
            body: "单独保存此研究建议。",
            basis: "hypothesis",
            evidenceIds: [],
          },
        ],
      },
    });
    saveNoteAssistance(ctx.store, record);
    const before = ctx.store.snapshot();
    for (const snippet of snippets) {
      const start = body.indexOf(snippet);
      assert.throws(
        () =>
          apply(ctx.store, record, "insert", {
            suggestionIndex: 0,
            position: start + 2,
          }),
        (error) =>
          error instanceof StoreError &&
          error.status === 422 &&
          /移动|移到/.test(error.message),
      );
      assert.deepEqual(ctx.store.snapshot(), before);
      assert.doesNotThrow(() => assertSafeInsertion(body, start));
      assert.doesNotThrow(() =>
        assertSafeInsertion(body, start + snippet.length),
      );
    }
    assert.doesNotThrow(() => assertSafeInsertion(body, 3));
    assert.doesNotThrow(() => assertSafeInsertion(body, body.length));
    const paragraph = apply(ctx.store, record, "insert", {
      suggestionIndex: 0,
      position: 3,
    });
    assert.ok(paragraph.body.startsWith("普通段\n\n### 待验证"));
    for (const snippet of snippets) assert.ok(paragraph.body.includes(snippet));
    const boundary = paragraph.body.indexOf("$x+1$");
    const inserted = apply(ctx.store, record, "insert", {
      suggestionIndex: 0,
      position: boundary,
    });
    assert.ok(inserted.body.includes("$x+1$"));
    assert.equal(ctx.store.snapshot().noteRevisions?.length, 3);
    assert.throws(() => assertSafeInsertion("字符😀结尾", 3), /插入位置无效/);
  } finally {
    ctx.cleanup();
  }
});

test("restoring an original draft preserves the current title and body as a reversible independent history", () => {
  const ctx = setup();
  try {
    const base = captureNoteRevision(ctx.store, ctx.note, "manual");
    const changed = ctx.store.dispatch("note.update", {
      id: ctx.note.id,
      revision: 1,
      title: "后来自己的标题",
      body: "后来自己的正文 $x^2$。",
    }) as Note;
    const restored = ctx.store.dispatch("note.revision.restore", {
      noteId: ctx.note.id,
      revision: changed.revision,
      snapshotId: base.id,
    }) as Note;
    assert.equal(restored.body, original);
    assert.equal(restored.title, ctx.note.title);
    const preserved = ctx.store
      .snapshot()
      .noteRevisions!.find((r) => r.reason === "before-restore")!;
    assert.equal(preserved.body, changed.body);
    assert.equal(preserved.title, changed.title);
    const forward = ctx.store.dispatch("note.revision.restore", {
      noteId: ctx.note.id,
      revision: restored.revision,
      snapshotId: preserved.id,
    }) as Note;
    assert.equal(forward.body, changed.body);
    assert.equal(forward.title, changed.title);
    const other = ctx.store.dispatch("note.create", {
      title: "其他笔记",
      purpose: "idea",
      body: "私有正文",
    }) as Note;
    assert.throws(
      () =>
        ctx.store.dispatch("note.revision.restore", {
          noteId: other.id,
          revision: 1,
          snapshotId: base.id,
        }),
      /不属于/,
    );
  } finally {
    ctx.cleanup();
  }
});

test("real mirror write failure rolls back note, AI applied status and before-apply history atomically", () => {
  const ctx = setup();
  try {
    const record = makeRecord(ctx.store, ctx.note);
    saveNoteAssistance(ctx.store, record);
    const before = ctx.store.snapshot();
    fs.renameSync(
      path.join(ctx.dir, "notes"),
      path.join(ctx.dir, "notes-unavailable"),
    );
    try {
      assert.throws(() => apply(ctx.store, record, "all"));
    } finally {
      fs.renameSync(
        path.join(ctx.dir, "notes-unavailable"),
        path.join(ctx.dir, "notes"),
      );
    }
    assert.deepEqual(ctx.store.snapshot(), before);
    ctx.restart();
    assert.deepEqual(ctx.store.snapshot(), before);
    assert.match(
      fs.readFileSync(path.join(ctx.dir, "notes", `${ctx.note.id}.md`), "utf8"),
      /模糊的问题/,
    );
  } finally {
    ctx.cleanup();
  }
});

test("patch validation rejects ambiguous and overlapping source matches, token damage and new fabricated links", () => {
  const edit = (before: string, after: string) => [
    { before, after, reason: "test" },
  ];
  assert.throws(
    () => validateEdits("same same", null, edit("same", "changed")),
    /唯一匹配/,
  );
  assert.throws(
    () =>
      validateEdits("abcdef", null, [
        { before: "abcd", after: "a", reason: "test" },
        { before: "cdef", after: "b", reason: "test" },
      ]),
    /重叠/,
  );
  for (const [body, after] of [
    ["公式 $x^2$。", "公式 $y^2$。"],
    ["代码 `x = 1`。", "代码 `x = 2`。"],
    ["代码\n\n```ts\nconst a = 1;\n```", "代码\n\n```ts\nconst a = 2;\n```"],
    ["图片 ![figure](/api/kb/image?id=" + randomUUID() + ")。", "无图片。"],
    [
      "来源 [原文](https://example.invalid/a)。",
      "来源 [原文](https://example.invalid/b)。",
    ],
    ["普通原文。", "普通原文。[伪造](kb://paper/" + randomUUID() + ")"],
    ["普通原文。", "普通原文。 $x$"],
  ])
    assert.throws(
      () => validateEdits(body, null, edit(body, after)),
      /公式、代码、图片或引用/,
    );
  assert.throws(
    () => validateEdits("保留 $x^2$。", null, edit("x^2", "y^2")),
    /截断/,
  );
  assert.throws(
    () => validateEdits("保留 \\(x+y\\)。", null, edit("x+y", "x-y")),
    /截断/,
  );
  assert.throws(
    () =>
      validateEdits(
        "保留 \\[x+y\\]。",
        null,
        edit("保留 \\[x+y\\]。", "保留 \\[x-y\\]。"),
      ),
    /公式、代码、图片或引用/,
  );
  assert.throws(
    () =>
      validateEdits("开头 $x$ 结尾", null, [
        { before: "开头", after: "`开头", reason: "test" },
        { before: "结尾", after: "结尾`", reason: "test" },
      ]),
    /整体结构/,
  );
  validateEdits(
    "原文 $x^2$ [原文](https://example.invalid/a)。",
    null,
    edit(
      "原文 $x^2$ [原文](https://example.invalid/a)。",
      "清晰原文 $x^2$ [原文](https://example.invalid/a)。",
    ),
  );
});

test("AI suggestion insertion permits only supplied source links and rejects new images, while restoring human examples is verbatim", () => {
  const ctx = setup();
  try {
    const paper = ctx.store.dispatch("paper.create", {
      title: "未选择的库内文献",
    }) as Paper;
    const bad = makeRecord(ctx.store, ctx.note, {
      result: {
        overview: "",
        edits: [],
        suggestions: [
          {
            title: "未读引用",
            body: `[未选择](kb://paper/${paper.id})`,
            basis: "hypothesis",
            evidenceIds: [],
          },
          {
            title: "新图片",
            body: `![AI图](/api/kb/image?id=${randomUUID()})`,
            basis: "hypothesis",
            evidenceIds: [],
          },
        ],
      },
    });
    saveNoteAssistance(ctx.store, bad);
    const before = ctx.store.snapshot();
    assert.throws(
      () => apply(ctx.store, bad, "insert", { suggestionIndex: 0 }),
      /未提供/,
    );
    assert.throws(
      () => apply(ctx.store, bad, "insert", { suggestionIndex: 1 }),
      /新图片/,
    );
    assert.deepEqual(ctx.store.snapshot(), before);
    const allowed = makeRecord(ctx.store, ctx.note, {
      paperIds: [paper.id],
      sources: [
        ...bad.sources,
        {
          id: `abstract:${paper.id}`,
          kind: "paper-abstract",
          title: paper.title,
          text: "明确测试摘要。",
          paperId: paper.id,
        },
      ],
      result: {
        overview: "",
        edits: [],
        suggestions: [
          {
            title: "已读引用",
            body: `[已选择](kb://paper/${paper.id})`,
            basis: "literature",
            evidenceIds: [`abstract:${paper.id}`],
          },
        ],
      },
    });
    saveNoteAssistance(ctx.store, allowed);
    assert.match(
      apply(ctx.store, allowed, "insert", { suggestionIndex: 0 }).body,
      /已选择/,
    );
    const latest = current(ctx.store, ctx.note.id);
    const humanBody = `[未解析旧引用](kb://paper/${randomUUID()})\n\n\`![示例](/api/kb/image?id=${randomUUID()})\``;
    const human = ctx.store.dispatch("note.update", {
      id: latest.id,
      revision: latest.revision,
      body: humanBody,
    }) as Note;
    const old = captureNoteRevision(ctx.store, human, "manual");
    const changed = ctx.store.dispatch("note.update", {
      id: human.id,
      revision: human.revision,
      body: "新版本",
    }) as Note;
    const restored = ctx.store.dispatch("note.revision.restore", {
      noteId: human.id,
      revision: changed.revision,
      snapshotId: old.id,
    }) as Note;
    assert.equal(restored.body, humanBody);
  } finally {
    ctx.cleanup();
  }
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function repack(value: { snapshot: unknown; snapshotSha256: string }): Buffer {
  value.snapshotSha256 = createHash("sha256")
    .update(canonical(value.snapshot))
    .digest("hex");
  return gzipSync(JSON.stringify(value));
}
test("full backup preserves all independent AI/history metadata and legacy archives default to empty arrays", () => {
  const ctx = setup();
  let restored: KBStore | undefined;
  try {
    const record = makeRecord(ctx.store, ctx.note);
    saveNoteAssistance(ctx.store, record);
    apply(ctx.store, record, "edit", { editIndex: 1 });
    const expected = ctx.store.snapshot();
    const backup = createBackup(ctx.store);
    const report = restoreBackup(backup, ctx.root);
    assert.equal(report.counts.noteAssists, 1);
    assert.equal(report.counts.noteRevisions, 2);
    restored = new KBStore(report.restoredDirectory);
    assert.deepEqual(restored.snapshot(), expected);
    restored.close();
    restored = undefined;
    const legacy = JSON.parse(gunzipSync(backup).toString()) as {
      snapshot: KBState;
      snapshotSha256: string;
    };
    delete legacy.snapshot.noteAssists;
    delete legacy.snapshot.noteRevisions;
    const oldReport = restoreBackup(repack(legacy), ctx.root);
    restored = new KBStore(oldReport.restoredDirectory);
    assert.deepEqual(restored.snapshot().noteAssists, []);
    assert.deepEqual(restored.snapshot().noteRevisions, []);
    assert.deepEqual(restored.snapshot().notes, expected.notes);
  } finally {
    restored?.close();
    ctx.cleanup();
  }
});

test("restore rejects foreign note IDs, duplicate applied indices and missing original snapshots cleanly", () => {
  const ctx = setup();
  try {
    saveNoteAssistance(ctx.store, makeRecord(ctx.store, ctx.note));
    const backup = createBackup(ctx.store);
    for (const damage of [
      (state: KBState) => {
        state.noteAssists![0].noteId = randomUUID();
      },
      (state: KBState) => {
        state.noteAssists![0].appliedEdits = [0, 0];
      },
      (state: KBState) => {
        state.noteRevisions = [];
      },
      (state: KBState) => {
        state.noteRevisions![0].noteId = randomUUID();
      },
    ]) {
      const manifest = JSON.parse(gunzipSync(backup).toString()) as {
        snapshot: KBState;
        snapshotSha256: string;
      };
      damage(manifest.snapshot);
      const before = fs.readdirSync(ctx.root).sort();
      assert.throws(() => restoreBackup(repack(manifest), ctx.root));
      assert.deepEqual(fs.readdirSync(ctx.root).sort(), before);
    }
  } finally {
    ctx.cleanup();
  }
});

test("portable bundles export AI/history as separate documents and include images only present in an older draft", () => {
  const ctx = setup();
  try {
    const image = addNoteImage(
      ctx.store,
      ctx.note.id,
      "history.png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const unused = addNoteImage(
      ctx.store,
      ctx.note.id,
      "not-referenced.gif",
      Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      ),
    );
    const withImage = ctx.store.dispatch("note.update", {
      id: ctx.note.id,
      revision: 1,
      body: original + `\n\n![历史图](/api/kb/image?id=${image.id})`,
    }) as Note;
    const record = makeRecord(ctx.store, withImage);
    saveNoteAssistance(ctx.store, record);
    ctx.store.dispatch("note.update", {
      id: withImage.id,
      revision: withImage.revision,
      body: "当前正文不含图片。",
    });
    const bundle = exportNoteBundle(ctx.store, ctx.note.id);
    const archive = path.join(ctx.root, "portable.tar.gz"),
      directory = path.join(ctx.root, "extract");
    fs.writeFileSync(archive, bundle);
    fs.mkdirSync(directory);
    const names = execFileSync("/usr/bin/tar", ["-tzf", archive], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    assert.ok(names.includes(`note-assists/${record.id}.md`));
    const revision = ctx.store.snapshot().noteRevisions![0];
    assert.ok(names.includes(`note-revisions/${revision.id}.md`));
    assert.ok(names.includes(image.relativePath));
    execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", directory]);
    assert.match(
      fs.readFileSync(path.join(directory, `notes/${ctx.note.id}.md`), "utf8"),
      /当前正文不含图片/,
    );
    assert.doesNotMatch(
      fs.readFileSync(path.join(directory, `notes/${ctx.note.id}.md`), "utf8"),
      /显式测试模型建议/,
    );
    assert.ok(
      fs
        .readFileSync(
          path.join(directory, `note-assists/${record.id}.md`),
          "utf8",
        )
        .includes(`../${image.relativePath}`),
    );
    assert.equal(
      createHash("sha256")
        .update(fs.readFileSync(path.join(directory, image.relativePath)))
        .digest("hex"),
      image.sha256,
    );
    // The whole-library manifest must be assembled after historical documents
    // contribute their images, and list exactly the files actually packed.
    const fullArchive = path.join(ctx.root, "all-portable.tar.gz");
    const fullDirectory = path.join(ctx.root, "all-extract");
    fs.writeFileSync(fullArchive, exportNoteBundle(ctx.store));
    fs.mkdirSync(fullDirectory);
    const fullNames = execFileSync("/usr/bin/tar", ["-tzf", fullArchive], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    execFileSync("/usr/bin/tar", ["-xzf", fullArchive, "-C", fullDirectory]);
    const metadata = JSON.parse(
      fs.readFileSync(path.join(fullDirectory, "library.json"), "utf8"),
    ) as { images: NoteImage[] };
    assert.deepEqual(metadata.images, [image]);
    assert.deepEqual(
      metadata.images.map((entry) => entry.relativePath).sort(),
      fullNames.filter((name) => name.startsWith("images/")).sort(),
    );
    assert.equal(fullNames.includes(unused.relativePath), false);
    assert.equal(
      createHash("sha256")
        .update(
          fs.readFileSync(
            path.join(fullDirectory, metadata.images[0].relativePath),
          ),
        )
        .digest("hex"),
      metadata.images[0].sha256,
    );
  } finally {
    ctx.cleanup();
  }
});

test("old on-disk databases receive additive empty history tables with original content untouched", () => {
  const ctx = setup();
  try {
    const before = ctx.store.snapshot().notes;
    ctx.store.db.exec("DROP TABLE note_assists; DROP TABLE note_revisions;");
    ctx.restart();
    assert.deepEqual(ctx.store.snapshot().notes, before);
    assert.deepEqual(ctx.store.snapshot().noteAssists, []);
    assert.deepEqual(ctx.store.snapshot().noteRevisions, []);
    const other = ctx.store.dispatch("note.create", {
      title: "另一篇",
      purpose: "idea",
      body: original,
    }) as Note;
    const foreign = makeRecord(ctx.store, other);
    saveNoteAssistance(ctx.store, foreign);
    assert.throws(
      () =>
        ctx.store.dispatch("note.assist.apply", {
          noteId: ctx.note.id,
          revision: 1,
          assistanceId: foreign.id,
          operation: "all",
        }),
      /不属于/,
    );
  } finally {
    ctx.cleanup();
  }
});
