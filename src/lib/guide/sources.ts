import { readFile } from "node:fs/promises";
import { getStore, StoreError } from "../db";
import { joinEvidenceTextRuns } from "./anchors";
import type { GuideSource } from "./types";

export interface SourceBlock {
  id: string;
  text: string;
  paperId: string;
  attachmentId: string;
  pageIndex: number;
}
export interface SourceDocument {
  source: GuideSource;
  pages: string[];
  pageLabels: string[];
  blocks: SourceBlock[];
}
export async function readGuideSources(
  attachmentIds: string[],
  signal?: AbortSignal,
): Promise<SourceDocument[]> {
  const store = getStore(),
    state = store.snapshot();
  const documents: SourceDocument[] = [];
  let total = 0;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  for (const attachmentId of attachmentIds) {
    signal?.throwIfAborted();
    const attachment = state.attachments.find((a) => a.id === attachmentId);
    if (!attachment) throw new StoreError("导读附件不存在", 404);
    const paper = state.papers.find((p) => p.id === attachment.paperId)!;
    const task = pdfjs.getDocument({
      data: new Uint8Array(await readFile(store.attachmentPath(attachmentId))),
      disableFontFace: true,
      useSystemFonts: true,
    });
    try {
      const document = await task.promise;
      if (document.numPages > 1000)
        throw new StoreError("单附件超过 1000 页，请拆分后导读", 413);
      const labels = await document.getPageLabels().catch(() => null),
        pages: string[] = [],
        blocks: SourceBlock[] = [],
        parsedPages: number[] = [],
        emptyPages: number[] = [];
      for (let i = 0; i < document.numPages; i++) {
        signal?.throwIfAborted();
        let text = "";
        try {
          const page = await document.getPage(i + 1);
          const content = await page.getTextContent();
          text = joinEvidenceTextRuns(
            content.items.flatMap((item) =>
              "str" in item ? [{ text: item.str, hasEOL: item.hasEOL }] : [],
            ),
          );
          page.cleanup();
        } catch {
          text = "";
        }
        pages.push(text);
        if (!text.trim()) {
          emptyPages.push(i);
          continue;
        }
        parsedPages.push(i);
        total += text.length;
        if (total > 2_000_000)
          throw new StoreError(
            "所选 PDF 文本合计超过 200 万字符，请减少附件后分次分析；没有将部分内容当作全文。",
            413,
          );
        let start = 0,
          index = 0;
        while (start < text.length) {
          let end = Math.min(start + 1600, text.length);
          if (end < text.length) {
            const boundary = text.lastIndexOf(" ", end);
            if (boundary > start + 1000) end = boundary;
          }
          blocks.push({
            id: `${attachmentId}:${i}:${index++}`,
            text: text.slice(start, end),
            paperId: paper.id,
            attachmentId,
            pageIndex: i,
          });
          start = end;
        }
      }
      const source: GuideSource = {
        paperId: paper.id,
        paperTitle: paper.title,
        attachmentId,
        attachmentSha256: attachment.sha256,
        filename: attachment.filename,
        pageCount: document.numPages,
        parsedPages,
        emptyPages,
        characterCount: pages.reduce((n, p) => n + p.length, 0),
      };
      documents.push({ source, pages, blocks, pageLabels: labels || [] });
    } finally {
      await task.destroy();
    }
  }
  return documents;
}
export function splitGuideChunks(
  documents: SourceDocument[],
  limit = 16000,
): SourceBlock[][] {
  const chunks: SourceBlock[][] = [];
  let group: SourceBlock[] = [],
    chars = 0;
  for (const document of documents) {
    for (const block of document.blocks) {
      if (group.length && chars + block.text.length > limit) {
        chunks.push(group);
        group = [];
        chars = 0;
      }
      group.push(block);
      chars += block.text.length;
    }
  }
  if (group.length) chunks.push(group);
  return chunks;
}
