"use client";

import { useEffect, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { PageSize } from "./continuous";

export interface PdfPageDescriptor extends PageSize {
  page: PDFPageProxy;
}
export interface OutlineEntry {
  title: string;
  dest: string | unknown[] | null;
  depth: number;
}
interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: OutlineNode[];
}
interface LoadedDocument {
  attachmentId: string;
  document: PDFDocumentProxy;
  pages: PdfPageDescriptor[];
}

function flattenOutline(nodes: OutlineNode[], depth = 0): OutlineEntry[] {
  return nodes.flatMap((node) => [
    ...(node.dest ? [{ title: node.title, dest: node.dest, depth }] : []),
    ...flattenOutline(node.items ?? [], depth + 1),
  ]);
}

export function pdfError(error: unknown): string {
  if (error instanceof Error && error.name === "PasswordException")
    return "PDF 需要密码，当前版本暂不支持加密附件。可以添加可阅读的新附件，原有批注会保留。";
  return error instanceof Error
    ? error.message
    : "无法读取此 PDF，请检查附件文件。";
}

export function usePdfDocument(attachmentId: string, available: boolean) {
  const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let destroy: (() => Promise<void>) | undefined;
    setLoaded(null);
    setLabels([]);
    setOutline([]);
    setError("");
    if (!attachmentId || !available) {
      setStatus("");
      return;
    }
    setStatus("正在读取 PDF…");
    void (async () => {
      const pdfjs = await import("pdfjs-dist");
      if (cancelled) return;
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf/pdf.worker.mjs";
      const options = {
        url: `/api/kb/attachment?id=${encodeURIComponent(attachmentId)}`,
        cMapUrl: "/pdf/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdf/standard_fonts/",
        wasmUrl: "/pdf/wasm/",
        useSystemFonts: true,
        isEvalSupported: false,
      };
      const task = pdfjs.getDocument(options);
      destroy = () => task.destroy();
      const document = await task.promise;
      if (cancelled) return;
      // getPage reads page boxes only. It does not render or allocate canvases.
      // Four bounded workers avoid issuing unbounded page requests for long PDFs.
      const pages: PdfPageDescriptor[] = new Array(document.numPages);
      let next = 0;
      let complete = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, document.numPages) }, async () => {
          while (!cancelled && next < document.numPages) {
            const index = next++;
            const page = await document.getPage(index + 1);
            const box = page.view;
            pages[index] = {
              page,
              width: (box[2] - box[0]) * page.userUnit,
              height: (box[3] - box[1]) * page.userUnit,
              rotation: page.rotate,
            };
            complete++;
            if (!cancelled)
              setStatus(`正在准备页面尺寸 ${complete}/${document.numPages}…`);
          }
        }),
      );
      if (cancelled) return;
      setLoaded({ attachmentId, document, pages });
      setStatus("");
      void document
        .getPageLabels()
        .then((value) => {
          if (!cancelled) setLabels(value ?? []);
        })
        .catch(() => {});
      void document
        .getOutline()
        .then((value) => {
          if (!cancelled) setOutline(flattenOutline(value ?? []));
        })
        .catch(() => {});
    })().catch((reason: unknown) => {
      if (!cancelled) {
        setError(pdfError(reason));
        setStatus("");
      }
    });
    return () => {
      cancelled = true;
      void destroy?.().catch(() => {});
    };
  }, [attachmentId, available]);
  return {
    loaded: loaded?.attachmentId === attachmentId ? loaded : null,
    labels,
    outline,
    status,
    error,
  };
}
