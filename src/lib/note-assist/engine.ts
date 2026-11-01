import { randomUUID } from "node:crypto";
import { z } from "zod";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { aiConfiguration } from "../ai";
import { requestStructuredAI } from "../ai/request";
import { getStore, StoreError } from "../db";
import { assistNote, buildNoteAssistSources } from "./context";
import { noteAssistOutputSchema, noteAssistPrompt } from "./prompt";
import { validateEdits } from "./patches";
import { captureNoteRevision, saveNoteAssistance } from "./store";
import type { NoteAssistance, NoteAssistSource } from "./types";

export const generationSchema = z.object({
  noteId: z.string().uuid(),
  revision: z.number().int().positive(),
  mode: z.enum(["polish", "structure", "advise"]),
  selection: z.object({ from: z.number().int().nonnegative(),
    to: z.number().int().positive(), text: z.string().min(1).max(40_000) }).strict().optional(),
  paperIds: z.array(z.string().uuid()).max(3).default([]),
  ideaIds: z.array(z.string().uuid()).max(3).default([]),
}).strict().superRefine((input, ctx) => {
  if (input.selection && (input.selection.to <= input.selection.from ||
    input.selection.to - input.selection.from !== input.selection.text.length))
    ctx.addIssue({ code: "custom", message: "选段位置与文字长度不一致" });
  for (const key of ["paperIds", "ideaIds"] as const)
    if (new Set(input[key]).size !== input[key].length)
      ctx.addIssue({ code: "custom", path: [key], message: "所选资料不能重复" });
});

export const assistResultSchema = z.object({
  overview: z.string().trim().min(1).max(8_000),
  edits: z.array(z.object({
    before: z.string().min(1).max(20_000),
    after: z.string().max(20_000),
    reason: z.string().trim().min(1).max(3_000),
  }).strict()).max(20),
  suggestions: z.array(z.object({
    title: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(8_000),
    basis: z.enum(["note", "literature", "hypothesis"]),
    evidenceIds: z.array(z.string().min(1).max(250)).max(24),
  }).strict()).max(12),
}).strict();

function verifyReferences(result: z.infer<typeof assistResultSchema>, sources: NoteAssistSource[]) {
  const byId = new Map(sources.map((source) => [source.id, source]));
  for (const suggestion of result.suggestions) {
    if (new Set(suggestion.evidenceIds).size !== suggestion.evidenceIds.length ||
      suggestion.evidenceIds.some((id) => !byId.has(id)))
      throw new StoreError("AI 建议引用了未提供或重复的来源，未保存结果；原稿保留", 502);
    if (suggestion.basis === "literature" && !suggestion.evidenceIds.some((id) =>
      ["paper-abstract", "pdf-evidence"].includes(byId.get(id)!.kind)))
      throw new StoreError("文献判断缺少实际文献证据，未保存结果；原稿保留", 502);
  }
  // Model prose is rendered as Markdown and may later be inserted into a note.
  // Keep clickable links bounded to supplied content and explicitly selected entities.
  const allowed = new Set(sources.flatMap((source) => markdownUrls(source.text)));
  for (const source of sources) {
    if (source.paperId) allowed.add(`kb://paper/${source.paperId}`);
    if (source.noteId) allowed.add(`kb://note/${source.noteId}`);
    if (source.kind === "topic") allowed.add(`kb://topic/${source.id.slice("topic:".length)}`);
  }
  const prose = [result.overview, ...result.edits.map((edit) => edit.reason),
    ...result.suggestions.flatMap((suggestion) => [suggestion.title, suggestion.body])];
  const outputUrls = [...prose.flatMap((text) => markdownUrls(text, true)),
    ...result.edits.flatMap((edit) => markdownUrls(edit.after))];
  if (outputUrls.some((url) => !url.startsWith("#") && !allowed.has(url)))
    throw new StoreError("AI 建议包含未提供的链接或引用，未保存结果；原稿保留", 502);
}

