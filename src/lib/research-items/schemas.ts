import { z } from "zod";

const uuid = z.string().uuid(), revision = z.number().int().positive(), timestamp = z.string().datetime();
export const researchSourceInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), id: uuid, revision }).strict(),
  z.object({ kind: z.literal("noteSelection"), id: uuid, revision, from: z.number().int().nonnegative(), to: z.number().int().positive() }).strict().refine(value => value.to > value.from, "笔记选段范围无效"),
  z.object({ kind: z.literal("annotation"), id: uuid, revision }).strict(),
  z.object({ kind: z.literal("guideEvidence"), id: uuid, evidenceId: z.string().min(1).max(300) }).strict(),
  z.object({ kind: z.literal("guideQuestion"), id: uuid, questionIndex: z.number().int().nonnegative().max(10000) }).strict(),
  z.object({ kind: z.literal("ideaMessage"), conversationId: uuid, messageId: uuid }).strict(),
  z.object({ kind: z.literal("externalDiscussion"), id: uuid, revision, messageIds: z.array(z.string().min(1).max(300)).min(1).max(30).refine(values => new Set(values).size === values.length, "讨论消息重复").optional() }).strict(),
]);
export const researchItemSourceSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), input: researchSourceInputSchema,
  title: z.string().min(1).max(1000), text: z.string().min(1).max(32000),
  sourceHref: z.string().max(500).regex(/^(?:kb:\/\/(?:note|annotation|ai|topic|paper|externalDiscussion)\/[0-9a-f-]{36}|codex:\/\/threads\/[^\s?#]+)$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), capturedAt: timestamp,
  origin: z.enum(["personal", "annotation", "ai", "external"]),
  paperId: uuid.optional(), attachmentId: uuid.optional(), attachmentSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  pageIndex: z.number().int().nonnegative().optional(), pageLabel: z.string().max(500).optional(),
}).strict();
export const researchItemStatusSchema = z.enum(["pending", "in_progress", "resolved", "parked"]);
const snapshots = z.array(researchItemSourceSchema).max(12).refine(values => new Set(values.map(value => value.id)).size === values.length, "来源重复")
  .refine(values => values.reduce((sum, value) => sum + value.text.length, 0) <= 192000, "来源总量过长");
export const researchItemSchema = z.object({
  id: uuid, topicId: uuid, title: z.string().trim().min(1).max(1000), body: z.string().max(20000), nextAction: z.string().max(5000),
  status: researchItemStatusSchema, sourceRefs: snapshots, resultRefs: snapshots, resolution: z.string().max(5000),
  revision, createdAt: timestamp, updatedAt: timestamp, archivedAt: timestamp.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "resolved" && (!value.resultRefs.length || !value.resolution.trim())) ctx.addIssue({ code: "custom", message: "解决时请选择结果来源并写下你的判断" });
  if (value.resultRefs.some(source => source.input.kind === "guideQuestion")) ctx.addIssue({ code: "custom", message: "AI 后续问题不能作为已解决的结果" });
});
const inputs = z.array(researchSourceInputSchema).max(12).refine(values => new Set(values.map(value => JSON.stringify(value))).size === values.length, "来源重复");
export const createResearchItemSchema = z.object({ action: z.literal("create"), id: uuid, topicId: uuid,
  title: z.string().trim().min(1).max(1000), body: z.string().max(20000).default(""), nextAction: z.string().max(5000).default(""), sourceRefs: inputs.default([]),
}).strict();
export const updateResearchItemSchema = z.object({ action: z.literal("update"), id: uuid, revision,
  topicId: uuid.optional(), sourceRefs: inputs.optional(),
  title: z.string().trim().min(1).max(1000).optional(), body: z.string().max(20000).optional(), nextAction: z.string().max(5000).optional(),
  status: researchItemStatusSchema.optional(), resultRefs: inputs.optional(), resolution: z.string().max(5000).optional(),
}).strict();
export const researchItemRequestSchema = z.discriminatedUnion("action", [createResearchItemSchema, updateResearchItemSchema,
  z.object({ action: z.literal("archive"), id: uuid, revision }).strict(),
  z.object({ action: z.literal("restore"), id: uuid, revision }).strict(),
  z.object({ action: z.literal("preview"), sourceRefs: inputs }).strict(),
]);
