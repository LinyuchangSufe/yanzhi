"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { BibEntry, Bibliography } from "../../lib/pdf-reference/bibliography";
import type { ResolvedPdfDestination } from "../../lib/pdf-reference/destinations";
import { PAPER_REFERENCE_EVENT, parseReferenceRequest, referenceRouting, type PaperReferenceRequest } from "../../lib/pdf-reference/events";
import { locatePdfReference, scanBibliography, type ReferenceCandidate, type ReferenceLocator, type ReferencePageCache } from "../../lib/pdf-reference/resolver";

export interface CitationPreview {
  attachmentId: string;
  entry: BibEntry;
}

interface PreviewScope {
  document: PDFDocumentProxy;
  paperId: string;
  attachmentId: string;
  generation: number;
}

export interface ReferenceCandidatesPreview extends PreviewScope {
  request: ReferenceLocator;
  candidates: ReferenceCandidate[];
  reason?: string;
}

/** Own the original PDF only: text is cached in memory and discarded on switch. */
export function usePaperReferences({
  document, paperId, attachmentId, attachments, enabled, readerRef, onNavigate, onMessage, onAttachmentReference,
}: {
  document: PDFDocumentProxy | null;
  paperId: string;
  attachmentId: string;
  attachments: readonly { id: string; paperId: string; status: string }[];
  enabled: boolean;
  readerRef: RefObject<HTMLElement | null>;
  onNavigate: (destination: ResolvedPdfDestination) => void;
  onMessage: (message: string) => void;
  onAttachmentReference: (request: PaperReferenceRequest) => void;
}) {
  const [index, setIndex] = useState<{ document: PDFDocumentProxy; bibliography: Bibliography } | null>(null);
  const [preview, setPreview] = useState<(CitationPreview & PreviewScope) | null>(null);
  const [candidatesPreview, setCandidatesPreview] = useState<ReferenceCandidatesPreview | null>(null);
  const [lookup, setLookup] = useState<PreviewScope | null>(null);
  const callbacks = useRef({ onNavigate, onMessage, enabled, onAttachmentReference, attachments });
  callbacks.current = { onNavigate, onMessage, enabled, onAttachmentReference, attachments };
  const scope = useRef({ document, paperId, attachmentId, enabled });
  scope.current = { document, paperId, attachmentId, enabled };
  const generation = useRef(0);
  const cache = useRef<ReferencePageCache>(new Map());

  function matchesScope(value: PreviewScope) {
    const active = scope.current;
    return active.enabled && active.document === value.document && active.paperId === value.paperId &&
      active.attachmentId === value.attachmentId && generation.current === value.generation;
  }

  function closePreview() {
    generation.current++;
    setPreview(null);
    setCandidatesPreview(null);
    setLookup(null);
    callbacks.current.onMessage("");
  }

  useEffect(() => {
    let cancelled = false;
    const pages: ReferencePageCache = new Map();
    cache.current = pages;
    setIndex(null);
    if (!document) return;
    const timer = setTimeout(() => {
      void scanBibliography(document, pages, () => cancelled).then((bibliography) => {
        if (!cancelled && bibliography) setIndex({ document, bibliography });
      }).catch(() => { /* Recognition stays off for PDFs without readable references. */ });
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); pages.clear(); };
  }, [document]);

  useEffect(() => {
    generation.current++;
    setPreview(null);
    setCandidatesPreview(null);
    setLookup(null);
  }, [document, paperId, attachmentId, enabled]);

  useEffect(() => {
    const view = readerRef.current?.ownerDocument.defaultView;
    if (!view) return;
    let disposed = false;
    const onReference = (event: Event) => {
      const active = scope.current;
      if (active.document !== document || active.paperId !== paperId || active.attachmentId !== attachmentId) return;
      const request = parseReferenceRequest((event as CustomEvent<unknown>).detail);
      if (!request) return;
      const routing = referenceRouting(request, { paperId, attachmentId }, callbacks.current.attachments);
      if (routing === "ignore") return;
      const current = ++generation.current;
      setPreview(null);
      setCandidatesPreview(null);
      setLookup(null);
      if (!callbacks.current.enabled) { callbacks.current.onMessage("请先结束区域框选，再定位原文。"); return; }
      if (routing === "missing") { callbacks.current.onMessage("该引用的来源 PDF 附件不可用，请先恢复对应附件。阅读位置已保留。"); return; }
      if (routing === "switch") { callbacks.current.onAttachmentReference(request); return; }
      if (!document) { callbacks.current.onMessage("PDF 尚未准备好，请加载后重试。"); return; }
      const requestScope = { document, paperId, attachmentId, generation: current };
      const cancelled = () => disposed || !matchesScope(requestScope);
      setLookup(requestScope);
      callbacks.current.onMessage("正在定位原文…");
      void locatePdfReference(document, request, cache.current, cancelled)
        .then((result) => {
          if (cancelled()) return;
          setLookup(null);
          if (result.target) {
            callbacks.current.onMessage("");
            callbacks.current.onNavigate(result.target);
          } else if (result.candidates?.length) {
            setCandidatesPreview({ ...requestScope, request, candidates: result.candidates, reason: result.reason });
            callbacks.current.onMessage("");
          } else callbacks.current.onMessage(result.reason ?? "定位已取消，阅读位置已保留。");
        }).catch(() => {
          if (!cancelled()) {
            setLookup(null);
            callbacks.current.onMessage("无法读取此 PDF 的定位信息，阅读位置已保留。");
          }
        });
    };
    view.addEventListener(PAPER_REFERENCE_EVENT, onReference);
    return () => { disposed = true; generation.current++; view.removeEventListener(PAPER_REFERENCE_EVENT, onReference); };
    // The scope and callbacks refs also invalidate results before effect cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, paperId, attachmentId, readerRef]);

  const visiblePreview = preview && matchesScope(preview) ? preview : null;
  const visibleCandidates = candidatesPreview && matchesScope(candidatesPreview) ? candidatesPreview : null;
  const isLocating = !!lookup && matchesScope(lookup);
  useEffect(() => {
    if (!visiblePreview && !visibleCandidates && !isLocating) return;
    const view = readerRef.current?.ownerDocument.defaultView;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePreview();
      }
    };
    view?.addEventListener("keydown", onKeyDown);
    return () => view?.removeEventListener("keydown", onKeyDown);
    // Close even when focus remains on the reference button in the chat panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePreview, visibleCandidates, isLocating, readerRef]);

  return {
    bibliography: index?.document === document ? index.bibliography : null,
    preview: visiblePreview,
    candidatesPreview: visibleCandidates,
    isLocating,
    showCitation: (entry: BibEntry) => {
      const active = scope.current;
      if (!active.enabled || !document || active.document !== document || active.paperId !== paperId || active.attachmentId !== attachmentId) return;
      const current = ++generation.current;
      setLookup(null);
      setCandidatesPreview(null);
      setPreview({ attachmentId, paperId, document, generation: current, entry });
      callbacks.current.onMessage("");
    },
    closePreview,
    jumpToCitation: () => {
      if (!preview || !matchesScope(preview)) return;
      const target = { pageNumber: preview.entry.pageNumber, kind: "XYZ", left: preview.entry.x, top: preview.entry.y + 10, zoom: null };
      closePreview();
      callbacks.current.onNavigate(target);
    },
    jumpToCandidate: (candidate: ReferenceCandidate) => {
      if (!candidatesPreview || !matchesScope(candidatesPreview) || !candidatesPreview.candidates.includes(candidate)) return;
      closePreview();
      callbacks.current.onNavigate(candidate.target);
    },
  };
}
