import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { KBStore, StoreError } from "../src/lib/db";
import { addNoteImage } from "../src/lib/note-images";
import { exportNoteBundle, NOTE_BUNDLE_LIMIT } from "../src/lib/note-export";
import type { Note } from "../src/lib/types";

// A valid, deterministic one-pixel PNG; no paper or user image is used.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "research-kb-note-bundle-"));
  const store = new KBStore(path.join(root, "library"));
  const note = store.dispatch("note.create", {
    title: "插图与公式测试",
    purpose: "idea",
    body: "",
  }) as Note;
  return {
    root,
    store,
    note,
    cleanup() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function update(store: KBStore, id: string, body: string) {
  const note = store.snapshot().notes.find((candidate) => candidate.id === id)!;
  store.dispatch("note.update", { id, revision: note.revision, body });
}
/** The OS tar implementation, independent of the writer, checks and extracts USTAR. */
function extract(root: string, bundle: Buffer) {
  const archive = path.join(root, `${randomUUID()}.tar.gz`);
  const directory = path.join(root, `unpacked-${randomUUID()}`);
  mkdirSync(directory);
  writeFileSync(archive, bundle);
  const names = execFileSync("/usr/bin/tar", ["-tzf", archive], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", directory]);
  return { names, directory };
}

test("portable image bundle preserves Markdown, formulas, code examples and reference-style destinations", () => {
  const ctx = setup();
  try {
    const image = addNoteImage(
      ctx.store,
      ctx.note.id,
      "../../untrusted original name.png",
      png,
    );
    const url = `/api/kb/image?id=${image.id}`;
    const unused = randomUUID();
    const body = [
      "## 我的原文标题\n\nUnicode：论证 α；行内 $x_i$ 与独立公式：\n\n$$\nx_{n+1}=Ax_n\n$$",
      `![图 [嵌套] \\] 标签](${url} "原始标题")`,
      `![引用形式][Flow Diagram]\n\n[Flow Diagram]: <${url}> '引用标题'`,
      `![Flow Diagram]\n\n[无引用定义]: /api/kb/image?id=${unused}`,
      `$$\n\\text{![公式里的字面示例](${url})}\n$$`,
      "![在线图](https://example.invalid/do-not-fetch.png)",
      `[普通链接保持不变](${url})`,
      `\
\`行内代码 ![不要改](${url})\``,
      `\n\`\`\`markdown\n![代码图片](${url})\n[Flow Diagram]: ${url}\n\`\`\``,
      `    ![缩进代码](${url})`,
      `\\![转义图片](${url})`,
      "结尾原文与手写证明完全保留。",
    ].join("\n\n");
    update(ctx.store, ctx.note.id, body);
    const before = ctx.store.snapshot();
    const bundle = exportNoteBundle(ctx.store, ctx.note.id);
    const { names, directory } = extract(ctx.root, bundle);
    assert.deepEqual(
      names.sort(),
      ["README.md", `notes/${ctx.note.id}.md`, image.relativePath].sort(),
    );
    const exported = readFileSync(
      path.join(directory, "notes", `${ctx.note.id}.md`),
      "utf8",
    );
    const expected = body
      .replace(`](${url} "原始标题")`, `](../${image.relativePath} "原始标题")`)
      .replace(
        `[Flow Diagram]: <${url}>`,
        `[Flow Diagram]: <../${image.relativePath}>`,
      );
    assert.ok(
      exported.includes(expected),
      "only the two real image destination tokens change",
    );
    assert.equal(
      digest(readFileSync(path.join(directory, image.relativePath))),
      image.sha256,
    );
    assert.equal(
      readFileSync(path.join(directory, image.relativePath)).compare(png),
      0,
    );
    assert.equal(
      names.filter((name) => name.startsWith("images/")).length,
      1,
      "same image referenced three times is stored once",
    );
    assert.ok(
      names.every((name) => !name.includes("..") && !name.startsWith("/")),
    );
    assert.deepEqual(
      ctx.store.snapshot(),
      before,
      "export never modifies the user's library or Markdown mirror",
    );
    assert.ok(
      bundle.length <= NOTE_BUNDLE_LIMIT &&
        gunzipSync(bundle).length <= NOTE_BUNDLE_LIMIT,
    );
  } finally {
    ctx.cleanup();
  }
});

test("single-note bundles allow explicitly shared library images without exporting owner notes, unrelated images or AI reports", () => {
  const ctx = setup();
  try {
    const secret = "PRIVATE_OTHER_NOTE_BODY_never_include_in_single_note";
    const other = ctx.store.dispatch("note.create", {
      title: "另一篇私人笔记",
      purpose: "idea",
      body: secret,
    }) as Note;
    const privateImage = addNoteImage(ctx.store, other.id, "private.png", png);
    const unrelatedImage = addNoteImage(
      ctx.store,
      ctx.note.id,
      "unused.png",
      png,
    );
    update(
      ctx.store,
      other.id,
      `${secret}\n\n![private](/api/kb/image?id=${privateImage.id})`,
    );
    const paper = ctx.store.dispatch("paper.create", {
      title: "Synthetic metadata fixture",
    }) as { id: string };
    const ai = ctx.store.saveAI({
      paperId: paper.id,
      kind: "summary",
      body: "PRIVATE_AI_REPORT_fixture",
      provider: "fixture",
      model: "no-inference",
      sourceScope: "abstract",
      sourceAttachmentId: null,
      sourcePageIndices: [],
      sourceText: "Only a transport fixture",
      status: "completed",
    });
    update(
      ctx.store,
      ctx.note.id,
      "只导出这一条个人笔记。\n\n[库内文献](kb://paper/" +
        paper.id +
        ")" +
        `\n\n![明确引用同库图片](/api/kb/image?id=${privateImage.id})`,
    );
    const { names, directory } = extract(
      ctx.root,
      exportNoteBundle(ctx.store, ctx.note.id),
    );
    assert.deepEqual(
      names.sort(),
      [
        "README.md",
        `notes/${ctx.note.id}.md`,
        privateImage.relativePath,
      ].sort(),
    );
    for (const name of names.filter((name) => name.endsWith(".md"))) {
      const text = readFileSync(path.join(directory, name), "utf8");
      assert.ok(!text.includes(secret));
      assert.ok(!text.includes("PRIVATE_AI_REPORT_fixture"));
      assert.ok(!text.includes(unrelatedImage.id));
      assert.ok(!text.includes(other.id));
      assert.ok(!text.includes(ai.id));
    }
    assert.match(
      readFileSync(path.join(directory, `notes/${ctx.note.id}.md`), "utf8"),
      new RegExp(
        `!\\[明确引用同库图片\\]\\(\\.\\./images/${privateImage.id}\\.png\\)`,
      ),
    );
    assert.equal(
      digest(readFileSync(path.join(directory, privateImage.relativePath))),
      privateImage.sha256,
    );
  } finally {
    ctx.cleanup();
  }
});

test("whole-library bundle includes independent AI files and bibliographic metadata, never unreferenced image bytes", () => {
  const ctx = setup();
  try {
    const image = addNoteImage(ctx.store, ctx.note.id, "unreferenced.png", png);
    const paper = ctx.store.dispatch("paper.create", {
      title: "Metadata export fixture",
      doi: "10.1234/note-bundle-fixture",
    }) as { id: string };
    const ai = ctx.store.saveAI({
      paperId: paper.id,
      kind: "summary",
      body: "EXPLICIT_AI_FIXTURE",
      provider: "fixture",
      model: "no-inference",
      sourceScope: "abstract",
      sourceAttachmentId: null,
      sourcePageIndices: [],
      sourceText: "Transport fixture text",
      status: "completed",
    });
    const { names, directory } = extract(ctx.root, exportNoteBundle(ctx.store));
    assert.ok(names.includes(`notes/${ctx.note.id}.md`));
    assert.ok(names.includes(`ai/${ai.id}.md`));
    assert.ok(names.includes("library.json"));
    assert.ok(!names.includes(image.relativePath));
    assert.match(
      readFileSync(path.join(directory, `ai/${ai.id}.md`), "utf8"),
      /EXPLICIT_AI_FIXTURE/,
    );
    const metadata = JSON.parse(
      readFileSync(path.join(directory, "library.json"), "utf8"),
    ) as {
      papers: Array<{ id: string }>;
      images: unknown[];
      settings?: unknown;
    };
    assert.equal(metadata.papers[0].id, paper.id);
    assert.deepEqual(metadata.images, []);
    assert.equal(metadata.settings, undefined);
    assert.doesNotMatch(
      readFileSync(path.join(directory, `notes/${ctx.note.id}.md`), "utf8"),
      /EXPLICIT_AI_FIXTURE/,
    );
  } finally {
    ctx.cleanup();
  }
});

test("image bundles reject missing, tampered images, unsafe image paths and orphaned owners", () => {
  const ctx = setup();
  try {
    const image = addNoteImage(ctx.store, ctx.note.id, "figure.png", png);
    const filename = path.join(ctx.store.dataDir, image.relativePath);
    update(ctx.store, ctx.note.id, `![figure](/api/kb/image?id=${image.id})`);
    unlinkSync(filename);
    assert.throws(() => exportNoteBundle(ctx.store, ctx.note.id), /图片缺失/);
    const corrupted = Buffer.from(png);
    corrupted[corrupted.length - 1] ^= 1;
    writeFileSync(filename, corrupted);
    assert.throws(() => exportNoteBundle(ctx.store, ctx.note.id), /内容指纹/);
    writeFileSync(filename, png);
    ctx.store.db
      .prepare("UPDATE note_images SET relative_path=? WHERE id=?")
      .run("../../escape.png", image.id);
    assert.throws(() => exportNoteBundle(ctx.store, ctx.note.id));
    ctx.store.db
      .prepare("UPDATE note_images SET relative_path=? WHERE id=?")
      .run(image.relativePath, image.id);
    // A corrupted external database must not turn an orphan row into an asset.
    ctx.store.db.exec("PRAGMA foreign_keys=OFF");
    ctx.store.db
      .prepare("UPDATE note_images SET note_id=? WHERE id=?")
      .run(randomUUID(), image.id);
    assert.throws(
      () => exportNoteBundle(ctx.store, ctx.note.id),
      /原始所属笔记不存在/,
    );
  } finally {
    ctx.cleanup();
  }
});

test("bundle size caps fail before returning a partial archive, and unknown notes fail closed", () => {
  const ctx = setup();
  try {
    update(ctx.store, ctx.note.id, "A".repeat(8000));
    assert.throws(
      () => exportNoteBundle(ctx.store, ctx.note.id, { maxBytes: 4096 }),
      (error) => error instanceof StoreError && error.status === 413,
    );
    assert.throws(
      () => exportNoteBundle(ctx.store, randomUUID()),
      (error) => error instanceof StoreError && error.status === 404,
    );
    assert.throws(
      () => exportNoteBundle(ctx.store, ctx.note.id, { maxBytes: 512 }),
      (error) => error instanceof StoreError && error.status === 400,
    );
    assert.equal(ctx.store.snapshot().notes[0].body, "A".repeat(8000));
  } finally {
    ctx.cleanup();
  }
});
