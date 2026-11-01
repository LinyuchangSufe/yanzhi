import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { KBStore } from "./db";
import { StoreError } from "./store-error";
import type { Attachment, Paper } from "./types";

export interface SharedPDF {
  paperId: string;
  attachmentId: string;
  filename: string;
  path: string;
}
export interface PDFShareResult {
  directory: string;
  files: SharedPDF[];
  /** Papers in this request with no available PDF, not missing attachment count. */
  missingCount: number;
  opened: boolean;
  warning?: string;
}

const MAX_FILENAME_BYTES = 220;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function truncateUTF8(value: string, budget: number): string {
  let result = "";
  let size = 0;
  for (const char of value) {
    const next = Buffer.byteLength(char);
    if (size + next > budget) break;
    result += char;
    size += next;
  }
  return result.replace(/[. ]+$/u, "");
}

function filenamePart(value: string, fallback: string, budget: number): string {
  return (
    truncateUTF8(
      value
        .normalize("NFC")
        .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
        .replace(/\s+/gu, " ")
        .replace(/^[. ]+|[. ]+$/gu, ""),
      budget,
    ) || fallback
  );
}

/** Readable copies only; library attachment identifiers and names are untouched. */
export function pdfShareFilename(
  paper: Pick<Paper, "year" | "authors" | "title">,
  attachment: Pick<Attachment, "filename">,
  index = 0,
  count = 1,
): string {
  const year = paper.year === null ? "年份未知" : String(paper.year);
  const author = filenamePart(paper.authors[0] ?? "", "作者未知", 48);
  const title = filenamePart(paper.title, "未命名文献", 140);
  const suffix = count > 1
    ? ` - 附件 ${String(index + 1).padStart(2, "0")} - ${filenamePart(attachment.filename.replace(/\.pdf$/iu, ""), "PDF", 55)}`
    : "";
  const stem = truncateUTF8(
    `${year} - ${author} - ${title}`,
    MAX_FILENAME_BYTES - Buffer.byteLength(suffix) - 4,
  );
  return `${stem}${suffix}.pdf`;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

function safeDirectory(directory: string, parent?: string): void {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new StoreError("分享目录包含符号链接或不是文件夹，请移走冲突项后重试。", 409);
  if (parent && realpathSync(directory) !== path.join(parent, path.basename(directory)))
    throw new StoreError("分享目录超出本地数据目录。", 409);
}

function ensureChildDirectory(parent: string, name: string): string {
  safeDirectory(parent);
  const directory = path.join(parent, name);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  safeDirectory(directory, parent);
  return directory;
}

function regularFileBytes(filename: string): Buffer {
  const before = lstatSync(filename);
  if (before.isSymbolicLink() || !before.isFile())
    throw new StoreError("拒绝读取或覆盖符号链接及非普通 PDF 文件。", 409);
  if (before.size > MAX_PDF_BYTES)
    throw new StoreError("PDF 文件超过 100 MiB，拒绝读取。", 409);
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_PDF_BYTES || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new StoreError("PDF 文件在读取时发生变化，请重试。", 409);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function sourceBytes(store: KBStore, attachment: Attachment): Buffer {
  // Check links before attachmentPath's own canonical-path and fingerprint check.
  const root = realpathSync(store.dataDir);
  const attachmentDirectory = path.join(root, "attachments");
  safeDirectory(attachmentDirectory, root);
  const expected = path.resolve(root, attachment.relativePath);
  if (path.dirname(expected) !== attachmentDirectory)
    throw new StoreError("附件路径无效，拒绝导出。", 409);
  const initial = lstatSync(expected);
  if (initial.isSymbolicLink() || !initial.isFile())
    throw new StoreError("拒绝分享符号链接或非普通附件。", 409);
  if (initial.size > MAX_PDF_BYTES)
    throw new StoreError("PDF 文件超过 100 MiB，拒绝分享。", 409);
  const original = store.attachmentPath(attachment.id);
  safeDirectory(attachmentDirectory, root);
  if (realpathSync(original) !== expected)
    throw new StoreError("附件路径在读取时发生变化，请重试。", 409);
  const bytes = regularFileBytes(expected);
  if (digest(bytes) !== attachment.sha256)
    throw new StoreError("PDF 指纹已改变，请先恢复原附件后再分享。", 409);
  return bytes;
}

function collisionName(filename: string, sha256: string, attempt: number): string {
  if (!attempt) return filename;
  const suffix = ` - ${sha256.slice(0, 10)}${attempt > 1 ? `-${attempt}` : ""}.pdf`;
  return truncateUTF8(filename.slice(0, -4), MAX_FILENAME_BYTES - Buffer.byteLength(suffix)) + suffix;
}

function writeCopy(directory: string, filename: string, bytes: Buffer, sha256: string): string {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    safeDirectory(directory, path.dirname(directory));
    safeDirectory(path.dirname(directory), path.dirname(path.dirname(directory)));
    const candidate = path.join(directory, collisionName(filename, sha256, attempt));
    let fd: number;
    try {
      // Exclusive creation never truncates a user's copy, a hard link, or a symlink.
      fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const existingStat = lstatSync(candidate);
      if (existingStat.isSymbolicLink() || !existingStat.isFile())
        throw new StoreError("拒绝读取或覆盖符号链接及非普通 PDF 文件。", 409);
      // A hard link may be the original attachment: preserve it and create an independent copy.
      if (existingStat.nlink > 1) continue;
      if (existingStat.size === bytes.length && digest(regularFileBytes(candidate)) === sha256) return candidate;
      continue;
    }
    try {
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    safeDirectory(directory, path.dirname(directory));
    if (digest(regularFileBytes(candidate)) !== sha256)
      throw new StoreError("分享副本核验失败，请重试。", 409);
    return candidate;
  }
  throw new StoreError("分享文件夹中同名文件过多，请整理后重试。", 409);
}

export function preparePDFShare(store: KBStore, paperId?: string): PDFShareResult {
  const state = store.snapshot();
  const selected = paperId
    ? state.papers.filter((paper) => paper.id === paperId)
    : state.papers.filter((paper) => !paper.deletedAt);
  if (paperId && !selected.length) throw new StoreError("文献不存在。", 404);
  if (selected.some((paper) => paper.deletedAt))
    throw new StoreError("文献已在回收站，请先恢复后再分享。", 409);
  const root = realpathSync(store.dataDir);
  safeDirectory(root);
  const directory = ensureChildDirectory(ensureChildDirectory(root, "share"), "papers");
  const files: SharedPDF[] = [];
  let missingCount = 0;
  let missingAttachments = 0;
  for (const paper of selected) {
    const attachments = state.attachments
      .filter((attachment) => attachment.paperId === paper.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    let sharedCount = 0;
    for (const [index, attachment] of attachments.entries()) {
      if (attachment.status !== "available") {
        missingAttachments++;
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = sourceBytes(store, attachment);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        missingAttachments++;
        continue;
      }
      const target = writeCopy(directory, pdfShareFilename(paper, attachment, index, attachments.length), bytes, attachment.sha256);
      files.push({ paperId: paper.id, attachmentId: attachment.id, filename: path.basename(target), path: target });
      sharedCount++;
    }
    if (!sharedCount) missingCount++;
  }
  return {
    directory,
    files,
    missingCount,
    opened: false,
    ...(missingAttachments ? { warning: `有 ${missingAttachments} 个 PDF 附件在本地缺失，已跳过。` } : {}),
  };
}
