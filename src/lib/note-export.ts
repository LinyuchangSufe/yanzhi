import { gzipSync } from "node:zlib";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  exportAIMarkdown,
  exportMarkdown,
  exportNoteAssistanceMarkdown,
  exportNoteRevisionMarkdown,
} from "./archive";
import { KBStore, StoreError } from "./db";
import { readNoteImage } from "./note-images";
import type { KBState, Note, NoteImage } from "./types";

export const NOTE_BUNDLE_LIMIT = 256 * 1024 * 1024;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface MarkdownNode {
  type: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
interface Replacement {
  start: number;
  end: number;
  value: string;
}
interface ArchiveFile {
  name: string;
  bytes: Buffer;
}
const identifier = (value: string) => value.toLowerCase().replace(/\s+/g, " ");
const walk = (node: MarkdownNode, fn: (node: MarkdownNode) => void) => {
  fn(node);
  for (const child of node.children ?? []) walk(child, fn);
};

function localImageId(url: string): string | undefined {
  const match = url.match(/^\/api\/kb\/image\?id=([0-9a-f-]+)$/i);
  if (match && uuidPattern.test(match[1])) return match[1].toLowerCase();
  if (/^\/api\/kb\/image(?:[?#/]|$)/i.test(url))
    throw new StoreError("笔记含无效的本地图片链接，请重新插入该图片", 409);
  return undefined;
}

/** Find only the destination token of a parsed image/definition; retain all other bytes. */
function destinationRange(body: string, node: MarkdownNode): [number, number] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined)
    throw new StoreError("无法定位笔记图片的 Markdown 写法", 422);
  let cursor = start + (node.type === "image" ? 1 : 0);
  if (body[cursor] !== "[")
    throw new StoreError("无法定位笔记图片的 Markdown 链接", 422);
  let depth = 1;
  for (cursor++; cursor < end && depth; cursor++) {
    if (body[cursor] === "\\") cursor++;
    else if (body[cursor] === "[") depth++;
    else if (body[cursor] === "]") depth--;
  }
  const marker = node.type === "image" ? "(" : ":";
  if (depth || body[cursor] !== marker)
    throw new StoreError("无法定位笔记图片的 Markdown 目标", 422);
  cursor++;
  while (/\s/.test(body[cursor] ?? "") && cursor < end) cursor++;
  if (body[cursor] === "<") {
    const first = ++cursor;
    for (; cursor < end; cursor++) {
      if (body[cursor] === "\\") cursor++;
      else if (body[cursor] === ">") return [first, cursor];
    }
  } else {
    const first = cursor;
    let parentheses = 0;
    for (; cursor < end; cursor++) {
      const character = body[cursor];
      if (character === "\\") cursor++;
      else if (character === "(") parentheses++;
      else if (character === ")") {
        if (!parentheses) break;
        parentheses--;
      } else if (/\s/.test(character)) break;
    }
    if (cursor > first) return [first, cursor];
  }
  throw new StoreError("无法定位笔记图片的 Markdown 地址", 422);
}

function portableNote(
  note: Note,
  images: Map<string, NoteImage>,
  noteIds: Set<string>,
): { body: string; imageIds: Set<string> } {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .parse(note.body) as MarkdownNode;
  const definitions = new Map<string, MarkdownNode>();
  walk(tree, (node) => {
    if (node.type === "definition" && node.identifier && node.url) {
      const key = identifier(node.identifier);
      if (!definitions.has(key)) definitions.set(key, node);
    }
  });
  const usedNodes = new Set<MarkdownNode>();
  walk(tree, (node) => {
    if (node.type === "image") usedNodes.add(node);
    else if (node.type === "imageReference" && node.identifier) {
      const definition = definitions.get(identifier(node.identifier));
      if (definition) usedNodes.add(definition);
    }
  });
  const imageIds = new Set<string>();
  const replacements: Replacement[] = [];
  for (const node of usedNodes) {
    if (!node.url) continue;
    const id = localImageId(node.url);
    if (!id) continue;
    const image = images.get(id);
    if (!image || image.status !== "available")
      throw new StoreError("笔记引用的图片缺失，导出已中止", 409);
    // noteId records the upload's origin. Explicit links can reuse an image
    // anywhere inside this single-user library without exporting its owner note.
    if (!noteIds.has(image.noteId))
      throw new StoreError("笔记图片的原始所属笔记不存在，导出已中止", 409);
    if (
      !/^images\/[0-9a-f-]{36}\.(?:png|jpg|webp|gif)$/i.test(image.relativePath)
    )
      throw new StoreError("笔记图片存储路径无效，导出已中止", 409);
    const [start, end] = destinationRange(note.body, node);
    replacements.push({ start, end, value: `../${image.relativePath}` });
    imageIds.add(id);
  }
  let body = note.body;
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    body =
      body.slice(0, replacement.start) +
      replacement.value +
      body.slice(replacement.end);
  return { body, imageIds };
}

/** Standard USTAR, regular files only. Names come from stable IDs, never original filenames. */
function tarHeader(name: string, size: number): Buffer {
  if (
    !/^(?:README\.md|library\.json|(?:notes|ai|note-assists|note-revisions)\/[0-9a-f-]{36}\.md|images\/[0-9a-f-]{36}\.(?:png|jpg|webp|gif))$/i.test(
      name,
    )
  )
    throw new StoreError("导出文件路径无效", 409);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  const octal = (value: number, offset: number, length: number) => {
    const digits = value.toString(8);
    if (digits.length > length - 1) throw new StoreError("导出文件过大", 413);
    header.write(
      digits.padStart(length - 1, "0") + "\0",
      offset,
      length,
      "ascii",
    );
  };
  octal(0o600, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

/** Portable notes/images export; a separate full backup remains necessary for restoring the app. */
export function exportNoteBundle(
  store: KBStore,
  noteId?: string,
  options: { maxBytes?: number } = {},
): Buffer {
  const maximum = Math.min(
    options.maxBytes ?? NOTE_BUNDLE_LIMIT,
    NOTE_BUNDLE_LIMIT,
  );
  if (!Number.isSafeInteger(maximum) || maximum < 1024)
    throw new StoreError("导出容量设置无效", 400);
  const state = store.snapshot();
  const notes = noteId
    ? state.notes.filter((note) => note.id === noteId)
    : state.notes;
  if (noteId && !notes.length) throw new StoreError("笔记不存在", 404);
  const images = new Map(
    (state.noteImages ?? []).map((image) => [image.id.toLowerCase(), image]),
  );
  const noteIds = new Set(state.notes.map((note) => note.id));
  const usedImages = new Set<string>();
  const files: ArchiveFile[] = [];
  let total = 1024;
  const add = (name: string, content: string | Buffer) => {
    const size =
      typeof content === "string"
        ? Buffer.byteLength(content, "utf8")
        : content.length;
    const padded = Math.ceil(size / 512) * 512;
    if (total + 512 + padded > maximum)
      throw new StoreError(
        "Markdown 图片导出包超过 256 MiB 容量上限；请分笔记导出",
        413,
      );
    total += 512 + padded;
    files.push({
      name,
      bytes:
        typeof content === "string" ? Buffer.from(content, "utf8") : content,
    });
  };
  const portableNotes = notes.map((note) => {
    if (!uuidPattern.test(note.id)) throw new StoreError("笔记 ID 无效", 409);
    const portable = portableNote(note, images, noteIds);
    for (const id of portable.imageIds) usedImages.add(id);
    return { ...note, body: portable.body };
  });
  const portableState: KBState = { ...state, notes: portableNotes };
  add(
    "README.md",
    [
      "# 笔记与图片导出\n",
      "使用标准 Markdown 编辑器打开 notes/ 中的文件；本地图片位于 images/，以相对路径引用。",
      "此包保留笔记原文，只改写实际图片的本地地址；代码块中的示例保持原样。",
      "库内 kb:// 文献与批注链接需要原知识库；PDF 文件不包含在此包中。完整恢复请使用知识库备份。\n",
      ...portableNotes.map(
        (note) =>
          `- [${note.title.replace(/[\[\]\\\r\n]/g, " ")}](notes/${note.id}.md)`,
      ),
      "\n笔记 AI 建议独立保存在 note-assists/，历史原稿在 note-revisions/；不会混入个人当前笔记。",
      noteId
        ? ""
        : "\n论文 AI 结果独立保存在 ai/；文献元信息在 library.json，不混入个人笔记。",
    ].join("\n") + "\n",
  );
  for (const note of portableNotes)
    add(`notes/${note.id}.md`, exportMarkdown(portableState, note.id));
  if (!noteId) {
    for (const content of state.aiContents) {
      if (!uuidPattern.test(content.id))
        throw new StoreError("AI 结果 ID 无效", 409);
      add(`ai/${content.id}.md`, exportAIMarkdown(content, state));
    }
  }
  const selectedNoteIds = new Set(notes.map((note) => note.id));
  const addHistorical = (name: string, noteId: string, body: string) => {
    const owner = state.notes.find((note) => note.id === noteId);
    if (!owner) throw new StoreError("历史记录所属笔记不存在", 409);
    const portable = portableNote({ ...owner, body }, images, noteIds);
    for (const id of portable.imageIds) usedImages.add(id);
    add(name, portable.body);
  };
  for (const record of state.noteAssists ?? [])
    if (selectedNoteIds.has(record.noteId)) {
      if (!uuidPattern.test(record.id))
        throw new StoreError("AI 建议 ID 无效", 409);
      addHistorical(
        `note-assists/${record.id}.md`,
        record.noteId,
        exportNoteAssistanceMarkdown(record),
      );
    }
  for (const record of state.noteRevisions ?? [])
    if (selectedNoteIds.has(record.noteId)) {
      if (!uuidPattern.test(record.id))
        throw new StoreError("历史原稿 ID 无效", 409);
      addHistorical(
        `note-revisions/${record.id}.md`,
        record.noteId,
        exportNoteRevisionMarkdown(record),
      );
    }
  if (!noteId) {
    add(
      "library.json",
      JSON.stringify(
        {
          format: "personal-research-kb-markdown-bundle",
          version: 1,
          papers: state.papers,
          topics: state.topics,
          tags: state.tags,
          relations: state.relations,
          notes: notes.map(({ id, title, purpose, revision }) => ({
            id,
            title,
            purpose,
            revision,
          })),
          images: [...usedImages].map((id) => images.get(id)),
        },
        null,
        2,
      ) + "\n",
    );
  }
  for (const id of usedImages) {
    const expected = images.get(id)!;
    const { image, bytes } = readNoteImage(store, expected.id);
    if (
      image.noteId !== expected.noteId ||
      image.relativePath !== expected.relativePath ||
      image.sha256 !== expected.sha256 ||
      image.byteSize !== expected.byteSize
    )
      throw new StoreError("导出过程中图片发生变化，请重试", 409);
    add(image.relativePath, bytes);
  }
  const blocks: Buffer[] = [];
  for (const file of files) {
    blocks.push(tarHeader(file.name, file.bytes.length), file.bytes);
    const remainder = file.bytes.length % 512;
    if (remainder) blocks.push(Buffer.alloc(512 - remainder));
  }
  blocks.push(Buffer.alloc(1024));
  const result = gzipSync(Buffer.concat(blocks, total), { level: 6 });
  if (result.length > maximum)
    throw new StoreError("压缩后的 Markdown 图片导出包超过容量上限", 413);
  return result;
}
