"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  Ellipsis,
  FilePlus,
  FileCode2,
  Minus,
  Plus,
  RotateCw,
  Scan,
  TextSelect,
  X,
} from "lucide-react";
import type { Attachment } from "../../lib/types";
import type { OutlineEntry } from "./usePdfDocument";
import TooltipButton from "../TooltipButton";
import styles from "./PdfReader.module.css";

interface Props {
  attachments: Attachment[];
  attachmentId: string;
  pageIndex: number;
  pageCount: number;
  pageLabel: string;
  scale: number | "page-width";
  effectiveScale: number;
  expanded: boolean;
  mode: "select" | "region";
  outline: OutlineEntry[];
  onToggle: () => void;
  onAttachment: (id: string) => void;
  onPage: (index: number) => void;
  onScale: (value: number | "page-width") => void;
  onStepZoom: (direction: 1 | -1) => void;
  onRotate: () => void;
  onMode: (value: "select" | "region") => void;
  onOutline: (value: string) => void;
  onRequestAttachment?: () => void;
  onConvertPage?: () => void;
  aiBusy?: boolean;
}

export function PdfToolbar({
  attachments,
  attachmentId,
  pageIndex,
  pageCount,
  pageLabel,
  scale,
  effectiveScale,
  expanded,
  mode,
  outline,
  onToggle,
  onAttachment,
  onPage,
  onScale,
  onStepZoom,
  onRotate,
  onMode,
  onOutline,
  onRequestAttachment,
  onConvertPage,
  aiBusy,
}: Props) {
  const attachment = attachments.find((item) => item.id === attachmentId);
  const zoomOptions = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  const panelId = useId();
  const hintId = useId();
  const [hintsDismissed, setHintsDismissed] = useState(false);
  const [hintInput, setHintInput] = useState<"pointer" | "keyboard">("pointer");
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;
  function showPointerHint() {
    setHintInput("pointer");
    setHintsDismissed(false);
  }
  function showFocusHint() {
    setHintInput("keyboard");
    setHintsDismissed(false);
  }

  useEffect(() => {
    const dismissHints = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHintsDismissed(true);
    };
    document.addEventListener("keydown", dismissHints);
    return () => document.removeEventListener("keydown", dismissHints);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    panelRef.current?.focus();
    function dismiss(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      if (
        !panelRef.current?.contains(event.target) &&
        !toggleRef.current?.contains(event.target)
      )
        onToggleRef.current();
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return;
      // A separately opened dialog owns Escape while it has focus.
      if (
        event.target instanceof Element &&
        event.target.closest('[role="dialog"]')
      )
        return;
      event.preventDefault();
      onToggleRef.current();
      toggleRef.current?.focus();
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [expanded]);

  const printedLabel =
    pageLabel !== String(pageIndex + 1) ? ` · 页标签 ${pageLabel}` : "";
  return (
    <div
      className={styles.controls}
      data-hints-dismissed={hintsDismissed}
      data-hint-input={hintInput}
    >
      <div className={styles.toolbar} role="toolbar" aria-label="PDF 阅读工具">
        <div className={styles.pageControls}>
          <TooltipButton
            type="button"
            disabled={!pageCount || pageIndex <= 0}
            onClick={() => onPage(pageIndex - 1)}
            aria-label="上一页"
            title="上一页"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </TooltipButton>
          <label
            className={styles.pageCounter}
            title={`物理第 ${pageIndex + 1} 页${printedLabel}`}
          >
            <input
              aria-label="PDF 物理页码"
              type="number"
              min={1}
              max={pageCount || 1}
              value={pageIndex + 1}
              disabled={!pageCount}
              onChange={(event) => onPage(Number(event.target.value) - 1)}
            />
            <span aria-live="polite">/ {pageCount || "—"}</span>
          </label>
          <TooltipButton
            type="button"
            disabled={!pageCount || pageIndex >= pageCount - 1}
            onClick={() => onPage(pageIndex + 1)}
            aria-label="下一页"
            title="下一页"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </TooltipButton>
        </div>
        <div className={styles.zoomControls}>
          <TooltipButton
            type="button"
            disabled={!pageCount || effectiveScale <= 0.25}
            onClick={() => onStepZoom(-1)}
            aria-label="缩小 PDF"
            title="缩小 PDF"
          >
            <Minus size={16} aria-hidden="true" />
          </TooltipButton>
          <select
            className={styles.zoomSelect}
            aria-label="PDF 缩放"
            value={scale}
            disabled={!pageCount}
            title={
              scale === "page-width"
                ? `适合宽度 · ${Math.round(effectiveScale * 100)}%`
                : "PDF 缩放"
            }
            onChange={(event) =>
              onScale(
                event.target.value === "page-width"
                  ? "page-width"
                  : Number(event.target.value),
              )
            }
          >
            <option value="page-width">
              适宽 {Math.round(effectiveScale * 100)}%
            </option>
            {zoomOptions.map((value) => (
              <option key={value} value={value}>
                {Math.round(value * 100)}%
              </option>
            ))}
            {typeof scale === "number" && !zoomOptions.includes(scale) && (
              <option value={scale}>{Math.round(scale * 100)}%</option>
            )}
          </select>
          <TooltipButton
            type="button"
            disabled={!pageCount || effectiveScale >= 4}
            onClick={() => onStepZoom(1)}
            aria-label="放大 PDF"
            title="放大 PDF"
          >
            <Plus size={16} aria-hidden="true" />
          </TooltipButton>
        </div>
        <TooltipButton
          ref={toggleRef}
          className={styles.moreToggle}
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={expanded ? "收起 PDF 工具栏" : "展开 PDF 工具栏"}
          tooltip={`更多 PDF 工具${attachment ? ` · ${attachment.filename}` : ""}`}
        >
          <Ellipsis size={18} aria-hidden="true" />
        </TooltipButton>
        <div className={styles.secondaryTools}>
          <div className={styles.modeControls}>
            <TooltipButton
              className={styles.labeledTool}
              type="button"
              disabled={!pageCount}
              aria-pressed={mode === "select"}
              tooltip="选中文字，高亮并添加评论"
              onClick={() => onMode("select")}
              aria-label="选择文字"
            >
              <TextSelect size={16} aria-hidden="true" />
              <span>文字</span>
            </TooltipButton>
            <TooltipButton
              className={styles.labeledTool}
              type="button"
              disabled={!pageCount}
              aria-pressed={mode === "region"}
              tooltip="拖框标记公式、图片或表格"
              onClick={() => onMode(mode === "region" ? "select" : "region")}
              aria-label="区域批注"
            >
              <Scan size={16} aria-hidden="true" />
              <span>区域</span>
            </TooltipButton>
          </div>
          {outline.length > 0 && (
            <label
              className={styles.outlineControl}
              onPointerEnter={showPointerHint}
              onFocus={showFocusHint}
              onPointerDown={() => setHintsDismissed(true)}
            >
              <BookOpen size={16} aria-hidden="true" />
              <span>目录</span>
              <select
                aria-label="PDF 目录"
                aria-describedby={`${hintId}-outline`}
                defaultValue=""
                onChange={(event) => {
                  setHintsDismissed(true);
                  onOutline(event.target.value);
                  event.target.value = "";
                }}
              >
                <option value="">目录</option>
                {outline.map((item, index) => (
                  <option key={index} value={index}>
                    {"　".repeat(Math.min(item.depth, 5))}
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
      {outline.length > 0 && (
        <div
          id={`${hintId}-outline`}
          role="tooltip"
          className={`${styles.toolHint} ${styles.outlineHint}`}
        >
          <strong>目录</strong>
          <span>跳转到论文的章节</span>
        </div>
      )}
      {expanded && (
        <div
          ref={panelRef}
          id={panelId}
          className={styles.morePanel}
          role="region"
          aria-label="PDF 更多工具"
          tabIndex={-1}
        >
          <div className={styles.moreHeading}>
            <strong>PDF 更多工具</strong>
            <TooltipButton
              type="button"
              aria-label="关闭 PDF 更多工具"
              tooltip="关闭 PDF 更多工具 · Esc"
              onClick={() => {
                onToggle();
                toggleRef.current?.focus();
              }}
            >
              <X size={15} aria-hidden="true" />
            </TooltipButton>
          </div>
          {attachments.length > 1 ? (
            <label className={styles.attachmentLabel}>
              PDF 附件
              <select
                aria-label="切换 PDF 附件"
                value={attachmentId}
                onChange={(event) => onAttachment(event.target.value)}
              >
                {attachments.map((item, index) => (
                  <option key={item.id} value={item.id}>
                    {item.filename} · 附件 {index + 1}
                    {item.status === "missing" ? "（缺失）" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className={styles.filename} title={attachment?.filename}>
              {attachment?.filename ?? "尚未添加 PDF"}
            </p>
          )}
          <div className={styles.moreActions}>
          <TooltipButton
            type="button"
            disabled={!pageCount}
            onClick={() => { onToggle(); onRotate(); toggleRef.current?.focus(); }}
            aria-label="顺时针旋转 PDF 90 度"
            tooltip="顺时针旋转 PDF 90°"
          >
            <RotateCw size={16} aria-hidden="true" />
          </TooltipButton>
          {onConvertPage && (
            <TooltipButton
              className={styles.labeledTool}
              type="button"
              disabled={!pageCount || aiBusy}
              onClick={() => { onToggle(); onConvertPage(); toggleRef.current?.focus(); }}
              aria-label="当前页转为 Markdown + LaTeX"
              tooltip="识别当前页文字与公式，转为 Markdown + LaTeX"
            >
              <FileCode2 size={16} aria-hidden="true" />
              <span>识别此页</span>
            </TooltipButton>
          )}

            {attachment && (
              <a
                href={`/api/kb/attachment?id=${encodeURIComponent(attachmentId)}`}
                target="_blank"
                rel="noreferrer"
              >
                <Download size={14} aria-hidden="true" />
                打开原 PDF
              </a>
            )}
            {onRequestAttachment && (
              <button
                type="button"
                onClick={() => {
                  onToggle();
                  onRequestAttachment();
                }}
              >
                <FilePlus size={14} aria-hidden="true" />
                添加 PDF 附件
              </button>
            )}
          </div>
          {printedLabel && (
            <p className={styles.hint}>
              当前物理第 {pageIndex + 1} 页{printedLabel}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
