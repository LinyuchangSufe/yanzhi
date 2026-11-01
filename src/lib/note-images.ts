import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { KBStore } from "./db";
import { StoreError } from "./db";
import type { NoteImage } from "./types";
import { noteImageSchema, uuid } from "./validation";

export const MAX_NOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const extensions = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;
type ImageInfo = Pick<NoteImage, "mimeType" | "width" | "height">;
function invalid(): never {
  throw new StoreError("图片无效；请使用 PNG、JPEG、WebP 或 GIF 栅格图片", 415);
}
function dimensions(info: ImageInfo, frames = 1): ImageInfo {
  if (
    !Number.isInteger(info.width) ||
    !Number.isInteger(info.height) ||
    info.width < 1 ||
    info.height < 1 ||
    info.width > 16384 ||
    info.height > 16384 ||
    info.width * info.height > MAX_PIXELS ||
    frames > 200 ||
    frames < 1 ||
    info.width * info.height * frames > 80_000_000
  )
    throw new StoreError(
      "图片尺寸或动画帧过多；单边最多 16384 像素、总像素最多 4000 万",
      413,
    );
  return info;
}
/** Inspect the actual raster container, never trust an extension or uploaded MIME. */
export function inspectNoteImage(input: Uint8Array): ImageInfo {
  const b = Buffer.from(input);
  if (!b.length || b.length > MAX_NOTE_IMAGE_BYTES)
    throw new StoreError("图片不得超过 10 MiB", 413);
  if (
    b.length >= 33 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    if (b.readUInt32BE(8) !== 13 || b.toString("ascii", 12, 16) !== "IHDR")
      invalid();
    const info: ImageInfo = {
      mimeType: "image/png",
      width: b.readUInt32BE(16),
      height: b.readUInt32BE(20),
    };
    let offset = 8,
      data = false,
      ended = false,
      frames = 1;
    while (offset + 12 <= b.length) {
      const length = b.readUInt32BE(offset),
        name = b.toString("ascii", offset + 4, offset + 8);
      if (length > b.length - offset - 12) invalid();
      if (name === "IDAT") data = true;
      if (name === "acTL") {
        if (length !== 8) invalid();
        frames = b.readUInt32BE(offset + 8);
      }
      offset += length + 12;
      if (name === "IEND") {
        if (length || offset !== b.length) invalid();
        ended = true;
        break;
      }
    }
    if (!data || !ended) invalid();
    return dimensions(info, frames);
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2,
      info: ImageInfo | undefined,
      scan = false;
    while (offset < b.length - 1) {
      if (b[offset++] !== 0xff) invalid();
      while (b[offset] === 0xff) offset++;
      const marker = b[offset++];
      if (marker === 0xd9) break;
      if (marker === 0xd8 || marker === 0x00) invalid();
      if (marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > b.length) invalid();
      const length = b.readUInt16BE(offset);
      if (length < 2 || offset + length > b.length) invalid();
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        if (length < 8 || info) invalid();
        info = dimensions({
          mimeType: "image/jpeg",
          height: b.readUInt16BE(offset + 3),
          width: b.readUInt16BE(offset + 5),
        });
      }
      if (marker === 0xda) {
        scan = true;
        break;
      }
      offset += length;
    }
    if (!info || !scan || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9)
      invalid();
    return dimensions(info);
  }
  if (
    b.length >= 14 &&
    ["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6))
  ) {
    const info: ImageInfo = {
      mimeType: "image/gif",
      width: b.readUInt16LE(6),
      height: b.readUInt16LE(8),
    };
    let offset = 13 + (b[10] & 0x80 ? 3 * (1 << ((b[10] & 7) + 1)) : 0),
      frames = 0,
      ended = false;
    const skipBlocks = () => {
      while (offset < b.length) {
        const size = b[offset++];
        if (!size) return;
        offset += size;
        if (offset > b.length) invalid();
      }
      invalid();
    };
    while (offset < b.length) {
      const marker = b[offset++];
      if (marker === 0x3b) {
        ended = offset === b.length;
        break;
      }
      if (marker === 0x21) {
        if (offset >= b.length) invalid();
        offset++;
        skipBlocks();
        continue;
      }
      if (marker !== 0x2c || offset + 9 > b.length) invalid();
      const width = b.readUInt16LE(offset + 4),
        height = b.readUInt16LE(offset + 6),
        packed = b[offset + 8];
      if (
        !width ||
        !height ||
        b.readUInt16LE(offset) + width > info.width ||
        b.readUInt16LE(offset + 2) + height > info.height
      )
        invalid();
      offset += 9 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
      if (offset >= b.length || b[offset] < 2 || b[offset] > 8) invalid();
      offset++;
      skipBlocks();
      frames++;
    }
    if (!ended || !frames) invalid();
    return dimensions(info, frames);
  }
  if (
    b.length >= 20 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    if (b.readUInt32LE(4) + 8 !== b.length) invalid();
    let offset = 12,
      info: ImageInfo | undefined,
      payload = false,
      frames = 0;
    while (offset + 8 <= b.length) {
      const name = b.toString("ascii", offset, offset + 4),
        size = b.readUInt32LE(offset + 4),
        start = offset + 8;
      if (start + size > b.length) invalid();
      if (name === "VP8X") {
        if (size !== 10 || info) invalid();
        info = {
          mimeType: "image/webp",
          width: b.readUIntLE(start + 4, 3) + 1,
          height: b.readUIntLE(start + 7, 3) + 1,
        };
      } else if (name === "VP8L") {
        if (size < 5 || b[start] !== 0x2f) invalid();
        const bits = b.readUInt32LE(start + 1);
        const frame = dimensions({
          mimeType: "image/webp",
          width: (bits & 0x3fff) + 1,
          height: ((bits >>> 14) & 0x3fff) + 1,
        });
        if (
          info &&
          (info.width !== frame.width || info.height !== frame.height)
        )
          invalid();
        info ??= frame;
        payload = true;
      } else if (name === "VP8 ") {
        if (
          size < 10 ||
          !b
            .subarray(start + 3, start + 6)
            .equals(Buffer.from([0x9d, 0x01, 0x2a]))
        )
          invalid();
        const frame = dimensions({
          mimeType: "image/webp",
          width: b.readUInt16LE(start + 6) & 0x3fff,
          height: b.readUInt16LE(start + 8) & 0x3fff,
        });
        if (
          info &&
          (info.width !== frame.width || info.height !== frame.height)
        )
          invalid();
        info ??= frame;
        payload = true;
      } else if (name === "ANMF") {
        if (size < 24 || !info) invalid();
        const frameWidth = b.readUIntLE(start + 6, 3) + 1;
        const frameHeight = b.readUIntLE(start + 9, 3) + 1;
        if (
          b.readUIntLE(start, 3) * 2 + frameWidth > info.width ||
          b.readUIntLE(start + 3, 3) * 2 + frameHeight > info.height
        )
          invalid();
        frames++;
        payload = true;
      }
      offset = start + size + (size & 1);
    }
    if (!info || !payload || offset !== b.length) invalid();
    return dimensions(info, frames || 1);
  }
  return invalid();
}

