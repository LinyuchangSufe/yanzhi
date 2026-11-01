import { z } from "zod";
import { chatProgressSchema } from "../ai/chat-progress";
import { chatContextInputSchema, chatContextsSchema } from "./context-schemas";
export { chatContextInputSchema, chatContextSchema } from "./context-schemas";
const uuid = z.string().uuid();
const stamp = z.iso.datetime();
export const chatScopeSchema = z.object({
  attachmentId: uuid, attachmentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  pageIndices: z.array(z.number().int().nonnegative()).max(10000),
  totalPages: z.number().int().positive(), characterCount: z.number().int().nonnegative().max(50000),
  truncated: z.boolean(), historyMessages: z.number().int().nonnegative().max(20), historyTruncated: z.boolean(),
}).strict().refine((scope) => scope.pageIndices.every((index) => index < scope.totalPages), "聊天页码超出附件范围");
export const paperChatMessageSchema = z.object({
  id: uuid, conversationId: uuid, role: z.enum(["user", "assistant"]),
  body: z.string().max(100000), status: z.enum(["pending", "completed", "cancelled", "failed"]),
  provider: z.string().max(100), model: z.string().max(300), scope: chatScopeSchema.nullable(),
  error: z.string().max(2000), createdAt: stamp, updatedAt: stamp,
  contexts: chatContextsSchema.optional(),
  progress: chatProgressSchema.optional(),
  literatureSources: z.array(z.string().url().max(4000).refine(value => {
    try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; }
    catch { return false; }
  })).max(40).optional(),
}).strict().superRefine((message, context) => {
  if (message.role === "user" && (message.status !== "completed" || !message.body.trim() || message.scope !== null))
    context.addIssue({code: "custom", message: "聊天用户消息状态无效"});
  if (message.role === "assistant" && !message.scope)
    context.addIssue({code: "custom", message: "聊天回复缺少阅读范围"});
  if (message.role === "assistant" && message.contexts !== undefined)
    context.addIssue({code: "custom", message: "个人引用只能附在用户提问中"});
  if (message.role === "user" && message.literatureSources?.length)
    context.addIssue({code: "custom", message: "提问不能冒充文献检索工具来源"});
  if (message.status === "completed" && !message.body.trim())
    context.addIssue({code: "custom", message: "聊天完成消息正文为空"});
});
export const paperChatConversationSchema = z.object({
  id: uuid, paperId: uuid, attachmentId: uuid, attachmentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().min(1).max(120), createdAt: stamp, updatedAt: stamp,
  messages: z.array(paperChatMessageSchema).max(10000),
}).strict();
export const paperChatReplaySchema = z.object({
  sourceConversationId: uuid, sourceMessageId: uuid, kind: z.enum(["retry", "edit"]),
}).strict();
export type PaperChatReplay = z.infer<typeof paperChatReplaySchema>;
export const paperChatInputSchema = z.object({
  paperId: uuid, attachmentId: uuid, conversationId: uuid.optional(),
  replay: paperChatReplaySchema.optional(),
  contexts: z.array(chatContextInputSchema).max(8).optional(),
  message: z.string().trim().min(1).max(12000),
  model: z.string().trim().min(1).max(300).regex(/^[^\u0000-\u001f\u007f]+$/, "模型名称必须是单行文字").optional(),
}).strict().refine((input) => !input.replay || !input.conversationId, "重试或编辑提问必须创建新对话")
  .refine((input) => !input.replay || input.contexts === undefined, "重试或编辑提问会沿用原引用，不能替换引用内容");
export const paperChatRenameSchema = z.object({
  paperId: uuid, conversationId: uuid,
  title: z.string().trim().min(1).max(120),
}).strict();