interface MarkdownNode { type?: string; url?: string; children?: MarkdownNode[] }
const parser = unified().use(remarkParse).use(remarkGfm);
function markdownUrls(text: string, rejectImages = false): string[] {
  const urls: string[] = [];
  const visit = (node: MarkdownNode) => {
    if (rejectImages && ["image", "imageReference"].includes(node.type ?? ""))
      throw new StoreError("AI 建议包含未提供的链接或引用（图片不能由 AI 新增），未保存结果；原稿保留", 502);
    if (node.url) urls.push(node.url);
    for (const child of node.children ?? []) visit(child);
  };
  visit(parser.parse(text) as MarkdownNode);
  return urls;
}

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new StoreError("笔记 AI 建议已取消，未保存新结果；原稿保留", 499);
}

export async function generateNoteAssistance(input: z.input<typeof generationSchema>,
  signal?: AbortSignal): Promise<NoteAssistance> {
  const request = generationSchema.parse(input);
  const store = getStore();
  const state = store.snapshot();
  const note = assistNote(state, request.noteId);
  if (note.revision !== request.revision)
    throw new StoreError("笔记已更新，请保存并刷新 AI 读取范围后重试；原稿保留", 409);
  if (request.selection && note.body.slice(request.selection.from, request.selection.to) !== request.selection.text)
    throw new StoreError("选段与当前原稿不一致，请重新选取；原稿保留", 409);
  cancelled(signal);
  const config = aiConfiguration();
  if (!config.configured) throw new StoreError("请先在设置中配置 Codex 或本地模型，再使用 AI 辅助；原稿保留", 422);
  const sources = buildNoteAssistSources(store, state, note, request.selection,
    request.paperIds, request.ideaIds);
  const prompt = noteAssistPrompt(request.mode, note.purpose, Boolean(request.selection), sources);
  captureNoteRevision(store, note, "ai-start");
  let response: { text: string; model: string };
  try {
    response = await requestStructuredAI(config, prompt, noteAssistOutputSchema, signal);
  } catch (error) {
    cancelled(signal);
    const status = error instanceof StoreError && [409, 422, 429].includes(error.status) ? error.status : 502;
    const message = status === 429 ? "模型额度已用完或请求过于频繁，请稍后重试" :
      status === 409 ? "已有模型请求正在运行，请等待完成后再试" :
      status === 422 ? "模型配置、CLI 安装或登录状态不可用，请在设置中测试连接" :
      "模型服务连接失败、超时或返回无效内容，请检查连接后重试";
    throw new StoreError(`${message}；未保存新结果，原稿保留`, status);
  }
  cancelled(signal);
  let result: z.infer<typeof assistResultSchema>;
  try {
    result = assistResultSchema.parse(JSON.parse(response.text) as unknown);
  } catch {
    throw new StoreError("AI 返回格式无效，未保存结果；原稿保留", 502);
  }
  verifyReferences(result, sources);
  if (request.mode === "advise" && result.edits.length)
    throw new StoreError("研究建议不能修改原稿，未保存结果；原稿保留", 502);
  try {
    validateEdits(note.body, request.selection ?? null, result.edits);
  } catch {
    throw new StoreError("AI 修改与原文不匹配，或涉及公式、引用等受保护内容，未保存结果；原稿保留", 502);
  }
  cancelled(signal);
  const record: NoteAssistance = {
    id: randomUUID(), noteId: note.id, mode: request.mode,
    baseRevision: note.revision, baseTitle: note.title, baseBody: note.body,
    selection: request.selection ?? null,
    paperIds: request.paperIds, ideaIds: request.ideaIds, sources, result,
    provider: config.provider, model: response.model,
    appliedEdits: [], lastAppliedRevision: note.revision,
    createdAt: new Date().toISOString(),
  };
  // The source paper may have been moved to trash while the model was running.
  assistNote(store.snapshot(), note.id);
  saveNoteAssistance(store, record);
  return record;
}
