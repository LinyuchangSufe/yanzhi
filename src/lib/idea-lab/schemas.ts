import { z } from "zod";
import { chatProgressSchema } from "../ai/chat-progress";

const uuid = z.string().uuid();
const positive = z.number().int().positive();
const timestamp = z.string().datetime();
const sourceType = z.enum(["paper", "note", "topic", "annotation", "guideEvidence", "externalDiscussion"]);
const sourceField = z.enum(["abstract", "body", "description", "quote", "comment"]);
const validField = (type: string, field: string) => type === "paper" ? field === "abstract" :
  ["note", "externalDiscussion"].includes(type) ? field === "body" : type === "topic" ? ["body", "description"].includes(field) :
  type === "guideEvidence" ? field === "quote" : ["quote", "comment"].includes(field);
const evidenceId = z.string().min(1).max(250);
const sourceShape = { type: sourceType, revision: positive, field: sourceField };
export const ideaSourceInputSchema = z.object({
  ...sourceShape, id: uuid,
  start: z.number().int().nonnegative().optional(), end: positive.optional(),
  evidenceId: evidenceId.optional(),
}).strict().superRefine((value, ctx) => {
  if (!validField(value.type, value.field)) ctx.addIssue({ code: "custom", message: "资料类型与内容范围不一致" });
  if ((value.type === "guideEvidence") !== Boolean(value.evidenceId) || (value.type === "guideEvidence" && value.revision !== 1))
    ctx.addIssue({ code: "custom", message: "导读资料须指明原句证据和固定版本" });
  if ((value.start === undefined) !== (value.end === undefined) ||
      (value.start !== undefined && value.end !== undefined && value.end <= value.start))
    ctx.addIssue({ code: "custom", message: "资料选段范围无效" });
});
export const ideaSourceSnapshotSchema = z.object({
  ...sourceShape, id: z.string().min(1).max(400), entityId: uuid,
  title: z.string().max(1000), text: z.string().min(1).max(24000), sourceHref: z.string().max(200),
  start: z.number().int().nonnegative(), end: positive,
  paperId: uuid.optional(), attachmentId: uuid.optional(),
  attachmentSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  pageIndex: z.number().int().nonnegative().optional(), pageLabel: z.string().max(500).optional(),
  guideId: uuid.optional(), evidenceId: evidenceId.optional(),
  sourceThreadId: z.string().min(1).max(300).optional(), externalSourceHref: z.string().max(1000).optional(),
  externalContentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  externalTurnStatuses: z.record(z.string().min(1).max(300), z.string().max(100)).refine((value) => Object.keys(value).length <= 2000, "外部讨论轮次数量过多").optional(),
  externalSourceId: z.string().min(1).max(200).optional(),
}).strict().superRefine((value, ctx) => {
  const expected = `kb://${value.type === "paper" ? "paper" : value.type === "topic" ? "topic" : value.type === "annotation" ? "annotation" : value.type === "guideEvidence" ? "ai" : value.type === "externalDiscussion" ? "discussion" : "note"}/${value.entityId}`;
  if (!validField(value.type, value.field) || value.sourceHref !== expected || value.end - value.start !== value.text.length || !value.text.trim())
    ctx.addIssue({ code: "custom", message: "资料快照的类型、原文范围或来源链接不一致" });
  if (value.type === "annotation" && (!value.paperId || !value.attachmentId || !value.attachmentSha256 || value.pageIndex === undefined))
    ctx.addIssue({ code: "custom", message: "批注资料缺少原附件来源" });
  if (value.type === "guideEvidence" && (!value.evidenceId || value.guideId !== value.entityId || value.revision !== 1 ||
      !value.paperId || !value.attachmentId || !value.attachmentSha256 || value.pageIndex === undefined))
    ctx.addIssue({ code: "custom", message: "导读原句资料缺少导读、证据或附件来源" });
  if (value.type !== "guideEvidence" && (value.guideId || value.evidenceId))
    ctx.addIssue({ code: "custom", message: "非导读资料不能声明原句证据" });
  if (value.type === "externalDiscussion" && (!value.sourceThreadId || !value.externalSourceId || !value.externalContentHash || !value.externalTurnStatuses ||
      value.externalSourceHref !== `codex://threads/${encodeURIComponent(value.sourceThreadId)}`))
    ctx.addIssue({ code: "custom", message: "外部讨论快照缺少真实线程来源或内容校验值" });
  if (value.type !== "externalDiscussion" && (value.sourceThreadId || value.externalSourceHref || value.externalContentHash || value.externalTurnStatuses || value.externalSourceId))
    ctx.addIssue({ code: "custom", message: "非外部讨论资料不能声明外部线程来源" });
  if (value.type === "externalDiscussion" && (value.paperId || value.attachmentId || value.attachmentSha256 || value.pageIndex !== undefined))
    ctx.addIssue({ code: "custom", message: "外部讨论不能声明为 PDF 原句资料" });
});
const sources = z.array(ideaSourceSnapshotSchema).max(64).superRefine((values, ctx) => {
  if (new Set(values.map((value) => value.id)).size !== values.length)
    ctx.addIssue({ code: "custom", message: "资料快照 ID 重复" });
  if (values.reduce((sum, value) => sum + value.text.length, 0) > 192000)
    ctx.addIssue({ code: "custom", message: "历史资料快照过长" });
});
export const ideaMessageSchema = z.object({
  id: uuid, conversationId: uuid, requestId: uuid, role: z.enum(["user", "assistant"]),
  body: z.string().max(100000), status: z.enum(["pending", "completed", "failed", "cancelled"]),
  sources, provider: z.string().max(100), model: z.string().max(300), error: z.string().max(5000),
  createdAt: timestamp, updatedAt: timestamp,
  progress: chatProgressSchema.optional(),
  literatureSources: z.array(z.string().url().max(4000).refine(value => {
    try { const url = new URL(value); return !/[\s<>\\]/.test(value) && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; }
    catch { return false; }
  })).max(40).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.role === "user" && (value.status !== "completed" || !value.body.trim()))
    ctx.addIssue({ code: "custom", message: "提问记录状态无效" });
  if (value.role === "user" && value.literatureSources?.length)
    ctx.addIssue({ code: "custom", message: "提问不能冒充文献检索工具来源" });
  if (value.role === "assistant" && value.status === "completed" && !value.body.trim())
    ctx.addIssue({ code: "custom", message: "完整回复不能为空" });
});
export const ideaConversationSchema = z.object({
  id: uuid, noteId: uuid, title: z.string().trim().min(1).max(300),
  createdAt: timestamp, updatedAt: timestamp, messages: z.array(ideaMessageSchema).max(10000),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.messages.map((message) => message.id)).size !== value.messages.length ||
      value.messages.some((message) => message.conversationId !== value.id) ||
      value.messages.filter((message) => message.status === "pending").length > 1)
    ctx.addIssue({ code: "custom", message: "讨论消息归属、ID 或进行中状态无效" });
  const requests = new Set<string>();
  for (let index = 0; index < value.messages.length; index += 2) {
    const user = value.messages[index], reply = value.messages[index + 1];
    if (!user || !reply || user.role !== "user" || reply.role !== "assistant" ||
        user.requestId !== reply.requestId || requests.has(user.requestId) ||
        JSON.stringify(user.sources) !== JSON.stringify(reply.sources) ||
        (reply.status === "pending" && index + 2 !== value.messages.length))
      ctx.addIssue({ code: "custom", message: "讨论提问与回复未成对或请求 ID 重复" });
    if (user) requests.add(user.requestId);
  }
});
export const ideaSummarySectionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20000), sourceIds: z.array(z.string().min(1).max(400)).max(64),
}).strict();
export const ideaSummarySchema = z.object({
  id: uuid, requestId: uuid, noteId: uuid, conversationId: uuid, title: z.string().trim().min(1).max(300),
  sections: z.array(ideaSummarySectionSchema).min(1).max(12),
  messageIds: z.array(uuid).min(1).max(100), messages: z.array(ideaMessageSchema).min(1).max(100),
  sources, baseRevision: positive, provider: z.string().max(100), model: z.string().max(300), createdAt: timestamp,
  requestedModel: z.string().max(300).optional(),
  applications: z.array(z.object({ requestId: uuid, requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/), targetNoteId: uuid, sectionIds: z.array(z.string()).min(1).max(12), createdAt: timestamp }).strict()).max(10000),
}).strict().superRefine((value, ctx) => {
  const ids = new Set(value.sections.map((section) => section.id));
  const sourceIds = new Set(value.sources.map((source) => source.id));
  if (ids.size !== value.sections.length || new Set(value.messageIds).size !== value.messageIds.length ||
      value.messageIds.length !== value.messages.length || value.messages.some((message, index) =>
        message.id !== value.messageIds[index] || message.conversationId !== value.conversationId || message.status !== "completed") ||
      value.sections.some((section) => new Set(section.sourceIds).size !== section.sourceIds.length || section.sourceIds.some((id) => !sourceIds.has(id))))
    ctx.addIssue({ code: "custom", message: "整理稿的消息、段落或来源不一致" });
  const requests = new Set<string>(), applied = new Set<string>();
  for (const application of value.applications) {
    if (requests.has(application.requestId) || new Set(application.sectionIds).size !== application.sectionIds.length ||
        application.sectionIds.some((id) => !ids.has(id))) ctx.addIssue({ code: "custom", message: "整理稿采纳记录无效" });
    requests.add(application.requestId);
    for (const id of application.sectionIds) {
      const key = `${application.targetNoteId}:${id}`;
      if (applied.has(key)) ctx.addIssue({ code: "custom", message: "整理稿段落重复采纳" });
      applied.add(key);
    }
  }
});
export const ideaSendRequestSchema = z.object({
  noteId: uuid, conversationId: uuid.optional(), requestId: uuid, message: z.string().trim().min(1).max(12000),
  sources: z.array(ideaSourceInputSchema).max(8).default([]), includeCurrentNote: z.boolean().default(false),
  revision: positive,
  model: z.string().trim().min(1).max(300).regex(/^[^\u0000-\u001f\u007f]+$/, "模型名称必须是单行文字").optional(),
}).strict();
export const ideaSummaryRequestSchema = z.object({
  noteId: uuid, conversationId: uuid, messageIds: z.array(uuid).min(1).max(100), revision: positive, requestId: uuid,
  model: z.string().trim().min(1).max(300).regex(/^[^\u0000-\u001f\u007f]+$/, "模型名称必须是单行文字").optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.messageIds).size !== value.messageIds.length) ctx.addIssue({ code: "custom", message: "整理消息不能重复" });
});
export const ideaSummaryApplySchema = z.object({
  noteId: uuid, summaryId: uuid, requestId: uuid,
  destination: z.object({ kind: z.enum(["current", "new", "topic"]), topicId: uuid.optional(), title: z.string().trim().min(1).max(1000).optional() }).strict(),
  revision: positive.optional(), sectionIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)).min(1).max(12),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.sectionIds).size !== value.sectionIds.length ||
      (value.destination.kind === "topic") !== Boolean(value.destination.topicId) ||
      (value.destination.kind !== "new" && value.revision === undefined))
    ctx.addIssue({ code: "custom", message: "采纳目标、修订号或段落选择无效" });
});
