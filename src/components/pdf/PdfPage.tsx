"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import type { RenderTask, TextLayer } from "pdfjs-dist";
import type { Annotation, AnnotationRect, AnnotationTextSegment } from "../../lib/types";
import type { GuideEvidence } from "../../lib/guide/types";
import { findUniqueQuote } from "../../lib/guide/anchors";
import type { PdfLocation, PdfSelection } from "./types";
import type { PdfDraft } from "./annotation-draft";
import { draftTextSegments, sameTextSegment, shouldAppendPdfSelection } from "./annotation-draft";
import { annotationTextSegments } from "../../lib/annotation-segments";
import { mergeHighlightRects } from "./highlight-geometry";
import type { PdfPageDescriptor } from "./usePdfDocument";
import type { PageLayout } from "./continuous";
import {
  clipPixelRect,
  normalizedToViewportRect,
  viewportToNormalizedRect,
  type PixelRect,
} from "./geometry";
import { pdfError } from "./usePdfDocument";
import { findCitations } from "../../lib/pdf-reference/citations";
import { matchCitation, type BibEntry, type Bibliography } from "../../lib/pdf-reference/bibliography";
import styles from "./PdfReader.module.css";

export type { PdfDraft } from "./annotation-draft";
interface Props {
  paperId: string;
  attachmentId: string;
  descriptor: PdfPageDescriptor;
  layout: PageLayout;
  pageLabel: string;
  rotation: number;
  scrollRoot: RefObject<HTMLDivElement | null>;
  priority: boolean;
  mode: "select" | "region";
  annotations: Annotation[];
  activeId: string;
  draft: PdfDraft | null;
  targetRects?: AnnotationRect[];
  onDraft: (draft: PdfDraft, append?: boolean) => boolean;
  onSelectAnnotation: (id: string) => void;
  onMessage: (message: string) => void;
  guideMarks: GuideEvidence[];
  activeGuideMarkId: string;
  guideTarget?: PdfLocation;
  onSelectGuideMark?: (id: string) => void;
  bibliography?: Bibliography | null;
  onCitation?: (entry: BibEntry) => void;
}

interface TextRun {
  node: Text;
  start: number;
  end: number;
}

interface NativeTextSelection {
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
  segment: AnnotationTextSegment;
}

/** Preserve real PDF.js line breaks so dehyphenation stays deterministic. */
function textLayerIndex(container: HTMLElement) {
  const runs: TextRun[] = [];
  let text = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? "";
      runs.push({
        node: node as Text,
        start: text.length,
        end: text.length + value.length,
      });
      text += value;
    } else if (node instanceof HTMLBRElement) text += "\n";
    else for (const child of node.childNodes) walk(child);
  };
  walk(container);
  return { text, runs };
}

function quoteRects(
  index: ReturnType<typeof textLayerIndex>,
  quote: string,
  surface: HTMLElement,
): { rects: PixelRect[]; status: string } {
  const match = findUniqueQuote(index.text, quote);
  if (match.status !== "matched") return { rects: [], status: match.status };
  const first = index.runs.find((run) => run.end > match.start);
  const last = [...index.runs].reverse().find((run) => run.start < match.end);
  if (!first || !last) return { rects: [], status: "missing" };
  const range = document.createRange();
  range.setStart(first.node, match.start - first.start);
  range.setEnd(last.node, match.end - last.start);
  const box = surface.getBoundingClientRect();
  const seen = new Set<string>();
  const rects = Array.from(range.getClientRects()).flatMap((rect) => {
    const clipped = clipPixelRect(
      {
        x: rect.left - box.left,
        y: rect.top - box.top,
        width: rect.width,
        height: rect.height,
      },
      box.width,
      box.height,
    );
    if (!clipped || clipped.width < 0.5 || clipped.height < 0.5) return [];
    const key = [clipped.x, clipped.y, clipped.width, clipped.height]
      .map((value) => Math.round(value * 10))
      .join(":");
    if (seen.has(key)) return [];
    seen.add(key);
    return [clipped];
  });
  // An unexpectedly broad DOM range is not safe to turn into an exact mark.
  return rects.length > 0 && rects.length <= 160
    ? { rects, status: "matched" }
    : { rects: [], status: "missing" };
}

