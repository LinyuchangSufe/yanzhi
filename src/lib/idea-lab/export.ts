import type { IdeaConversation, IdeaSourceSnapshot, IdeaSummary } from "./types";

const heading = (value: string) => value.replace(/[\r\n]+/g, " ");
function sourcesMarkdown(sources: readonly IdeaSourceSnapshot[]): string {
  return sources.map((source) => `### ${heading(source.title)}\n\n来源：${source.sourceHref}；范围：${source.field}，字符 [${source.start}, ${source.end})；修订 ${source.revision}${source.pageIndex === undefined ? "" : `；物理页 ${source.pageIndex + 1}；附件 ${source.attachmentId}；SHA-256 ${source.attachmentSha256}`}。\n\n${source.text}`).join("\n\n");
}

/** Unaccepted discussion stays separate from personal Markdown in full-library exports. */
export function exportIdeaLabMarkdown(conversations: readonly IdeaConversation[], summaries: readonly IdeaSummary[]): string {
  const discussions = conversations.map((conversation) =>
    `# 想法讨论：${heading(conversation.title)}\n\n<!-- idea-conversation-id: ${conversation.id}; note-id: ${conversation.noteId} -->\n\n${conversation.messages.map((message) => `## ${message.role === "user" ? "我的提问" : "AI 回复"} · ${message.status}\n\n<!-- message-id: ${message.id}; request-id: ${message.requestId} -->\n\n${message.body}\n\n${message.error ? `状态：${message.error}\n\n` : ""}提供方/模型：${message.provider} / ${message.model}。\n\n${message.sources.length ? `### 本轮实际资料快照\n\n${sourcesMarkdown(message.sources)}` : "本轮没有附加资料。"}`).join("\n\n")}`);
  const drafts = summaries.map((summary) =>
    `# 想法整理草稿：${heading(summary.title)}\n\n<!-- idea-summary-id: ${summary.id}; note-id: ${summary.noteId}; conversation-id: ${summary.conversationId} -->\n\n生成：${summary.createdAt}；${summary.provider} / ${summary.model}；原稿修订 ${summary.baseRevision}。\n\n${summary.sections.map((section) => `## ${heading(section.title)}\n\n${section.body}\n\n来源标识：${section.sourceIds.join("、") || "无，需核验"}`).join("\n\n")}\n\n## 采纳记录\n\n${summary.applications.map((application) => `- ${application.createdAt}：笔记 ${application.targetNoteId}；段落 ${application.sectionIds.join("、")}`).join("\n") || "尚未采纳，未自动写入个人正文。"}\n\n## 整理范围\n\n${summary.messageIds.join("、")}\n\n## 输入资料快照\n\n${sourcesMarkdown(summary.sources) || "无附加资料。"}`);
  return [...discussions, ...drafts].join("\n\n---\n\n");
}
