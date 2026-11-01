import { z } from "zod";
const timestamp = z.string().datetime();
const stableId = z.string().min(1).max(300);
const ids = z.array(z.string().uuid()).max(500).refine((values) => new Set(values).size === values.length, "对象 ID 重复");
export const externalDiscussionContextSchema = z.object({ paperIds: ids.default([]), topicIds: ids.default([]), noteIds: ids.default([]) }).strict();
export const codexSourceSchema = z.object({ id: z.string().min(1).max(200), label: z.string().max(500), host: z.string().max(500), home: z.string().max(2000), sqliteHome: z.string().max(2000).nullable(), binary: z.string().max(2000) }).strict();
export const externalMessageSchema = z.object({ id: stableId, turnId: stableId, role: z.enum(["user", "assistant"]), text: z.string().min(1).max(1000000) }).strict();
const messages = z.array(externalMessageSchema).max(20000).superRefine((values, ctx) => {
  if (new Set(values.map((message) => `${message.turnId}\0${message.id}`)).size !== values.length) ctx.addIssue({ code: "custom", message: "消息标识重复" });
  if (values.reduce((sum, message) => sum + message.text.length, 0) > 2000000) ctx.addIssue({ code: "custom", message: "所选正文过长，请减少轮次后分批导入" });
});
const turnStatuses = z.record(stableId, z.string().max(100)).optional();
export const externalDiscussionVersionSchema = z.object({ revision: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().min(1).max(1000), messages, sourceUpdatedAt: timestamp, capturedAt: timestamp, turnStatuses }).strict();
export const externalDiscussionSchema = externalDiscussionContextSchema.extend({
  id: z.string().uuid(), title: z.string().min(1).max(1000), threadId: stableId,
  sourceHref: z.string().max(500), source: codexSourceSchema,
  selectedTurnIds: z.array(stableId).min(1).max(2000), messages,
  revision: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/),
  importedAt: timestamp, refreshedAt: timestamp, sourceUpdatedAt: timestamp,
  history: z.array(externalDiscussionVersionSchema).max(200), turnStatuses,
}).strict().superRefine((value, ctx) => {
  const turns = new Set(value.selectedTurnIds);
  if (turns.size !== value.selectedTurnIds.length || value.sourceHref !== `codex://threads/${encodeURIComponent(value.threadId)}` ||
      value.messages.some((message) => !turns.has(message.turnId)) || !value.messages.length ||
      value.history.some((version) => version.revision >= value.revision || version.messages.some((message) => !turns.has(message.turnId))) ||
      new Set(value.history.map((version) => version.revision)).size !== value.history.length ||
      Object.keys(value.turnStatuses ?? {}).some((id) => !turns.has(id)) || value.history.some((version) => Object.keys(version.turnStatuses ?? {}).some((id) => !turns.has(id))))
    ctx.addIssue({ code: "custom", message: "外部讨论来源、轮次或历史修订不一致" });
});
export const codexHistoryRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("import"), threadId: stableId, sourceId: stableId, historyHash: z.string().regex(/^[a-f0-9]{64}$/), selectedTurnIds: z.array(stableId).min(1).max(2000), context: externalDiscussionContextSchema.default({ paperIds: [], topicIds: [], noteIds: [] }) }).strict(),
  z.object({ action: z.literal("refresh"), id: z.string().uuid(), revision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("link"), id: z.string().uuid(), revision: z.number().int().positive(), context: externalDiscussionContextSchema }).strict(),
]);
