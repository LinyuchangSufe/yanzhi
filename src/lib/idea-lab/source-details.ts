import type { AIContent, KBState } from "../types";
import type { ExternalMessage } from "../codex-import/types";
import type { GuideEvidence } from "../guide/types";
import type { IdeaSourceInput, IdeaSourceSnapshot } from "./types";

export function guideEvidenceSourceInput(guideId: string, evidenceId: string): IdeaSourceInput {
  return { type: "guideEvidence", id: guideId, evidenceId, revision: 1, field: "quote" };
}

/** Exact shared UTF-16 selection surface; message text and line endings remain untouched. */
export function externalDiscussionBody(messages: readonly ExternalMessage[]): string {
  return messages.map((message) => `${message.role === "user" ? "用户" : "AI"}：${message.text}`).join("\n\n");
}
export function externalDiscussionTurnStatuses(turnIds: readonly string[], statuses?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(turnIds.map((id) => [id, statuses?.[id] || "unknown"]));
}

/** Metadata checks are shared by previews and sending. Disk SHA verification remains server-only. */
export function guideEvidenceProblem(state: KBState, content: AIContent, evidence: GuideEvidence, historical = false): string {
  const guide = content.guideData;
  if (content.status !== "completed" || !["guide", "comparison"].includes(content.kind) || !guide || guide.mode !== content.kind ||
      !guide.paperIds.includes(content.paperId) || !guide.paperIds.includes(evidence.paperId) ||
      guide.evidence.filter((item) => item.id === evidence.id).length !== 1) return "导读记录或原句证据已失效，请重新选择。";
  if (!evidence.matched || !evidence.quote.trim()) return "这条证据尚未匹配到原文，不能作为原文资料发送。";
  const paper = state.papers.find((item) => item.id === evidence.paperId);
  const owner = state.papers.find((item) => item.id === content.paperId);
  if (!paper || !owner || (!historical && (paper.deletedAt || owner.deletedAt))) return "导读所属文献已不存在或在回收站，原文快照仍可查看。";
  const sources = guide.sources.filter((item) => item.attachmentId === evidence.attachmentId);
  const source = sources[0], file = state.attachments.find((item) => item.id === evidence.attachmentId);
  if (sources.length !== 1 || !source || !file || (!historical && file.status !== "available")) return "导读的 PDF 附件缺失，请恢复原附件后引用。";
  if (file.paperId !== paper.id || source.paperId !== paper.id || file.sha256 !== evidence.attachmentSha256 ||
      file.sha256 !== source.attachmentSha256 || source.filename !== file.filename || evidence.pageIndex < 0 ||
      evidence.pageIndex >= source.pageCount || !source.parsedPages.includes(evidence.pageIndex) ||
      !evidence.blockId.startsWith(`${file.id}:${evidence.pageIndex}:`)) return "导读证据的附件指纹、页码或来源已变化，请重新核对。";
  return "";
}

export function ideaSourceScope(source: Pick<IdeaSourceSnapshot, "type" | "field" | "externalTurnStatuses">): string {
  if (source.type === "guideEvidence") return "已匹配的导读原文证据，仅此原句；不含 AI 解释";
  if (source.type === "externalDiscussion") return Object.values(source.externalTurnStatuses ?? { unknown: "unknown" }).some((status) => status !== "completed")
    ? "外部讨论部分轮次未完成或状态未知，仅当时公开正文，不是论文原文"
    : "已导入的 Codex 用户/AI 公开对话正文，不是论文原文";
  if (source.field === "abstract") return "仅论文摘要，未读取 PDF 全文";
  if (source.field === "quote") return "已保存的 PDF 批注选文，仅此片段";
  if (source.field === "comment") return "个人批注评论，不是论文原文";
  return "主动选择的个人记录或片段";
}
