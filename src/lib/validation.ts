import {
  noteAssistanceSchema,
  noteRevisionSchema,
  noteAssistApplySchema,
  noteRevisionRestoreSchema,
} from "./note-assist/schemas";
import { z } from "zod";
import { paperChatConversationSchema } from "./paper-chat/schemas";
import { ideaConversationSchema, ideaSummarySchema, ideaSummaryApplySchema } from "./idea-lab/schemas";
import { externalDiscussionSchema } from "./codex-import/schemas";
import { researchItemSchema } from "./research-items/schemas";
import {
  aggregateTextSegments,
  matchesSegmentSummary,
  MAX_ANNOTATION_RECTS,
  MAX_ANNOTATION_TEXT,
  MAX_TEXT_SEGMENTS,
} from "./annotation-segments";

export const uuid = z.string().uuid();
const title = z.string().trim().min(1).max(1000);
const text = z.string().max(2_000_000);
const revision = z.number().int().positive();
const url = z.union([
  z.literal(""),
  z
    .url()
    .max(4000)
    .refine((v) => {
      const parsed = new URL(v);
      return (
        ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password
      );
    }, "只允许不含凭据的 HTTP/HTTPS URL"),
]);
const aiEndpoint = url.refine(
  (v) => !v || (!new URL(v).search && !new URL(v).hash),
  "AI地址不得包含查询参数、片段或凭据；密钥仅通过后端环境配置",
);
const entityType = z.enum([
  "paper",
  "annotation",
  "note",
  "topic",
  "ai",
  "tag",
]);
const paperFields = {
  title,
  authors: z.array(z.string().max(500)).max(200),
  year: z.number().int().min(1000).max(2200).nullable(),
  abstract: text,
  sourceUrl: url,
  doi: z.string().max(500),
  arxivId: z.string().max(200),
  arxivVersion: z.number().int().positive().nullable(),
  readingStatus: z.enum(["unread", "reading", "read"]),
  inReadingList: z.boolean(),
  tags: z.array(z.string().trim().min(1).max(100)).max(100),
};
const rect = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine(
    (r) => r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001,
    "区域超出PDF页面",
  );
const textSegments = z
  .array(
    z
      .object({
        rects: z.array(rect).min(1).max(MAX_ANNOTATION_RECTS),
        selectedText: z
          .string()
          .max(MAX_ANNOTATION_TEXT)
          .refine((value) => value.trim().length > 0, "文字选段不可为空"),
      })
      .strict(),
  )
  .min(1)
  .max(MAX_TEXT_SEGMENTS)
  .superRefine((segments, ctx) => {
    const summary = aggregateTextSegments(segments);
    if (summary.rects.length > MAX_ANNOTATION_RECTS)
      ctx.addIssue({ code: "custom", message: "批注选段总区域数不能超过 500" });
    if (summary.selectedText.length > MAX_ANNOTATION_TEXT)
      ctx.addIssue({
        code: "custom",
        message: "批注选段总文字不能超过 100000 字符",
      });
  });
