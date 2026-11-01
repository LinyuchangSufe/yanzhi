import type { KBState } from "./types";
import type { ResearchItem } from "./research-items/types";

const statuses = { pending: "待核验", in_progress: "核验中", resolved: "已解决", parked: "暂搁" };
const label = (text: string) => text.replace(/[\[\]\r\n]/g, " ");

/** User-reviewed research entries remain separate from the original topic document. */
export function researchItemMarkdown(item: ResearchItem): string {
  const refs = (values: ResearchItem["sourceRefs"]) => values.map((source) =>
    `- [${label(source.title)}](${source.input.kind === "externalDiscussion" ? `kb://discussion/${source.input.id}` : source.sourceHref})${source.input.kind === "externalDiscussion" ? ` · [原会话](${source.sourceHref})` : ""}${source.pageIndex === undefined ? "" : ` · 物理第 ${source.pageIndex + 1} 页`}\n\n${source.text.split("\n").map((line) => `> ${line}`).join("\n")}`).join("\n\n");
  return `## ${item.title}\n\n状态：${statuses[item.status]}${item.archivedAt ? " · 已归档" : ""}。\n\n${item.body}\n\n${item.nextAction ? `下一步：${item.nextAction}\n\n` : ""}${item.resolution ? `核验记录：${item.resolution}\n\n` : ""}来源条目：[${item.title}](kb://research-item/${item.id})\n\n### 依据快照\n\n${refs(item.sourceRefs) || "尚未附依据，内容仍需核验。"}\n\n${item.resultRefs.length ? `### 结果来源\n\n${refs(item.resultRefs)}\n\n` : ""}`;
}

export function exportResearchMarkdown(state: KBState): string {
  const discussions = (state.externalDiscussions ?? []).map((discussion) =>
    `# Codex 讨论资料：${discussion.title}\n\n<!-- stable-discussion-id: ${discussion.id}; revision: ${discussion.revision} -->\n\n来源：[原会话](${discussion.sourceHref})；导入 ${discussion.importedAt}；最近检查 ${discussion.refreshedAt}；所选 ${discussion.selectedTurnIds.length} 轮。\n\n${discussion.messages.map((message) => `## ${message.role === "user" ? "提问" : "AI 公开回复"}\n\n${message.text}`).join("\n\n")}\n\n${discussion.history.map((version) => `<details><summary>旧资料修订 ${version.revision} · ${version.capturedAt}</summary>\n\n${version.messages.map((message) => `### ${message.role === "user" ? "提问" : "AI 公开回复"}\n\n${message.text}`).join("\n\n")}\n\n</details>`).join("\n\n")}`);
  const items = (state.researchItems ?? []).map((item) =>
    `# 待核验清单：${state.topics.find((topic) => topic.id === item.topicId)?.title ?? item.topicId}\n\n<!-- stable-research-item-id: ${item.id}; revision: ${item.revision} -->\n\n${researchItemMarkdown(item)}`);
  return [...discussions, ...items].join("\n\n---\n\n");
}
