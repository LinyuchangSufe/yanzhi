import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { KBStore, getStore } from "../src/lib/db";
import { createBackup, restoreBackup } from "../src/lib/archive";
import {
  addNoteImage,
  inspectNoteImage,
  MAX_NOTE_IMAGE_BYTES,
  readNoteImage,
} from "../src/lib/note-images";
import { GET, POST } from "../src/app/api/kb/image/route";
import type { KBState, Note, NoteImage } from "../src/lib/types";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFYkAAAAASUVORK5CYII=",
  "base64",
);
const gif = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-note-images-"));
  let store = new KBStore(path.join(root, "data"));
  const note = store.dispatch("note.create", {
    title: "图片测试笔记",
    purpose: "idea",
    body: "我的原始笔记 $x^2$",
  }) as Note;
  return {
    root,
    note,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new KBStore(path.join(root, "data"));
    },
    cleanup() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
interface Manifest {
  snapshot: KBState;
  snapshotSha256: string;
  files: Array<{ path: string; sha256: string; data: string }>;
}
function unpack(bytes: Buffer): Manifest {
  return JSON.parse(gunzipSync(bytes).toString()) as Manifest;
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
function pack(manifest: Manifest): Buffer {
  manifest.snapshotSha256 = createHash("sha256")
    .update(canonical(manifest.snapshot))
    .digest("hex");
  return gzipSync(JSON.stringify(manifest));
}

test("local images persist independently of human Markdown, deduplicate within a note and reopen safely", () => {
  const ctx = setup();
  try {
    const before = ctx.store.snapshot().notes;
    const mirror = fs.readFileSync(
      path.join(ctx.store.dataDir, "notes", `${ctx.note.id}.md`),
    );
    const image = addNoteImage(
      ctx.store,
      ctx.note.id,
      "../不可信图片.svg",
      png,
    );
    assert.equal(image.mimeType, "image/png");
    assert.match(image.relativePath, /^images\/[0-9a-f-]{36}\.png$/);
    assert.equal(image.filename, "不可信图片.svg");
    assert.equal(image.width, 1);
    assert.equal(image.height, 1);
    assert.deepEqual(ctx.store.snapshot().notes, before);
    assert.deepEqual(
      fs.readFileSync(
        path.join(ctx.store.dataDir, "notes", `${ctx.note.id}.md`),
      ),
      mirror,
    );
    assert.equal(
      addNoteImage(ctx.store, ctx.note.id, "same.png", png).id,
      image.id,
    );
    ctx.restart();
    assert.equal(ctx.store.snapshot().noteImages?.length, 1);
    assert.deepEqual(readNoteImage(ctx.store, image.id).bytes, png);
    assert.deepEqual(ctx.store.snapshot().notes, before);
    const second = ctx.store.dispatch("note.create", {
      title: "另一个笔记",
      body: "",
      purpose: "idea",
    }) as Note;
    assert.notEqual(
      addNoteImage(ctx.store, second.id, "same.png", png).id,
      image.id,
    );
  } finally {
    ctx.cleanup();
  }
});

test("raster validation rejects active content, corrupt headers, oversized payloads and decompression-sized dimensions", () => {
  assert.equal(inspectNoteImage(gif).mimeType, "image/gif");
  assert.throws(
    () =>
      inspectNoteImage(
        Buffer.from(
          "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
        ),
      ),
    /图片无效/,
  );
  assert.throws(
    () => inspectNoteImage(Buffer.from("<html><img src=x onerror=alert(1)>")),
    /图片无效/,
  );
  assert.throws(() => inspectNoteImage(png.subarray(0, 40)), /图片无效/);
  assert.throws(
    () => inspectNoteImage(Buffer.concat([png, Buffer.from("<html>")])),
    /图片无效/,
  );
  const tooWide = Buffer.from(png);
  tooWide.writeUInt32BE(20000, 16);
  assert.throws(() => inspectNoteImage(tooWide), /图片尺寸/);
  const tooManyPixels = Buffer.from(png);
  tooManyPixels.writeUInt32BE(10000, 16);
  tooManyPixels.writeUInt32BE(10000, 20);
  assert.throws(() => inspectNoteImage(tooManyPixels), /图片尺寸/);
  assert.throws(
    () => inspectNoteImage(Buffer.alloc(MAX_NOTE_IMAGE_BYTES + 1)),
    /10 MiB/,
  );
});

test("missing note and real database failures leave no orphan image files or note modifications", () => {
  const ctx = setup();
  try {
    const before = ctx.store.snapshot().notes;
    assert.throws(
      () => addNoteImage(ctx.store, randomUUID(), "a.png", png),
      /先保存笔记/,
    );
    ctx.store.db.exec(
      "CREATE TRIGGER fail_image BEFORE INSERT ON note_images BEGIN SELECT RAISE(ABORT,'forced storage failure'); END;",
    );
    assert.throws(
      () => addNoteImage(ctx.store, ctx.note.id, "a.png", png),
      /forced storage failure/,
    );
    assert.deepEqual(
      fs.readdirSync(path.join(ctx.store.dataDir, "images")),
      [],
    );
    assert.deepEqual(ctx.store.snapshot().notes, before);
    assert.equal(ctx.store.snapshot().noteImages?.length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("image reads reject tampering, symlink files and symlink image directories", () => {
  const ctx = setup();
  try {
    const image = addNoteImage(ctx.store, ctx.note.id, "safe.png", png);
    const filename = path.join(ctx.store.dataDir, image.relativePath);
    fs.writeFileSync(filename, Buffer.concat([png, Buffer.from("tamper")]));
    assert.throws(() => readNoteImage(ctx.store, image.id), /指纹|容量/);
    fs.unlinkSync(filename);
    const external = path.join(ctx.root, "external.png");
    fs.writeFileSync(external, png);
    fs.symlinkSync(external, filename);
    assert.throws(() => readNoteImage(ctx.store, image.id), /符号链接/);
    assert.throws(() => createBackup(ctx.store), /符号链接/);
    fs.unlinkSync(filename);
    const dir = path.join(ctx.store.dataDir, "images"),
      moved = path.join(ctx.root, "images-moved");
    fs.renameSync(dir, moved);
    fs.symlinkSync(moved, dir);
    assert.throws(
      () => addNoteImage(ctx.store, ctx.note.id, "another.gif", gif),
      /符号链接/,
    );
    fs.unlinkSync(dir);
    fs.renameSync(moved, dir);
  } finally {
    ctx.cleanup();
  }
});

test("full backups retain image bytes and stable Markdown URLs while old backups acquire an empty image list", () => {
  const ctx = setup();
  let restored: KBStore | undefined, legacy: KBStore | undefined;
  try {
    const image = addNoteImage(ctx.store, ctx.note.id, "实验图.png", png);
    const body = `我的说明。\n\n![实验图](/api/kb/image?id=${image.id})`;
    ctx.store.dispatch("note.update", {
      id: ctx.note.id,
      revision: ctx.note.revision,
      body,
    });
    const expected = ctx.store.snapshot();
    const bytes = createBackup(ctx.store),
      manifest = unpack(bytes);
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].path, image.relativePath);
    const report = restoreBackup(bytes, ctx.root);
    restored = new KBStore(report.restoredDirectory);
    assert.deepEqual(restored.snapshot(), expected);
    assert.deepEqual(readNoteImage(restored, image.id).bytes, png);
    assert.equal(restored.snapshot().notes[0].body, body);
    const old = unpack(bytes);
    delete old.snapshot.noteImages;
    old.files = [];
    const oldReport = restoreBackup(pack(old), ctx.root);
    legacy = new KBStore(oldReport.restoredDirectory);
    assert.deepEqual(legacy.snapshot().noteImages, []);
    assert.equal(legacy.snapshot().notes[0].body, body);
  } finally {
    restored?.close();
    legacy?.close();
    ctx.cleanup();
  }
});

test("backup restore rejects omitted images, tampered bytes, mismatched path or type and foreign note ownership", () => {
  const ctx = setup();
  try {
    addNoteImage(ctx.store, ctx.note.id, "safe.png", png);
    const bytes = createBackup(ctx.store),
      before = fs.readdirSync(ctx.root).sort();
    const missing = unpack(bytes);
    missing.files = [];
    assert.throws(
      () => restoreBackup(pack(missing), ctx.root),
      /缺少必要笔记图片/,
    );
    const tampered = unpack(bytes);
    tampered.files[0].data = gif.toString("base64");
    assert.throws(() => restoreBackup(pack(tampered), ctx.root), /校验/);
    const owner = unpack(bytes);
    owner.snapshot.noteImages![0].noteId = randomUUID();
    assert.throws(() => restoreBackup(pack(owner), ctx.root), /有效笔记/);
    const name = unpack(bytes);
    name.snapshot.noteImages![0].relativePath = `images/${randomUUID()}.png`;
    name.files[0].path = name.snapshot.noteImages![0].relativePath;
    assert.throws(() => restoreBackup(pack(name), ctx.root), /路径|ID/);
    const wrongType = unpack(bytes);
    wrongType.snapshot.noteImages![0].mimeType = "image/gif";
    assert.throws(() => restoreBackup(pack(wrongType), ctx.root), /格式|路径/);
    const traversal = unpack(bytes);
    traversal.files[0].path = "../outside.png";
    assert.throws(() => restoreBackup(pack(traversal), ctx.root));
    assert.deepEqual(fs.readdirSync(ctx.root).sort(), before);
  } finally {
    ctx.cleanup();
  }
});

test("missing images retain their identity through backup rather than silently rewriting human notes", () => {
  const ctx = setup();
  let restored: KBStore | undefined;
  try {
    const image = addNoteImage(ctx.store, ctx.note.id, "missing.png", png);
    fs.unlinkSync(path.join(ctx.store.dataDir, image.relativePath));
    assert.equal(ctx.store.snapshot().noteImages?.[0].status, "missing");
    const report = restoreBackup(createBackup(ctx.store), ctx.root);
    restored = new KBStore(report.restoredDirectory);
    assert.equal(restored.snapshot().noteImages?.[0].id, image.id);
    assert.equal(restored.snapshot().noteImages?.[0].status, "missing");
    assert.match(report.warnings.join("\n"), /缺失笔记图片/);
    assert.equal(restored.snapshot().notes[0].body, ctx.note.body);
  } finally {
    restored?.close();
    ctx.cleanup();
  }
});

test("multipart route stores actual raster content and serves a protected same-origin image without mutating notes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-note-image-api-"));
  const previous = process.env.KB_DATA_DIR;
  process.env.KB_DATA_DIR = root;
  const store = getStore();
  try {
    const note = store.dispatch("note.create", {
      title: "API 笔记",
      purpose: "idea",
      body: "保持不变",
    }) as Note;
    const form = new FormData();
    form.set("noteId", note.id);
    form.set("file", new File([png], "figure.svg", { type: "image/svg+xml" }));
    const request = new Request("http://127.0.0.1:3000/api/kb/image", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
      body: form,
    });
    const response = await POST(request);
    assert.equal(response.status, 200);
    const result = (await response.json()) as { result: NoteImage };
    assert.equal(result.result.mimeType, "image/png");
    assert.equal(store.snapshot().notes[0].body, "保持不变");
    const image = GET(
      new Request(`http://127.0.0.1:3000/api/kb/image?id=${result.result.id}`),
    );
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      image.headers.get("cross-origin-resource-policy"),
      "same-origin",
    );
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    const denied = GET(
      new Request(`http://127.0.0.1:3000/api/kb/image?id=${result.result.id}`, {
        headers: {
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
      }),
    );
    assert.equal(denied.status, 403);
    const bad = new FormData();
    bad.set("noteId", note.id);
    bad.set(
      "file",
      new File(["<svg onload=alert(1) />"], "figure.png", {
        type: "image/png",
      }),
    );
    assert.equal(
      (
        await POST(
          new Request("http://localhost/api/kb/image", {
            method: "POST",
            body: bad,
          }),
        )
      ).status,
      415,
    );
    const oversized = new Request("http://localhost/api/kb/image", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(MAX_NOTE_IMAGE_BYTES + 100000),
      },
      body: "x",
    });
    assert.equal((await POST(oversized)).status, 413);
  } finally {
    store.close();
    if (previous === undefined) delete process.env.KB_DATA_DIR;
    else process.env.KB_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
