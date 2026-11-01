import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import { KBStore, StoreError } from "./db";
import { snapshotSchema } from "./validation";
import { exportIdeaLabMarkdown } from "./idea-lab/export";
import { exportResearchMarkdown } from "./research-export";
import type { AIContent, KBState, Note } from "./types";
import type { NoteAssistance, NoteRevision } from "./note-assist/types";
import { exportChatContextsMarkdown } from "./paper-chat/context-export";
import {
  inspectNoteImage,
  readNoteImage,
  validateNoteImageRecord,
} from "./note-images";

const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_EXPANDED = 512 * 1024 * 1024;
const hash = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const envelopeSchema = z
  .object({
    format: z.literal("personal-research-kb"),
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
    snapshot: z.unknown(),
    files: z
      .array(
        z
          .object({
            path: z
              .string()
              .regex(
                /^(attachments\/[0-9a-f-]{36}\.pdf|images\/[0-9a-f-]{36}\.(png|jpg|webp|gif))$/,
              ),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            data: z.string().max(MAX_TOTAL * 1.4),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
const schema = envelopeSchema.extend({ snapshot: snapshotSchema });

export function createBackup(store: KBStore): Buffer {
  let snapshot: KBState;
  store.db.exec("BEGIN");
  try {
    snapshot = store.snapshot();
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  let total = 0;
  const files = snapshot.attachments.flatMap((attachment) => {
    const filename = path.join(store.dataDir, attachment.relativePath);
    if (!fs.existsSync(filename)) {
      if (attachment.status === "available")
        throw new StoreError("备份中止：可用附件在快照后缺失，请重试", 409);
      return [];
    }
    const bytes = fs.readFileSync(store.attachmentPath(attachment.id));
    total += bytes.length;
    if (total > MAX_TOTAL)
      throw new StoreError(
        "首版单个备份附件总量上限为 256 MiB；请保留数据目录副本",
        413,
      );
    if (hash(bytes) !== attachment.sha256)
      throw new StoreError("附件内容指纹不匹配，备份已中止以保护原引用", 409);
    return [
      {
        path: attachment.relativePath,
        sha256: attachment.sha256,
        data: bytes.toString("base64"),
      },
    ];
  });
  for (const image of snapshot.noteImages ?? []) {
    let present = false;
    try {
      fs.lstatSync(path.join(store.dataDir, image.relativePath));
      present = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!present) {
      if (image.status === "available")
        throw new StoreError("备份中止：可用笔记图片在快照后缺失，请重试", 409);
      continue;
    }
    const { bytes } = readNoteImage(store, image.id);
    total += bytes.length;
    if (total > MAX_TOTAL)
      throw new StoreError(
        "首版单个备份文件总量上限为 256 MiB；请保留数据目录副本",
        413,
      );
    files.push({
      path: image.relativePath,
      sha256: image.sha256,
      data: bytes.toString("base64"),
    });
  }
  if (files.length > 10000)
    throw new StoreError("首版单个备份最多包含 10000 个文件", 413);
  const archive = {
    format: "personal-research-kb",
    version: 1,
    createdAt: new Date().toISOString(),
    snapshotSha256: hash(canonical(snapshot)),
    snapshot,
    files,
  };
  schema.parse(archive);
  const serialized = JSON.stringify(archive);
  if (Buffer.byteLength(serialized, "utf8") > MAX_EXPANDED)
    throw new StoreError(
      "完整快照超过首版 512 MiB 解压容量，备份已中止；请停止服务后复制整个数据目录",
      413,
    );
  const compressed = gzipSync(serialized, { level: 6 });
  if (compressed.length > MAX_TOTAL)
    throw new StoreError(
      "压缩归档超过首版 256 MiB 恢复容量，备份已中止；请停止服务后复制整个数据目录",
      413,
    );
  return compressed;
}

export function restoreBackup(bytes: Buffer, parent: string) {
  if (bytes.length > MAX_TOTAL) throw new StoreError("备份文件过大", 413);
  let value: unknown;
  try {
    value = JSON.parse(
      gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED }).toString("utf8"),
    );
  } catch {
    throw new StoreError("无效、损坏或过大的 .kb.json.gz 备份", 400);
  }
  const envelope = envelopeSchema.parse(value);
  // Verify bytes represented by the original JSON before additive schema defaults.
  // Legacy archives legitimately lack fields introduced after their creation.
  if (hash(canonical(envelope.snapshot)) !== envelope.snapshotSha256)
    throw new StoreError("数据快照校验失败", 400);
  const parsed = {
    ...envelope,
    snapshot: snapshotSchema.parse(envelope.snapshot),
  };
  const names = new Set<string>();
  let size = 0;
  const files = parsed.files.map((file) => {
    if (names.has(file.path)) throw new StoreError("备份含重复文件路径", 400);
    names.add(file.path);
    const attachment = parsed.snapshot.attachments.find(
      (a) => a.relativePath === file.path,
    );
    const image = parsed.snapshot.noteImages.find(
      (a) => a.relativePath === file.path,
    );
    const record = attachment ?? image;
    if (!record || record.sha256 !== file.sha256)
      throw new StoreError("附件或图片清单与数据快照不一致", 400);
    const content = Buffer.from(file.data, "base64");
    size += content.length;
    if (size > MAX_TOTAL || hash(content) !== file.sha256)
      throw new StoreError(
        attachment ? "附件校验失败或超出容量" : "图片校验失败或超出容量",
        400,
      );
    if (attachment && content.subarray(0, 5).toString() !== "%PDF-")
      throw new StoreError("附件校验失败", 400);
    if (image) {
      validateNoteImageRecord(image);
      if (!parsed.snapshot.notes.some((note) => note.id === image.noteId))
        throw new StoreError("备份图片不属于有效笔记", 400);
      const info = inspectNoteImage(content);
      if (
        content.length !== image.byteSize ||
        info.mimeType !== image.mimeType ||
        info.width !== image.width ||
        info.height !== image.height
      )
        throw new StoreError("笔记图片格式或容量校验失败", 400);
    }
    return { name: file.path, content };
  });
  for (const attachment of parsed.snapshot.attachments)
    if (
      attachment.status === "available" &&
      !names.has(attachment.relativePath)
    )
      throw new StoreError("备份缺少必要附件", 400);
  for (const image of parsed.snapshot.noteImages)
    if (image.status === "available" && !names.has(image.relativePath))
      throw new StoreError("备份缺少必要笔记图片", 400);
  const target = path.join(
    path.resolve(parent),
    `restored-${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  fs.mkdirSync(target, { recursive: false, mode: 0o700 });
  let restored: KBStore | undefined;
  try {
    fs.mkdirSync(path.join(target, "attachments"), { mode: 0o700 });
    fs.mkdirSync(path.join(target, "images"), { mode: 0o700 });
    for (const file of files)
      fs.writeFileSync(path.join(target, file.name), file.content, {
        flag: "wx",
        mode: 0o600,
      });
    restored = new KBStore(target);
    restored.importSnapshot(parsed.snapshot);
    const state = restored.snapshot();
    const counts = {
      papers: state.papers.length,
      attachments: state.attachments.length,
      annotations: state.annotations.length,
      notes: state.notes.length,
      noteImages: state.noteImages?.length ?? 0,
      noteAssists: state.noteAssists?.length ?? 0,
      noteRevisions: state.noteRevisions?.length ?? 0,
      chatConversations: state.chatConversations?.length ?? 0,
      ideaConversations: state.ideaConversations?.length ?? 0,
      ideaSummaries: state.ideaSummaries?.length ?? 0,
      externalDiscussions: state.externalDiscussions?.length ?? 0,
      researchItems: state.researchItems?.length ?? 0,
      topics: state.topics.length,
      aiContents: state.aiContents.length,
      relations: state.relations.length,
    };
    restored.close();
    restored = undefined;
    return {
      restoredDirectory: target,
      restartCommand: `KB_DATA_DIR='${target.replaceAll("'", "'\\''")}' npm start`,
      counts,
      warnings: [
        ...state.attachments
          .filter((a) => a.status === "missing")
          .map(
            (a) =>
              `源库已缺失附件：${a.filename}（${a.id}），保留原ID与引用，待相同文件重联。`,
          ),
        ...(state.noteImages ?? [])
          .filter((a) => a.status === "missing")
          .map(
            (a) =>
              `源库已缺失笔记图片：${a.filename}（${a.id}），保留原ID与引用。`,
          ),
      ],
      message:
        "已恢复到新的空目录；当前知识库未改变。完成或导出未保存草稿后，停止服务，并使用新目录重新启动。",
    };
  } catch (error) {
    restored?.close();
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function sourceAppendix(note: Note, state: KBState) {
  const refs = state.relations.filter(
    (r) =>
      r.fromType === "note" &&
      r.fromId === note.id &&
      r.purpose === "reference",
  );
  return refs
    .map((ref) => {
      if (ref.toType === "annotation") {
        const a = state.annotations.find((a) => a.id === ref.toId);
        if (!a) return "";
        const paper = state.papers.find((p) => p.id === a.paperId);
        return `- 批注 ${a.id}：${paper?.title ?? "文献"}；物理页 ${a.pageIndex + 1}；显示页码 ${a.pageLabel}；附件 ${a.attachmentId}。\n  原文快照：${a.selectedText || "页内区域（无识别文字）"}\n  来源：${paper?.sourceUrl || "本地 PDF"}\n  区域坐标（未旋转页归一化，y 向上）：${JSON.stringify(a.rects)}`;
      }
      if (ref.toType === "paper") {
        const p = state.papers.find((p) => p.id === ref.toId);
        return p
          ? `- 文献 ${p.id}：${p.title}；${p.authors.join(", ")}；${p.year ?? "年份待补"}；${p.sourceUrl || "本地文献"}`
          : "";
      }
      if (ref.toType === "ai") {
        const a = state.aiContents.find((a) => a.id === ref.toId);
        return a
          ? `- AI 来源 ${a.id}：${a.provider} / ${a.model}；${a.createdAt}；范围 ${a.sourceScope}。`
          : "";
      }
      return `- ${ref.toType}：${ref.toId}`;
    })
    .filter(Boolean)
    .join("\n");
}
export function exportMarkdown(state: KBState, noteId?: string) {
  const notes = noteId
    ? state.notes.filter((n) => n.id === noteId)
    : state.notes;
  if (noteId && !notes.length) throw new StoreError("笔记不存在", 404);
  const noteDocuments = notes
    .map((note) => {
      const papers = state.relations
        .filter(
          (r) =>
            r.fromType === "note" &&
            r.fromId === note.id &&
            r.toType === "paper",
        )
        .map((r) => state.papers.find((p) => p.id === r.toId))
        .filter((p) => p !== undefined);
      return `# ${note.title}\n\n<!-- stable-note-id: ${note.id}; revision: ${note.revision} -->\n\n${papers.map((p) => `文献：${p.title}；${p.authors.join(", ")}；${p.year ?? ""}；${p.sourceUrl || "本地文献"}`).join("\n\n")}\n\n${note.body}\n\n## 来源说明\n\n${sourceAppendix(note, state) || "没有显式来源引用。"}\n`;
    })
    .join("\n\n---\n\n");
  if (noteId) return noteDocuments;
  const aiDocuments = state.aiContents
    .map((content) => exportAIMarkdown(content, state))
    .join("\n\n---\n\n");
  const assists = (state.noteAssists ?? [])
    .map(exportNoteAssistanceMarkdown)
    .join("\n\n---\n\n");
  const revisions = (state.noteRevisions ?? [])
    .map(exportNoteRevisionMarkdown)
    .join("\n\n---\n\n");
  const chats = (state.chatConversations ?? []).map((conversation) =>
    `# 论文对话：${conversation.title}\n\n文献 ${conversation.paperId}；附件 ${conversation.attachmentId}；SHA-256 ${conversation.attachmentSha256}。\n\n${conversation.messages.map((message) =>
      `## ${message.role === "user" ? "提问" : "AI 回复"} · ${message.status}\n\n${message.body}\n\n${exportChatContextsMarkdown(message.contexts)}${message.error ? `状态说明：${message.error}\n\n` : ""}${message.scope ? `阅读范围：物理页 ${message.scope.pageIndices.map((page) => page + 1).join("、")} / 共 ${message.scope.totalPages} 页；${message.scope.characterCount} 字符；截断：${message.scope.truncated}。\n` : ""}`
    ).join("\n\n")}`).join("\n\n---\n\n");
  const ideas = exportIdeaLabMarkdown(state.ideaConversations ?? [], state.ideaSummaries ?? []);
  return [noteDocuments, aiDocuments, assists, revisions, chats, ideas, exportResearchMarkdown(state)]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

/** Separate generated suggestions and immutable original drafts from the personal current document. */
export function exportNoteAssistanceMarkdown(record: NoteAssistance): string {
  const modes = {
    polish: "轻度润色",
    structure: "梳理问题",
    advise: "研究建议",
  };
  const basis = {
    note: "笔记判断",
    literature: "文献依据",
    hypothesis: "待验证设想",
  };
  return `# AI 辅助 · ${modes[record.mode]}：${record.baseTitle}\n\n<!-- stable-note-assist-id: ${record.id}; note-id: ${record.noteId}; base-revision: ${record.baseRevision} -->\n\n生成：${record.createdAt}；${record.provider} / ${record.model}。已采纳修改：${record.appliedEdits.map((i) => i + 1).join("、") || "无"}。\n\n## 总览\n\n${record.result.overview}\n\n## 修改建议\n\n${record.result.edits.map((edit, i) => `### ${i + 1} · ${record.appliedEdits.includes(i) ? "已采纳" : "未采纳"}\n\n理由：${edit.reason}\n\n原文：\n\n${edit.before}\n\n建议稿：\n\n${edit.after}`).join("\n\n") || "无正文修改。"}\n\n## 研究建议\n\n${record.result.suggestions.map((s) => `### ${s.title}\n\n依据：${basis[s.basis]}；来源：${s.evidenceIds.join("、") || "无直接来源"}。\n\n${s.body}`).join("\n\n") || "无额外建议。"}\n\n## 输入原稿快照（不会自动覆盖当前正文）\n\n${record.baseBody}\n\n## 读取范围\n\n${record.selection ? `原稿字符区间 [${record.selection.from}, ${record.selection.to})：\n\n${record.selection.text}` : "整篇笔记正文。"}\n\n## 输入资料快照\n\n${record.sources.map((s) => `### ${s.id} · ${s.title}\n\n类型：${s.kind}；文献 ${s.paperId || "无"}；笔记 ${s.noteId || "无"}；附件 ${s.attachmentId || "无"}；物理页 ${s.pageIndex === undefined ? "无" : s.pageIndex + 1}；显示页码 ${s.pageLabel || "无"}；SHA-256 ${s.attachmentSha256 || "无"}。\n\n${s.text}`).join("\n\n")}\n`;
}
export function exportNoteRevisionMarkdown(record: NoteRevision): string {
  return `# 历史原稿：${record.title}\n\n<!-- stable-note-revision-id: ${record.id}; note-id: ${record.noteId}; revision: ${record.noteRevision} -->\n\n保存时间：${record.createdAt}；保存原因：${record.reason}。\n\n${record.body}\n`;
}

/** Export AI records independently; never merge generated text into personal note bodies. */
export function exportAIMarkdown(content: AIContent, state: KBState) {
  const paper = state.papers.find((p) => p.id === content.paperId);
  const kind = {
    summary: "AI 摘要",
    translation: "AI 选段翻译",
    explanation: "AI 选段解释",
    markdown: "PDF Markdown 与 LaTeX 识别",
    guide: "AI 导读",
    comparison: "AI 关联分析",
  }[content.kind];
  const header = `# ${kind}：${paper?.title ?? content.paperId}\n\n<!-- stable-ai-id: ${content.id}; kind: ${content.kind} -->\n\n生成：${content.createdAt}；${content.provider} / ${content.model}；输入范围：${content.sourceScope}。\n\n`;
  const guide = content.guideData;
  if (!guide)
    return `${header}${content.body}\n\n## 输入来源\n\n附件：${content.sourceAttachmentId ?? "无（摘要文本）"}；物理页：${content.sourcePageIndices.map((page) => page + 1).join("、") || "无"}。\n\n### 输入原文快照\n\n${content.sourceText}\n`;
  const sources = guide.sources
    .map((source) => {
      const currentPaper = state.papers.find((p) => p.id === source.paperId);
      const currentAttachment = state.attachments.find(
        (a) => a.id === source.attachmentId,
      );
      return `- ${currentPaper?.title ?? source.paperTitle}；${currentAttachment?.filename ?? source.filename}；文献 ${source.paperId}；附件 ${source.attachmentId}；SHA-256 ${source.attachmentSha256}；共 ${source.pageCount} 页；已读取物理页 ${source.parsedPages.map((page) => page + 1).join("、") || "无"}；无可解析文字页 ${source.emptyPages.map((page) => page + 1).join("、") || "无"}；${source.characterCount} 字符。`;
    })
    .join("\n");
  const basis = {
    author: "作者明确说明",
    analysis: "AI 分析判断",
    question: "待探索问题",
    "not-stated": "原文未说明",
  };
  const sections = guide.sections
    .map(
      (section) =>
        `## ${section.title}\n\n依据类型：${basis[section.basis]}。\n\n${section.body}\n\n证据：${section.evidenceIds.join("、") || "无直接证据引用"}。`,
    )
    .join("\n\n");
  const evidence = guide.evidence
    .map((item) => {
      const source = guide.sources.find(
        (source) => source.attachmentId === item.attachmentId,
      );
      return `### ${item.id} · ${item.title}\n\n文献：${state.papers.find((p) => p.id === item.paperId)?.title ?? source?.paperTitle ?? item.paperId}；附件 ${item.attachmentId}；物理页 ${item.pageIndex + 1}；显示页码 ${item.pageLabel}；块 ${item.blockId}；定位状态：${item.matched ? "原句已匹配" : "定位待确认"}；类别 ${item.category}。\n\n${item.quote
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n${item.explanation}`;
    })
    .join("\n\n");
  return `${header}## 总览\n\n${guide.overview}\n\n${sections}\n\n## 阅读路线\n\n${guide.readingOrder.join(" → ") || "未指定"}\n\n## 后续问题\n\n${guide.questions.map((question) => `- ${question}`).join("\n") || "无"}\n\n## 原文证据\n\n${evidence || "无可定位证据"}\n\n## 来源与阅读范围\n\n${sources}\n\n## 阅读限制\n\n${guide.warnings.map((warning) => `- ${warning}`).join("\n") || "无额外警告"}\n\n## 原始生成报告\n\n${content.body}\n`;
}
