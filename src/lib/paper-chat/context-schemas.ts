import { z } from "zod";

export const chatContextInputSchema = z.object({
  noteId: z.string().uuid(),
  revision: z.number().int().min(1),
  mode: z.enum(["full", "excerpt"]),
  field: z.enum(["body", "description"]).optional(),
  start: z.number().int().min(0).optional(),
  end: z.number().int().min(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === "full" && (value.start !== undefined || value.end !== undefined))
    context.addIssue({code: "custom", message: "全文引用无需指定片段范围"});
  if (value.mode === "excerpt" && (value.start === undefined || value.end === undefined || value.start >= value.end))
    context.addIssue({code: "custom", message: "请选择有效的引用片段"});
});

export const chatContextSchema = z.object({
  noteId: z.string().uuid(),
  topicId: z.string().uuid().optional(),
  title: z.string().max(1000),
  purpose: z.enum(["paper", "topic", "idea"]),
  revision: z.number().int().min(1),
  mode: z.enum(["full", "excerpt"]),
  field: z.enum(["body", "description"]).optional(),
  text: z.string().min(1).max(16000).refine((text) => !!text.trim(), "引用内容不能为空"),
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  sourceHref: z.string().max(100),
}).strict().superRefine((value, context) => {
  if (value.end - value.start !== value.text.length || (value.mode === "full" && value.start !== 0))
    context.addIssue({code: "custom", message: "引用文本与保存的范围不一致"});
  if (value.field === "description" && (value.purpose !== "topic" || !value.topicId))
    context.addIssue({code: "custom", message: "问题描述缺少对应研究问题"});
  if (value.topicId && value.purpose !== "topic")
    context.addIssue({code: "custom", message: "引用记录类型与研究问题不一致"});
  const href = value.topicId ? `kb://topic/${value.topicId}` : `kb://note/${value.noteId}`;
  if (value.sourceHref !== href) context.addIssue({code: "custom", message: "引用来源链接与记录不一致"});
});

export const chatContextsSchema = z.array(chatContextSchema).max(8).superRefine((values, context) => {
  if (values.reduce((length, item) => length + item.text.length, 0) > 24000)
    context.addIssue({code: "custom", message: "本轮引用总共最多 24000 字"});
  const seen = new Set<string>();
  for (const item of values) {
    const key = `${item.noteId}:${item.field ?? "body"}:${item.start}:${item.end}`;
    if (seen.has(key)) context.addIssue({code: "custom", message: "同一段内容重复引用"});
    seen.add(key);
  }
});
