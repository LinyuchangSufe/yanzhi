"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { LoaderCircle, X } from "lucide-react";
import type { WorkspaceController } from "../Workspace";
import { plainTextPreview } from "../../lib/plain-text-preview";
import TooltipButton from "../TooltipButton";
import styles from "./WorkspaceSearchResults.module.css";

function highlighted(text: string, query: string): ReactNode {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return text;
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(pattern).map((part, index) => words.some((word) => word.toLocaleLowerCase() === part.toLocaleLowerCase())
    ? <mark key={index}>{part}</mark> : part);
}

export function WorkspaceSearchResults({ c, onClose }: { c: WorkspaceController; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const { query, results, searching, searchError } = c;
  useEffect(() => {
    const position = () => {
      const input = Array.from(document.querySelectorAll<HTMLInputElement>("[data-kb-search] input"))
        .find((element) => element.getClientRects().length > 0);
      const anchor = input?.closest("[data-kb-search]");
      if (!anchor || !panel.current) return;
      const bounds = anchor.getBoundingClientRect();
      const width = Math.min(660, window.innerWidth - 16);
      const top = Math.min(bounds.bottom + 8, window.innerHeight - 140);
      panel.current.style.setProperty("--search-left", `${Math.max(8, Math.min(window.innerWidth - width - 8, bounds.right - width))}px`);
      panel.current.style.setProperty("--search-top", `${Math.max(8, top)}px`);
      panel.current.style.setProperty("--search-width", `${width}px`);
      panel.current.style.setProperty("--search-height", `${window.innerHeight - Math.max(8, top) - 12}px`);
      panel.current.dataset.positioned = "true";
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("[data-search-result]") || []);
      const current = buttons.indexOf(target as HTMLButtonElement);
      const fromInput = target.matches("[data-kb-search] input, [data-kb-search] input *");
      if ((!fromInput && current < 0) || !buttons.length || (fromInput && event.key !== "ArrowDown")) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : event.key === "ArrowDown" ? Math.min(buttons.length - 1, current + 1) : current - 1;
      if (next < 0) Array.from(document.querySelectorAll<HTMLInputElement>("[data-kb-search] input"))
        .find((element) => element.getClientRects().length > 0)?.focus();
      else buttons[next]?.focus();
    };
    position();
    const frame = requestAnimationFrame(position);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    document.addEventListener("keydown", keyboard);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      document.removeEventListener("keydown", keyboard);
    };
  }, [c.paper?.id, query, results.length]);
  return <div ref={panel} data-kb-search-results className={styles.panel} role="region" aria-label="知识库搜索结果" aria-busy={searching}>
    <header><span role="status" aria-live="polite">{searching ? <><LoaderCircle size={14} className={styles.spin} />正在搜索…</>
      : searchError ? "搜索未完成" : `${results.length} 个结果`}</span>
      <TooltipButton aria-label="关闭搜索结果" onClick={onClose}><X size={17} /></TooltipButton>
    </header>
    <p className={styles.scope}>搜索文献、笔记、标注、待核验条目和已保存的讨论，不包含 PDF 全文。</p>
    {searchError ? <div className={styles.empty} role="alert"><p>{searchError}</p><button onClick={c.retrySearch}>重试搜索</button></div>
      : results.map((result) => <button key={`${result.type}:${result.id}`} data-search-result className={styles.result}
        onClick={() => void c.openSearchResult(result)}>
        <span className={styles.type}>{({ paper: "文献", note: "笔记", annotation: "标注", topic: "问题", idea: "想法", ai: "AI", tag: "标签", discussion: "Codex", "research-item": "待核验" })[result.type]}</span>
        <strong>{highlighted(result.title, query)}</strong>
        <span className={styles.snippet}>{highlighted(plainTextPreview(result.snippet, { title: result.title, maxLength: 170 }), query)}</span>
      </button>)}
    {!searching && !searchError && !results.length && <div className={styles.empty}>没有匹配内容，试试更短的关键词。</div>}
  </div>;
}
