import { FileText, Link2, LoaderCircle } from "lucide-react";
import { useState } from "react";
import Markdown from "./Markdown";
import type { WorkspaceController } from "./Workspace";
import styles from "./GuidePanel.module.css";

export default function PaperAIHistory({ c, running, hasGuide, onRelated }: {
  c: WorkspaceController; running: boolean; hasGuide: boolean; onRelated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const history = c.state.aiContents.filter((a) => a.paperId === c.paper?.id &&
    ["summary", "translation", "explanation", "markdown"].includes(a.kind))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return <details className={styles.history} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary>翻译、识别与分析记录{history.length ? ` · ${history.length}` : ""}</summary>
    {c.aiBusy && c.aiTask?.paperId === c.paper?.id && <p className={styles.subtle}>
      <LoaderCircle size={12} className={styles.spin} /> 正在生成，可继续阅读。
      <button className={styles.textButton} onClick={c.cancelAI}>停止生成</button>
    </p>}
    <div className={styles.actions}>
      <button className={styles.textButton} disabled={Boolean(c.paper?.deletedAt) || c.aiBusy || running}
        onClick={() => void c.generateAI("summary")}><FileText size={12} />生成短摘要</button>
      {!hasGuide && <button className={styles.textButton} disabled={Boolean(c.paper?.deletedAt) || c.aiBusy || running}
        onClick={onRelated}><Link2 size={12} />关联分析</button>}
    </div>
    {history.map((a) => <article className={styles.legacyItem} key={a.id}>
      <span className={styles.legacyBadge}>{a.kind === "markdown" ? "Markdown + LaTeX 识别" : a.kind === "summary" ? "AI 短摘要" : a.kind === "translation" ? "选段翻译" : "选段分析"}</span>
      <small>{a.provider} · {a.model} · {new Date(a.createdAt).toLocaleString("zh-CN")}<br />
        输入来源：{a.sourceScope === "page_image" ? "当前页图像" : a.sourceScope === "selection_image" ? "选区图像" : a.sourceScope === "selection_context" ? "选段与论文背景" : a.sourceScope === "selection" ? "选段"
          : a.sourceScope === "abstract" ? "摘要" : a.sourceScope === "full_text" ? "全文文本" : "部分已解析文本"}
        {a.sourcePageIndices.length ? ` · 物理页 ${a.sourcePageIndices.map((p) => p + 1).join("、")}` : ""}</small>
      <Markdown body={a.body} onNavigate={(href) => void c.navigateLink(href)} />
      <div className={styles.actions}>
        <button className={styles.textButton} disabled={c.aiBusy} onClick={() => c.showAIResult(a)}>查看回复</button>
        <button className={styles.textButton} onClick={() => c.setDialog({ kind: "insert",
          text: `\n> ${a.body.replace(/\n/g, "\n> ")}\n> — [AI 来源：${a.model}](kb://ai/${a.id})\n\n` })}>引用到笔记</button>
        {a.sourceAttachmentId && a.sourcePageIndices.length > 0 && <button className={styles.textButton}
          onClick={() => c.setTarget({ attachmentId: a.sourceAttachmentId!, pageIndex: a.sourcePageIndices[0] })}>查看来源页</button>}
      </div>
    </article>)}
    <p className={styles.subtle}>AI 内容独立保存，仅在你主动引用时进入个人笔记。</p>
  </details>;
}