const validateSegmentKind = (
  value: { kind?: string; textSegments?: unknown },
  ctx: z.RefinementCtx,
) => {
  if (value.textSegments && value.kind === "region")
    ctx.addIssue({
      code: "custom",
      message: "只有文字高亮可以包含多个文字选段",
    });
};
const annotationFields = {
  kind: z.enum(["highlight", "region"]),
  pageIndex: z.number().int().min(0).max(100000),
  pageLabel: z.string().max(100),
  rects: z.array(rect).min(1).max(500),
  selectedText: z.string().max(100000),
  textSegments: textSegments.nullable().optional(),
  comment: z.string().max(100000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
};
const noteFields = { title, body: text };
const link = z
  .object({
    fromType: entityType,
    fromId: uuid,
    toType: entityType,
    toId: uuid,
    purpose: z.enum(["manual", "tag"]).default("manual"),
  })
  .strict();

export const actionSchemas = {
  "paper.create": z.object(paperFields).partial().extend({ title }).strict(),
  "paper.update": z
    .object(paperFields)
    .partial()
    .extend({ id: uuid, revision })
    .strict(),
  "paper.trash": z.object({ id: uuid, revision }).strict(),
  "paper.restore": z.object({ id: uuid, revision }).strict(),
  "paper.reading-list": z
    .object({
      papers: z
        .array(z.object({ id: uuid, revision }).strict())
        .min(1)
        .max(500),
      operation: z.enum(["add", "remove", "read", "reading", "unread"]),
    })
    .strict()
    .refine(
      (input) =>
        new Set(input.papers.map((paper) => paper.id)).size ===
        input.papers.length,
      "批量操作不可包含重复文献",
    ),
  "annotation.create": z
    .object(annotationFields)
    .partial()
    .extend({
      paperId: uuid,
      attachmentId: uuid,
      kind: annotationFields.kind,
      pageIndex: annotationFields.pageIndex,
      rects: annotationFields.rects,
    })
    .strict()
    .superRefine(validateSegmentKind),
  "annotation.update": z
    .object(annotationFields)
    .partial()
    .extend({ id: uuid, revision })
    .strict()
    .superRefine(validateSegmentKind),
  "annotation.delete": z.object({ id: uuid }).strict(),
  "note.create": z
    .object({
      ...noteFields,
      body: text.default(""),
      purpose: z.enum(["paper", "topic", "idea"]),
      paperIds: z.array(uuid).max(100).optional(),
      topicIds: z.array(uuid).max(100).optional(),
    })
    .strict(),
  "note.update": z
    .object(noteFields)
    .partial()
    .extend({ id: uuid, revision })
    .strict(),
  "note.assist.apply": noteAssistApplySchema,
  "idea.summary.apply": ideaSummaryApplySchema,
  "note.revision.restore": noteRevisionRestoreSchema,
  "topic.create": z.object({ title, description: text.default("") }).strict(),
  "topic.update": z
    .object({
      id: uuid,
      revision,
      title: title.optional(),
      description: text.optional(),
    })
    .strict(),
  "topic.delete": z.object({ id: uuid }).strict(),
  "link.set": link,
  "link.unset": link,
  "settings.update": z
    .object({
      aiProvider: z.enum(["none", "ollama", "codex", "openai-compatible"]),
      codexModel: z.string().trim().max(300),
      ollamaUrl: aiEndpoint,
      ollamaModel: z.string().max(300),
      openaiUrl: aiEndpoint,
      openaiModel: z.string().max(300),
      appearance: z.enum(["light", "system"]),
      splitRatio: z.number().min(0.3).max(0.8),
    })
    .partial()
    .strict(),
  "reading.set": z
    .object({
      paperId: uuid,
      attachmentId: uuid,
      pageIndex: z.number().int().nonnegative().max(100000),
      scale: z.union([z.literal("page-width"), z.number().min(0.1).max(10)]),
      rotation: z
        .number()
        .int()
        .refine((n) => n % 90 === 0)
        .default(0),
    })
    .strict(),
} as const;
export type Action = keyof typeof actionSchemas;
export const requestSchema = z
  .object({
    action: z.enum(Object.keys(actionSchemas) as [Action, ...Action[]]),
    payload: z.unknown(),
  })
  .strict();
const guideId = z.string().min(1).max(200);
const pageIndex = z.number().int().nonnegative().max(100000);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const guideDataSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["guide", "comparison"]),
    overview: text,
    sections: z
      .array(
        z
          .object({
            key: guideId,
            title: z.string().min(1).max(1000),
            body: text,
            basis: z.enum(["author", "analysis", "question", "not-stated"]),
            evidenceIds: z.array(guideId).max(1000),
          })
          .strict(),
      )
      .max(100),
    evidence: z
      .array(
        z
          .object({
            id: guideId,
            paperId: uuid,
            attachmentId: uuid,
            attachmentSha256: sha256,
            pageIndex,
            pageLabel: z.string().max(100),
            blockId: guideId,
            quote: z.string().min(1).max(100000),
            category: z.enum([
              "problem",
              "method",
              "assumption",
              "theorem",
              "proof",
              "experiment",
              "limitation",
            ]),
            title: z.string().min(1).max(1000),
            explanation: text,
            matched: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(2000),
    readingOrder: z.array(guideId).max(2000),
    questions: z.array(z.string().max(20000)).max(100),
    sources: z
      .array(
        z
          .object({
            paperId: uuid,
            paperTitle: z.string().min(1).max(1000),
            attachmentId: uuid,
            attachmentSha256: sha256,
            filename: z.string().min(1).max(255),
            pageCount: z.number().int().positive().max(100001),
            parsedPages: z.array(pageIndex).max(100001),
            emptyPages: z.array(pageIndex).max(100001),
            characterCount: z.number().int().nonnegative().max(100_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    warnings: z.array(z.string().max(20000)).max(1000),
    paperIds: z.array(uuid).min(1).max(3),
  })
  .strict()
  .superRefine((guide, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    const paperIds = new Set(guide.paperIds);
    if (
      paperIds.size !== guide.paperIds.length ||
      (guide.mode === "guide" ? paperIds.size !== 1 : paperIds.size < 2)
    )
      issue("导读或比较的文献列表无效");
    const sources = new Map(
      guide.sources.map((source) => [source.attachmentId, source]),
    );
    if (sources.size !== guide.sources.length) issue("导读包含重复附件来源");
    for (const source of guide.sources) {
      if (!paperIds.has(source.paperId)) issue("导读来源不在所选文献中");
      const parsed = new Set(source.parsedPages);
      const empty = new Set(source.emptyPages);
      if (
        parsed.size !== source.parsedPages.length ||
        empty.size !== source.emptyPages.length ||
        [...parsed, ...empty].some((page) => page >= source.pageCount) ||
        [...empty].some((page) => parsed.has(page))
      )
        issue("导读来源的已解析页或空白页记录无效");
    }
    if (
      [...paperIds].some(
        (id) => !guide.sources.some((source) => source.paperId === id),
      )
    )
      issue("导读缺少所选文献来源");
    const evidenceIds = new Set(guide.evidence.map((evidence) => evidence.id));
    if (evidenceIds.size !== guide.evidence.length) issue("导读包含重复证据ID");
    const sectionKeys = new Set(guide.sections.map((section) => section.key));
    if (sectionKeys.size !== guide.sections.length)
      issue("导读包含重复章节标识");
    for (const evidence of guide.evidence) {
      const source = sources.get(evidence.attachmentId);
      if (
        !source ||
        source.paperId !== evidence.paperId ||
        source.attachmentSha256 !== evidence.attachmentSha256 ||
        !source.parsedPages.includes(evidence.pageIndex)
      )
        issue("导读证据与附件来源或已解析页不一致");
    }
    if (
      [...paperIds].some(
        (id) => !guide.evidence.some((evidence) => evidence.paperId === id),
      )
    )
      issue("导读缺少参与文献的最终原文证据");
    for (const section of guide.sections) {
      if (section.basis === "author" && !section.evidenceIds.length)
        issue("原文陈述必须保留证据引用");
      if (
        guide.mode === "comparison" &&
        (section.basis === "author" || section.basis === "analysis") &&
        new Set(
          section.evidenceIds.flatMap(
            (id) =>
              guide.evidence.find((evidence) => evidence.id === id)?.paperId ??
              [],
          ),
        ).size < 2
      )
        issue("关联分析的原文陈述与分析判断必须保留双方证据");
    }
    for (const id of [
      ...guide.readingOrder,
      ...guide.sections.flatMap((section) => section.evidenceIds),
    ])
      if (!evidenceIds.has(id)) issue("导读引用了不存在的证据ID");
    if (new Set(guide.readingOrder).size !== guide.readingOrder.length)
      issue("导读阅读路线包含重复证据");
  });

export const aiSchema = z
  .object({
    paperId: uuid,
    kind: z.enum(["summary", "translation", "explanation", "markdown", "guide", "comparison"]),
    body: text.min(1),
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(500),
    sourceScope: z.enum(["abstract", "full_text", "partial_text", "selection", "selection_context", "page_image", "selection_image"]),
    sourceAttachmentId: uuid.nullable(),
    sourcePageIndices: z.array(z.number().int().nonnegative()).max(100000),
    sourceText: text,
    guideData: guideDataSchema.nullable().default(null),
    status: z.literal("completed"),
  })
  .strict()
  .superRefine((content, ctx) => {
    const guided = content.kind === "guide" || content.kind === "comparison";
    if (
      guided
        ? content.guideData?.mode !== content.kind
        : content.guideData !== null
    )
      ctx.addIssue({ code: "custom", message: "AI内容类型与导读数据不一致" });
    if (
      content.guideData &&
      !content.guideData.paperIds.includes(content.paperId)
    )
      ctx.addIssue({ code: "custom", message: "AI内容不属于导读文献" });
    if (
      content.guideData &&
      content.sourceAttachmentId &&
      !content.guideData.sources.some(
        (source) =>
          source.paperId === content.paperId &&
          source.attachmentId === content.sourceAttachmentId &&
          content.sourcePageIndices.every((page) =>
            source.parsedPages.includes(page),
          ),
      )
    )
      ctx.addIssue({ code: "custom", message: "AI来源页与导读来源不一致" });
  });

const stamp = z.iso.datetime();
const identity = { id: uuid, createdAt: stamp };
const versioned = { ...identity, revision, updatedAt: stamp };
export const noteImageSchema = z
  .object({
    ...identity,
    noteId: uuid,
    relativePath: z
      .string()
      .regex(/^images\/[0-9a-f-]{36}\.(png|jpg|webp|gif)$/),
    filename: z.string().min(1).max(255),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    sha256,
    byteSize: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
    status: z.enum(["available", "missing"]),
  })
  .strict()
  .refine(
    (image) => image.width * image.height <= 40_000_000,
    "图片像素总量超过 4000 万",
  );
export const snapshotSchema = z
  .object({
    papers: z.array(
      z
        .object(paperFields)
        .omit({ tags: true })
        .extend({
          ...versioned,
          deletedAt: stamp.nullable().default(null),
          inReadingList: z.boolean().optional(),
        })
        .strict()
        .transform((paper) => ({
          ...paper,
          inReadingList:
            paper.inReadingList ?? paper.readingStatus === "unread",
        })),
    ),
    attachments: z.array(
      z
        .object({
          ...identity,
          paperId: uuid,
          relativePath: z.string().regex(/^attachments\/[0-9a-f-]{36}\.pdf$/),
          filename: z.string().min(1).max(255),
          mimeType: z.literal("application/pdf"),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          status: z.enum(["available", "missing"]),
        })
        .strict(),
    ),
    annotations: z.array(
      z
        .object({
          ...annotationFields,
          ...versioned,
          paperId: uuid,
          attachmentId: uuid,
        })
        .strict()
        .superRefine((annotation, ctx) => {
          validateSegmentKind(annotation, ctx);
          if (!matchesSegmentSummary(annotation))
            ctx.addIssue({
              code: "custom",
              message: "文字选段与批注汇总不一致",
            });
        }),
    ),
    notes: z.array(
      z
        .object({
          ...noteFields,
          ...versioned,
          purpose: z.enum(["paper", "topic", "idea"]),
        })
        .strict(),
    ),
    noteImages: z.array(noteImageSchema).max(10000).default([]),
    noteAssists: z.array(noteAssistanceSchema).max(100000).default([]),
    noteRevisions: z.array(noteRevisionSchema).max(100000).default([]),
    chatConversations: z.array(paperChatConversationSchema).max(10000).default([]),
    ideaConversations: z.array(ideaConversationSchema).max(10000).default([]),
    ideaSummaries: z.array(ideaSummarySchema).max(10000).default([]),
    externalDiscussions: z.array(externalDiscussionSchema).max(10000).default([]),
    researchItems: z.array(researchItemSchema).max(100000).default([]),
    topics: z.array(
      z
        .object({ ...versioned, title, description: text, noteId: uuid })
        .strict(),
    ),
    aiContents: z.array(aiSchema.safeExtend(identity)),
    tags: z.array(
      z.object({ id: uuid, name: z.string().min(1).max(100) }).strict(),
    ),
    relations: z.array(
      z
        .object({
          ...identity,
          fromType: entityType,
          fromId: uuid,
          toType: entityType,
          toId: uuid,
          purpose: z.enum(["manual", "reference", "tag"]),
        })
        .strict(),
    ),
    readingPositions: z.array(
      actionSchemas["reading.set"].extend({ updatedAt: stamp }),
    ),
    settings: actionSchemas["settings.update"]
      .required()
      .extend({ codexModel: z.string().trim().max(300).default("") }),
  })
  .strict();
