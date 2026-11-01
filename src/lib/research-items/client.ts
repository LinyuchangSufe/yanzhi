import { researchItemSchema, researchItemSourceSchema, researchSourceInputSchema } from "./schemas";
import type { ResearchItem, ResearchSourceInput } from "./types";
export const researchStatusLabels = { pending: "待核验", in_progress: "核验中", resolved: "已解决", parked: "暂搁" } as const;
export const researchInputKey = (input: ResearchSourceInput) => JSON.stringify(researchSourceInputSchema.parse(input));
export async function researchRequest(payload: unknown, signal?: AbortSignal) {
  const response = await fetch("/api/kb/research-items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal });
  const value = await response.json() as { error?: string; item?: unknown; sources?: unknown };
  if (!response.ok) throw Object.assign(new Error(value.error || "待核验清单保存失败，当前输入保留。"), { status: response.status });
  return value;
}
export async function previewResearchSources(inputs: ResearchSourceInput[], signal?: AbortSignal) {
  return researchItemSourceSchema.array().parse((await researchRequest({ action: "preview", sourceRefs: inputs }, signal)).sources);
}
export async function saveResearchItem(payload: unknown) { return researchItemSchema.parse((await researchRequest(payload)).item); }
export function researchItemMarkdown(item: ResearchItem): string {
  const link = (source: ResearchItem["sourceRefs"][number]) => `[${source.title.replace(/[\[\]\r\n]/g, " ")}](${source.input.kind === "externalDiscussion" ? `kb://discussion/${source.input.id}` : source.sourceHref})`;
  const sources = item.sourceRefs.map(source => `- ${link(source)}${source.origin === "ai" ? "（AI 内容，仍需核验）" : source.origin === "external" ? "（导入讨论，仍需核验）" : ""}`).join("\n");
  const results = item.resultRefs.map(source => `- ${link(source)}`).join("\n");
  return `\n## ${item.title}\n\n状态：${researchStatusLabels[item.status]} · [待核验条目](kb://research-item/${item.id})\n\n${item.body}${item.nextAction ? `\n\n下一步：${item.nextAction}` : ""}${item.resolution ? `\n\n我的核验判断：${item.resolution}` : ""}${sources ? `\n\n问题来源：\n${sources}` : ""}${results ? `\n\n结果来源（由用户选择）：\n${results}` : ""}\n\n`;
}
