import type { IdeaSourceDraft } from "./idea-lab/types";
import type { ResearchItem } from "./research-items/types";

/** Saved evidence is handed over verbatim, even after the live source changes. */
export function researchItemDiscussionDraft(item: ResearchItem): IdeaSourceDraft {
  const label = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/[\\\[\]]/g, "\\$&");
  const snapshots = (values: ResearchItem["sourceRefs"], label: string) => values.map(source =>
    `### ${label}：${source.title}\n来源：[所选来源](${source.input.kind === "externalDiscussion" ? `kb://discussion/${source.input.id}` : source.sourceHref})${source.input.kind === "externalDiscussion" ? `；[Codex 原会话](${source.sourceHref})` : ""}\n保存时间：${source.capturedAt}；来源性质：${source.origin}${"revision" in source.input ? `；所选修订：${source.input.revision}` : ""}\n\n${source.text}`);
  const prompt = [
    `继续推敲待核验问题：${item.title}\n来源条目：[${label(item.title)}](kb://research-item/${item.id})（修订 ${item.revision}）`,
    item.body, item.nextAction ? `原定下一步：${item.nextAction}` : "",
    item.resolution ? `我已记录的判断：${item.resolution}` : "",
    "以下是该条目已保存的依据快照，可能属于历史修订。没有重新读取当前原文；AI 内容与导入讨论中的结论仍需核验。请指出证据缺口，梳理下一步，不要把建议当成已验证事实。",
    ...snapshots(item.sourceRefs, "问题依据"), ...snapshots(item.resultRefs, "用户选定的结果依据"),
  ].filter(Boolean).join("\n\n");
  if (prompt.length > 12000) throw new Error("条目与依据快照超过 12,000 字符，请精简条目或新建较小范围的待核验问题后再讨论；原记录保留，尚未发送。");
  return { title: item.title, sources: [], prompt };
}
