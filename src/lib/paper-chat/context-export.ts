import type { ChatContext } from "./types";

/** Export the saved snapshot rather than reading a possibly changed source note. */
export function exportChatContextsMarkdown(contexts?: readonly ChatContext[]): string {
  if (!contexts?.length) return "";
  return "### 本轮个人引用\n\n" + contexts.map((item, index) => {
    const title = item.title.replace(/\\/g, "\\\\").replace(/([\[\]])/g, "\\$1").replace(/[\r\n]+/g, " ");
    const kind = item.field === "description" ? "问题描述" : item.purpose === "topic" ? "研究问题笔记" : item.purpose === "idea" ? "想法" : "笔记";
    return `#### ${index + 1}. [${title}](${item.sourceHref})\n\n${kind} · ${item.mode === "full" ? "全文" : "片段"} · 修订 ${item.revision}；保存的是提问时的个人记录，非 PDF 原文。\n\n${item.text.split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
  }).join("");
}