function moveBox(element: HTMLElement | null, rect: PixelRect) {
  if (!element) return;
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

function selectedPage(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>("[data-pdf-page-index]") ?? null;
}

/** One exact-size placeholder; canvases and text layers exist only near the viewport. */
export function PdfPage({
  paperId,
  attachmentId,
  descriptor,
  layout,
  pageLabel,
  rotation,
  scrollRoot,
  priority,
  mode,
  annotations,
  activeId,
  draft,
  targetRects,
  onDraft,
  onSelectAnnotation,
  onMessage,
  guideMarks,
  activeGuideMarkId,
  guideTarget,
  onSelectGuideMark,
  bibliography,
  onCitation,
}: Props) {
  const { page } = descriptor;
  const pageIndex = layout.pageIndex;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const renderChain = useRef<Promise<void>>(Promise.resolve());
  const regionStart = useRef<{ x: number; y: number } | null>(null);
  const appendSelection = useRef(false);
  const citationHover = useRef<{ timer: ReturnType<typeof setTimeout>; entry: BibEntry } | null>(null);
  const citationPointer = useRef<{ x: number; y: number } | null>(null);
  const [citations, setCitations] = useState<{ entry: BibEntry; rects: PixelRect[] }[]>([]);
  const [nativeSelection, setNativeSelection] = useState<NativeTextSelection | null>(null);
  const [near, setNear] = useState(false);
  const [ready, setReady] = useState(false);
  const [renderError, setRenderError] = useState("");
  const [retry, setRetry] = useState(0);
  const [region, setRegion] = useState<PixelRect | null>(null);
  const [resolvedMarks, setResolvedMarks] = useState<
    {
      evidence: GuideEvidence;
      rects: PixelRect[];
      status: string;
    }[]
  >([]);
  const locatedGuideTarget = useRef<PdfLocation | null>(null);
  const thisDraft =
    draft?.attachmentId === attachmentId && draft.pageIndex === pageIndex
      ? draft
      : null;
  const active = near || priority || !!thisDraft;
  const viewport = useMemo(
    () =>
      page.getViewport({
        scale: layout.scale,
        rotation: (page.rotate + rotation + 360) % 360,
      }),
    [page, layout.scale, rotation],
  );

  useEffect(() => {
    const selectionChanged = () => {
      const selected = window.getSelection();
      setNativeSelection((current) => current && selected && !selected.isCollapsed &&
        selected.anchorNode === current.anchorNode && selected.anchorOffset === current.anchorOffset &&
        selected.focusNode === current.focusNode && selected.focusOffset === current.focusOffset
        ? current : null);
    };
    document.addEventListener("selectionchange", selectionChanged);
    return () => document.removeEventListener("selectionchange", selectionChanged);
  }, []);

  useEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setNear(entry.isIntersecting);
      },
      { root: scrollRoot.current, rootMargin: "650px 0px", threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    let cancelled = false;
    let canvasTask: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    setReady(false);
    setRenderError("");
    if (!active) {
      if (canvasRef.current) {
        canvasRef.current.width = 0;
        canvasRef.current.height = 0;
      }
      textRef.current?.replaceChildren();
      return;
    }
    const previous = renderChain.current;
    renderChain.current = (async () => {
      await previous.catch(() => {});
      const pdfjs = await import("pdfjs-dist");
      if (
        cancelled ||
        !canvasRef.current ||
        !textRef.current ||
        !surfaceRef.current
      )
        return;
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器无法创建 PDF 页面画布。");
      // At most six million pixels/page and DPR<=2, even at large CSS zoom.
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(6_000_000 / (viewport.width * viewport.height)),
      );
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      surfaceRef.current.style.setProperty(
        "--total-scale-factor",
        String(viewport.scale * page.userUnit),
      );
      textRef.current.replaceChildren();
      textLayer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textRef.current,
        viewport,
      });
      canvasTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
      });
      await Promise.all([canvasTask.promise, textLayer.render()]);
      if (!cancelled) setReady(true);
    })().catch((error: unknown) => {
      if (!cancelled) setRenderError(pdfError(error));
    });
    return () => {
      cancelled = true;
      canvasTask?.cancel();
      textLayer?.cancel();
      // A cancelled render settles before a subsequent effect reuses its canvas.
      // Discard far-page buffers; the fixed page box remains in the scroll flow.
      if (canvasRef.current) {
        canvasRef.current.width = 0;
        canvasRef.current.height = 0;
      }
      textRef.current?.replaceChildren();
    };
  }, [active, page, viewport, retry]);

  useEffect(() => {
    if (!ready || !textRef.current || !surfaceRef.current) {
      setResolvedMarks([]);
      return;
    }
    const index = textLayerIndex(textRef.current);
    const surface = surfaceRef.current;
    setResolvedMarks(
      guideMarks.map((evidence) => {
        const result = quoteRects(index, evidence.quote, surface);
        return {
          evidence,
          ...result,
          rects: mergeHighlightRects(result.rects, {
            rotation: viewport.rotation,
            bounds: { width: viewport.width, height: viewport.height },
          }),
        };
      }),
    );
  }, [ready, guideMarks, viewport]);

  useEffect(() => {
    setCitations([]);
    if (citationHover.current) clearTimeout(citationHover.current.timer);
    citationHover.current = null;
    if (!ready || !bibliography || !textRef.current || !surfaceRef.current) return;
    const index = textLayerIndex(textRef.current);
    const surface = surfaceRef.current.getBoundingClientRect();
    setCitations(findCitations(index.text).flatMap((citation) => {
      const entry = matchCitation(bibliography, citation.key);
      const first = index.runs.find((run) => run.end > citation.start);
      const last = [...index.runs].reverse().find((run) => run.start < citation.end);
      if (!entry || !first || !last) return [];
      const range = first.node.ownerDocument.createRange();
      range.setStart(first.node, citation.start - first.start);
      range.setEnd(last.node, citation.end - last.start);
      const rects = mergeHighlightRects(Array.from(range.getClientRects()).flatMap((rect) => {
        const clipped = clipPixelRect({ x: rect.left - surface.left, y: rect.top - surface.top, width: rect.width, height: rect.height }, surface.width, surface.height);
        return clipped && clipped.width > 0.5 && clipped.height > 0.5 ? [clipped] : [];
      }), { rotation: viewport.rotation, bounds: { width: viewport.width, height: viewport.height } });
      return rects.length ? [{ entry, rects }] : [];
    }));
    return () => {
      if (citationHover.current) clearTimeout(citationHover.current.timer);
      citationHover.current = null;
    };
  }, [ready, bibliography, viewport]);

  function citationAt(clientX: number, clientY: number) {
    const box = surfaceRef.current?.getBoundingClientRect();
    if (!box) return null;
    const x = clientX - box.left;
    const y = clientY - box.top;
    return citations.find((citation) => citation.rects.some((rect) =>
      x >= rect.x - 2 && x <= rect.x + rect.width + 2 && y >= rect.y && y <= rect.y + rect.height))?.entry ?? null;
  }
  function clearCitationHover() {
    if (citationHover.current) clearTimeout(citationHover.current.timer);
    citationHover.current = null;
  }

  useEffect(() => {
    if (
      !guideTarget?.guideMarkId ||
      !ready ||
      locatedGuideTarget.current === guideTarget
    )
      return;
    const mark = resolvedMarks.find(
      (item) => item.evidence.id === guideTarget.guideMarkId,
    );
    if (!mark) return;
    // Consume an explicit navigation request once; ordinary scrolling or a
    // saved-position refresh must not pull the reader back to this quotation.
    locatedGuideTarget.current = guideTarget;
    if (!mark.rects.length) {
      onMessage(
        "已到达证据所在页，但原句无法唯一定位；请核对导读中的原文摘录。此处未绘制 AI 标记。",
      );
      return;
    }
    const stage = scrollRoot.current;
    const surface = surfaceRef.current;
    if (!stage || !surface) return;
    const rect = mark.rects[0];
    const pageBox = surface.getBoundingClientRect();
    const stageBox = stage.getBoundingClientRect();
    stage.scrollTo({
      top: Math.max(
        0,
        stage.scrollTop +
          pageBox.top -
          stageBox.top +
          rect.y -
          stage.clientHeight * 0.3,
      ),
      left: Math.max(
        0,
        stage.scrollLeft +
          pageBox.left -
          stageBox.left +
          rect.x -
          stage.clientWidth * 0.15,
      ),
      behavior: "auto",
    });
  }, [guideTarget, ready, resolvedMarks, scrollRoot, onMessage]);

  function selection(
    rects: AnnotationRect[],
    selectedText: string,
  ): PdfSelection {
    return { paperId, attachmentId, pageIndex, pageLabel, rects, selectedText };
  }

  function captureSelection(modifiers: { metaKey: boolean; ctrlKey: boolean }) {
    const append = appendSelection.current || shouldAppendPdfSelection(modifiers, navigator.platform);
    appendSelection.current = false;
    if (mode !== "select" || !ready || !surfaceRef.current) return;
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !selected.rangeCount) return;
    const startPage = selectedPage(selected.anchorNode);
    const endPage = selectedPage(selected.focusNode);
    if (startPage && endPage && startPage !== endPage) {
      onMessage("首版批注限于单个物理页；跨页选区请分成多个批注保存。");
      return;
    }
    const range = selected.getRangeAt(0);
    if (!textRef.current?.contains(range.commonAncestorContainer)) return;
    const selectedText = selected
      .toString()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 24000);
    if (!selectedText) return;
    const box = surfaceRef.current.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).flatMap((rect) => {
      const clipped = clipPixelRect(
        {
          x: rect.left - box.left,
          y: rect.top - box.top,
          width: rect.width,
          height: rect.height,
        },
        box.width,
        box.height,
      );
      return clipped && clipped.width > 0.5 && clipped.height > 0.5
        ? [viewportToNormalizedRect(clipped, viewport, page.view)]
        : [];
    });
    if (rects.length > 500) {
      onMessage("选区过长，请缩短到单页中的较少段落后保存。");
      return;
    }
    if (rects.length) {
      const accepted = onDraft({ ...selection(rects, selectedText), kind: "highlight" }, append);
      // Keep the browser selection for Cmd/Ctrl+C and text selection handles.
      // Only its matching draft paint is omitted; earlier Cmd excerpts remain.
      setNativeSelection(accepted ? {
        anchorNode: selected.anchorNode,
        anchorOffset: selected.anchorOffset,
        focusNode: selected.focusNode,
        focusOffset: selected.focusOffset,
        segment: { rects, selectedText },
      } : null);
    }
  }

  function point(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(box.width, event.clientX - box.left)),
      y: Math.max(0, Math.min(box.height, event.clientY - box.top)),
    };
  }
  function beginRegion(event: PointerEvent<HTMLDivElement>) {
    if (mode !== "region" || !ready || event.button !== 0) return;
    if (draft) {
      onMessage("请先保存或取消当前批注，再创建区域批注。");
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    regionStart.current = point(event);
    setRegion({ ...regionStart.current, width: 0, height: 0 });
  }
  function rectangle(event: PointerEvent<HTMLDivElement>): PixelRect | null {
    const start = regionStart.current;
    if (!start) return null;
    const end = point(event);
    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(start.x - end.x),
      height: Math.abs(start.y - end.y),
    };
  }
  function finishRegion(event: PointerEvent<HTMLDivElement>) {
    const rect = rectangle(event);
    regionStart.current = null;
    setRegion(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (rect && rect.width >= 5 && rect.height >= 5)
      onDraft({
        ...selection([viewportToNormalizedRect(rect, viewport, page.view)], ""),
        kind: "region",
      });
  }

  function project(rects: AnnotationRect[], highlight = true) {
    const pixels = rects.map((rect) =>
      normalizedToViewportRect(rect, viewport, page.view),
    );
    return highlight
      ? mergeHighlightRects(pixels, {
          rotation: viewport.rotation,
          bounds: { width: viewport.width, height: viewport.height },
        })
      : pixels;
  }
  const personalMarks = annotations.map((annotation) => ({
    annotation,
    rects:
      annotation.kind === "region"
        ? project(annotation.rects, false)
        : annotationTextSegments(annotation).flatMap((segment) =>
            project(segment.rects),
          ),
  }));
  const draftRects = thisDraft
    ? thisDraft.kind === "region"
      ? project(thisDraft.rects, false)
      : draftTextSegments(thisDraft).flatMap((segment) =>
          nativeSelection && sameTextSegment(nativeSelection.segment, segment)
            ? [] : project(segment.rects),
        )
    : [];
  const locationRects = targetRects ? project(targetRects) : [];
  const ink = new Map<
    string,
    { fill: string; className: string; rects: PixelRect[] }
  >();
  const paint = (
    key: string,
    fill: string,
    className: string,
    rects: PixelRect[],
  ) => {
    const existing = ink.get(key);
    if (existing) existing.rects.push(...rects);
    else ink.set(key, { fill, className, rects: [...rects] });
  };
  for (const { annotation, rects } of personalMarks) {
    if (annotation.kind !== "highlight") continue;
    const color = /^#[0-9a-f]{6}$/i.test(annotation.color)
      ? annotation.color
      : "#f5cf58";
    paint(`personal:${color}`, color, styles.personalInk, rects);
  }
  for (const { evidence, rects } of resolvedMarks) {
    const green = ["assumption", "limitation"].includes(evidence.category);
    paint(
      `guide:${green}`,
      green ? "#7fab8e" : "#d5b34f",
      styles.guideInk,
      rects,
    );
  }
  if (thisDraft?.kind === "highlight")
    paint("draft", "#e4bf48", styles.draftInk, draftRects);
  if (locationRects.length)
    paint("target", "#77a8e4", styles.targetInk, locationRects);

  function marks(
    rects: PixelRect[],
    key: string,
    className: string,
    label: string,
    id?: string,
    color?: string,
  ) {
    return rects.map((rect, index) => (
      <button
        key={`${key}-${index}`}
        type="button"
        className={className}
        aria-label={label}
        title={label}
        data-annotation-id={id}
        data-target-rect={key === "target" || undefined}
        ref={(element) => {
          moveBox(element, rect);
          if (element && color)
            element.style.setProperty(
              "--mark-color",
              /^#[0-9a-f]{6}$/i.test(color) ? color : "#f5cf58",
            );
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (id) onSelectAnnotation(id);
        }}
      />
    ));
  }

  return (
    <div
      className={`${styles.page} ${mode === "region" ? styles.regionMode : ""}`}
      data-pdf-page-index={pageIndex}
      data-pdf-attachment-id={attachmentId}
      data-pdf-rendered={ready}
      ref={(element) => {
        surfaceRef.current = element;
        if (element) {
          element.style.width = `${layout.width}px`;
          element.style.height = `${layout.height}px`;
        }
      }}
      aria-label={`PDF 物理第 ${pageIndex + 1} 页，页标签 ${pageLabel}`}
      aria-busy={active && !ready && !renderError}
      onMouseUp={captureSelection}
      onKeyUp={(event) => {
        if (event.key === "Shift") captureSelection(event);
      }}
      onPointerDown={(event) => {
        clearCitationHover();
        citationPointer.current = { x: event.clientX, y: event.clientY };
        appendSelection.current = shouldAppendPdfSelection(event, navigator.platform);
        beginRegion(event);
      }}
      onPointerMove={(event) => {
        const rect = rectangle(event);
        if (rect) setRegion(rect);
        if (mode !== "select" || event.buttons || event.pointerType !== "mouse" || window.getSelection()?.toString()) { clearCitationHover(); return; }
        const entry = citationAt(event.clientX, event.clientY);
        if (entry === citationHover.current?.entry) return;
        clearCitationHover();
        if (entry) citationHover.current = { entry, timer: setTimeout(() => onCitation?.(entry), 220) };
      }}
      onPointerLeave={clearCitationHover}
      onClick={(event) => {
        const start = citationPointer.current;
        citationPointer.current = null;
        if (mode !== "select" || !start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 || window.getSelection()?.toString()) return;
        const element = event.target instanceof Element ? event.target : null;
        if (element?.closest("button, a")) return;
        const entry = citationAt(event.clientX, event.clientY);
        if (entry) onCitation?.(entry);
      }}
      onPointerUp={finishRegion}
      onPointerCancel={() => {
        regionStart.current = null;
        setRegion(null);
      }}
    >
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        aria-label={`PDF 物理第 ${pageIndex + 1} 页`}
      />
      <div ref={textRef} className={`textLayer ${styles.text}`} />
      {!ready && (
        <div className={styles.pagePlaceholder}>
          {renderError ? (
            <>
              <strong>第 {pageIndex + 1} 页绘制失败</strong>
              <p>{renderError}</p>
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setRetry((value) => value + 1)}
              >
                重试此页
              </button>
            </>
          ) : (
            <span>
              {active
                ? `正在绘制第 ${pageIndex + 1} 页…`
                : `第 ${pageIndex + 1} 页 · 页标签 ${pageLabel}`}
            </span>
          )}
        </div>
      )}
      {ready && (
        <div className={styles.overlay}>
          {mode === "select" && citations.flatMap(({ entry, rects }, citationIndex) => rects.map((rect, rectIndex) => (
            <button type="button" key={`citation:${citationIndex}:${rectIndex}`}
              className={styles.citationHotspot} data-citation-hotspot="true"
              aria-label={`预览参考文献：${entry.text.slice(0, 120)}`}
              ref={(element) => moveBox(element, rect)}
              onFocus={() => onCitation?.(entry)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onCitation?.(entry); }
              }} />
          )))}
          <svg
            className={styles.highlightPaint}
            width={viewport.width}
            height={viewport.height}
            aria-hidden="true"
            focusable="false"
            data-pdf-highlight-ink="true"
          >
            {Array.from(ink, ([key, group]) => (
              <g key={key} fill={group.fill} className={group.className}>
                {group.rects.map((rect, index) => (
                  <rect
                    key={index}
                    x={rect.x}
                    y={rect.y}
                    width={rect.width}
                    height={rect.height}
                  />
                ))}
              </g>
            ))}
          </svg>
          {resolvedMarks.map(({ evidence, rects }) =>
            rects.map((rect, index) => (
              <button
                type="button"
                key={`guide:${evidence.id}:${index}`}
                className={`${styles.guideMark} ${activeGuideMarkId === evidence.id ? styles.activeGuideMark : ""}`}
                data-guide-mark-id={evidence.id}
                data-guide-category={evidence.category}
                aria-label={`AI 导读：${evidence.title}`}
                title={`AI 导读 · ${evidence.title}\n${evidence.explanation}`}
                ref={(element) => {
                  moveBox(element, rect);
                  element?.style.setProperty(
                    "--guide-badge-offset",
                    `${4 - rect.x}px`,
                  );
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectGuideMark?.(evidence.id);
                }}
              >
                {index === 0 && (
                  <span className={styles.guideBadge} aria-hidden="true">
                    AI
                  </span>
                )}
              </button>
            )),
          )}
          {personalMarks.map(({ annotation, rects }) =>
            marks(
              rects,
              annotation.id,
              `${styles.mark} ${annotation.kind === "region" ? styles.regionMark : ""} ${activeId === annotation.id ? styles.activeMark : ""}`,
              annotation.comment ||
                annotation.selectedText ||
                `区域批注 · 物理第 ${pageIndex + 1} 页`,
              annotation.id,
              annotation.color,
            ),
          )}
          {thisDraft &&
            marks(
              draftRects,
              "draft",
              `${styles.mark} ${styles.draftMark} ${thisDraft.kind === "region" ? styles.regionMark : ""}`,
              "待保存批注",
            )}
          {!!targetRects?.length &&
            marks(
              locationRects,
              "target",
              `${styles.mark} ${styles.targetMark}`,
              "来源位置",
            )}
          {region && (
            <div
              className={styles.drawingRegion}
              ref={(element) => moveBox(element, region)}
            />
          )}
        </div>
      )}
    </div>
  );
}
