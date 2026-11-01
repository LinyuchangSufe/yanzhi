import type { AIContent, Paper } from "./types";
import type { PdfSelection } from "../components/pdf/types";

export type PaperAIKind = "summary" | "translation" | "explanation" | "markdown";
export interface PaperAITask {
  id: number;
  paperId: string;
  paperTitle: string;
  kind: PaperAIKind;
  selection?: PdfSelection;
  status: "running" | "done" | "cancelled" | "error";
  resultId?: string;
  error?: string;
}
export interface PaperAIInput {
  paperId: string;
  kind: PaperAIKind;
  selection?: string;
  attachmentId?: string;
  pageIndex?: number;
  rects?: PdfSelection["rects"];
  force?: boolean;
}
interface Options {
  run: (input: PaperAIInput, signal: AbortSignal) => Promise<AIContent>;
  onTask: (task: PaperAITask | null) => void;
  onResult: (result: AIContent) => void;
}

/** A cancelled or older response can never replace a newer visible request. */
export class PaperAIRequest {
  private sequence = 0;
  private active: { id: number; controller: AbortController } | null = null;
  private task: PaperAITask | null = null;
  constructor(private options: Options) {}
  private publish(task: PaperAITask | null) {
    this.task = task;
    this.options.onTask(task);
  }
  async start(paper: Paper, kind: PaperAIKind, selection?: PdfSelection, force = false): Promise<boolean> {
    if (this.active) return false;
    const id = ++this.sequence;
    const selected = selection ? structuredClone(selection) : undefined;
    const task: PaperAITask = { id, paperId: paper.id, paperTitle: paper.title, kind,
      ...(selected ? { selection: selected } : {}), status: "running" };
    const invalidSelection = kind === "markdown"
      ? !selected || selected.paperId !== paper.id ||
        !selected.attachmentId || !Number.isInteger(selected.pageIndex) || selected.pageIndex < 0 ||
        (selected.extractionScope !== "page" && selected.rects.length === 0)
      : kind !== "summary" && (!selected?.selectedText.trim() || selected.paperId !== paper.id);
    if (paper.deletedAt || invalidSelection) {
      this.publish({ ...task, status: "error", error: paper.deletedAt
        ? "请先恢复这篇文献，再生成 AI 内容。" : "请重新选择这篇文献中的文字。" });
      return true;
    }
    const controller = new AbortController();
    this.active = { id, controller };
    this.publish(task);
    try {
      const result = await this.options.run({ paperId: paper.id, kind, ...(force ? { force: true } : {}),
        ...(selected ? { ...(selected.selectedText.trim() ? { selection: selected.selectedText } : {}),
          attachmentId: selected.attachmentId, pageIndex: selected.pageIndex,
          ...(kind === "markdown" && selected.extractionScope !== "page" ? { rects: selected.rects } : {}) } : {}) }, controller.signal);
      if (this.active?.id !== id || controller.signal.aborted) return true;
      if (result.paperId !== task.paperId || result.kind !== task.kind)
        throw new Error("AI 回复与本次文献或任务不一致，请重试。原有内容保留。");
      this.active = null;
      this.publish({ ...task, status: "done", resultId: result.id });
      this.options.onResult(result);
    } catch (error) {
      if (this.active?.id !== id) return true;
      this.active = null;
      this.publish({ ...task, status: controller.signal.aborted ? "cancelled" : "error",
        ...(controller.signal.aborted ? {} : { error: error instanceof Error ? error.message : "AI 请求失败，请重试。" }) });
    }
    return true;
  }
  cancel() {
    if (!this.active || !this.task) return;
    const current = this.active;
    this.active = null;
    ++this.sequence;
    current.controller.abort();
    this.publish({ ...this.task, status: "cancelled" });
  }
  showSaved(paper: Paper, result: AIContent): boolean {
    if (this.active || result.paperId !== paper.id ||
      !["summary", "translation", "explanation", "markdown"].includes(result.kind)) return false;
    this.publish({ id: ++this.sequence, paperId: paper.id, paperTitle: paper.title,
      kind: result.kind as PaperAIKind, status: "done", resultId: result.id });
    this.options.onResult(result);
    return true;
  }
  dismiss() {
    if (!this.active) this.publish(null);
  }
  dispose() {
    this.active?.controller.abort();
    this.active = null;
  }
}