function imageDirectory(store: KBStore): string {
  const dir = path.join(store.dataDir, "images");
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(dir) !== path.join(fs.realpathSync(store.dataDir), "images")
  )
    throw new StoreError("拒绝读取符号链接或数据目录外的笔记图片", 400);
  return dir;
}
export function initializeNoteImages(store: KBStore) {
  const dir = path.join(store.dataDir, "images");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  imageDirectory(store);
  store.db.exec(`CREATE TABLE IF NOT EXISTS note_images (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id), relative_path TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL,
    byte_size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(note_id, sha256));`);
}
function decode(row: Record<string, unknown>): NoteImage {
  return noteImageSchema.parse({
    id: row.id,
    noteId: row.note_id,
    relativePath: row.relative_path,
    filename: row.filename,
    mimeType: row.mime_type,
    sha256: row.sha256,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    status: "available",
  });
}
export function validateNoteImageRecord(image: NoteImage) {
  noteImageSchema.parse(image);
  if (image.relativePath !== `images/${image.id}.${extensions[image.mimeType]}`)
    throw new StoreError("笔记图片路径、ID或格式不一致", 400);
}
export function noteImageSnapshot(store: KBStore): NoteImage[] {
  return store.db
    .prepare("SELECT * FROM note_images ORDER BY created_at,id")
    .all()
    .map((row) => {
      const image = decode(row);
      let available = false;
      try {
        const stat = fs.lstatSync(path.join(store.dataDir, image.relativePath));
        available = stat.isFile() && !stat.isSymbolicLink();
      } catch {
        /* A missing original stays indexed, retaining its stable Markdown URL. */
      }
      return { ...image, status: available ? "available" : "missing" };
    });
}
function insert(store: KBStore, image: NoteImage) {
  store.db
    .prepare(
      "INSERT INTO note_images(id,note_id,relative_path,filename,mime_type,sha256,byte_size,width,height,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      image.id,
      image.noteId,
      image.relativePath,
      image.filename,
      image.mimeType,
      image.sha256,
      image.byteSize,
      image.width,
      image.height,
      image.createdAt,
    );
}
/** Called inside the snapshot transaction after all parent notes have been inserted. */
export function importNoteImages(store: KBStore, images: NoteImage[]) {
  imageDirectory(store);
  for (const image of images) {
    validateNoteImageRecord(image);
    if (!store.db.prepare("SELECT id FROM notes WHERE id=?").get(image.noteId))
      throw new StoreError("备份图片不属于有效笔记", 400);
    insert(store, image);
    const filename = path.join(store.dataDir, image.relativePath);
    if (
      fs.existsSync(filename) ||
      (() => {
        try {
          return fs.lstatSync(filename).isSymbolicLink();
        } catch {
          return false;
        }
      })()
    )
      readNoteImage(store, image.id);
  }
}
export function readNoteImage(
  store: KBStore,
  id: string,
): { image: NoteImage; bytes: Buffer } {
  uuid.parse(id);
  const row = store.db.prepare("SELECT * FROM note_images WHERE id=?").get(id);
  if (!row) throw new StoreError("笔记图片不存在", 404);
  const image = decode(row);
  validateNoteImageRecord(image);
  const filename = path.join(
    imageDirectory(store),
    path.basename(image.relativePath),
  );
  let descriptor: number | undefined;
  try {
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new StoreError("拒绝读取符号链接或非普通图片文件", 400);
    descriptor = fs.openSync(
      filename,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    if (fs.fstatSync(descriptor).size !== image.byteSize)
      throw new StoreError("笔记图片内容指纹或容量已改变", 409);
    const bytes = fs.readFileSync(descriptor),
      info = inspectNoteImage(bytes);
    if (
      hash(bytes) !== image.sha256 ||
      info.mimeType !== image.mimeType ||
      info.width !== image.width ||
      info.height !== image.height
    )
      throw new StoreError("笔记图片内容指纹或格式已改变", 409);
    return { image, bytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new StoreError("笔记图片文件缺失，请从完整备份恢复", 404);
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
export function addNoteImage(
  store: KBStore,
  noteId: string,
  filename: string,
  input: Uint8Array,
): NoteImage {
  uuid.parse(noteId);
  if (!store.db.prepare("SELECT id FROM notes WHERE id=?").get(noteId))
    throw new StoreError("请先保存笔记，再插入图片", 404);
  const info = inspectNoteImage(input),
    bytes = Buffer.from(input),
    sha256 = hash(bytes);
  const prior = store.db
    .prepare("SELECT * FROM note_images WHERE note_id=? AND sha256=?")
    .get(noteId, sha256);
  if (prior) {
    const image = decode(prior);
    readNoteImage(store, image.id);
    return image;
  }
  const id = randomUUID();
  const image: NoteImage = {
    id,
    noteId,
    relativePath: `images/${id}.${extensions[info.mimeType]}`,
    filename:
      path
        .basename(filename.replaceAll("\\", "/"))
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .slice(0, 255) || `image.${extensions[info.mimeType]}`,
    ...info,
    sha256,
    byteSize: bytes.length,
    createdAt: new Date().toISOString(),
    status: "available",
  };
  const target = path.join(
    imageDirectory(store),
    path.basename(image.relativePath),
  );
  let descriptor: number | undefined,
    created = false;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    store.db.exec("BEGIN IMMEDIATE");
    try {
      insert(store, image);
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    return image;
  } catch (error) {
    if (created) fs.rmSync(target, { force: true });
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
