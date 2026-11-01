"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useEffect, useRef, useState } from "react";
import styles from "./Markdown.module.css";
import { normalizeMath } from "../lib/render/normalize-math";
import { localNoteImageId } from "../lib/note-image-link";
import { remarkPaperReferences } from "../lib/pdf-reference/remark-references";
import { PAPER_REFERENCE_EVENT, parseReferenceRequest, type PaperReferenceRequest, type PaperReferenceScope } from "../lib/pdf-reference/events";
import { listenForMarkdownCopy, rehypeMarkdownCopy } from "../lib/render/selection-markdown";
import { isLiteratureHref } from "../lib/literature-links";

function NoteImage({ id, alt }: { id: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  const source = `/api/kb/image?id=${id}`;
  return failed ? (
    <span className={styles.image} role="status">
      本地图片无法读取：{alt || "图片"}。请检查图片文件或恢复完整备份。
    </span>
  ) : (
    <span className={styles.localImage}>
      <a
        href={source}
        target="_blank"
        rel="noreferrer noopener"
        title="打开原图"
      >
        <img
          src={source}
          alt={alt || "笔记插图"}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </a>
    </span>
  );
}

export default function Markdown({
  body,
  onNavigate,
  paperReferenceScope,
  onPaperRef,
  copyAsMarkdown = false,
  onFindPaper,
  literatureLinks,
}: {
  body: string;
  onNavigate?: (href: string) => void;
  paperReferenceScope?: PaperReferenceScope;
  onPaperRef?: (reference: PaperReferenceRequest) => void;
  copyAsMarkdown?: boolean;
  onFindPaper?: (query: string) => void;
  literatureLinks?: readonly string[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (copyAsMarkdown && root) return listenForMarkdownCopy(root);
  }, [copyAsMarkdown]);
  return (
    <div ref={rootRef} className={styles.markdown} data-copy-as-markdown={copyAsMarkdown || undefined}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, ...(paperReferenceScope ? [remarkPaperReferences] : [])]}
        rehypePlugins={[
          ...(copyAsMarkdown ? [rehypeMarkdownCopy] : []),
          [rehypeKatex, { trust: false, throwOnError: false, strict: "warn" }],
        ]}
        skipHtml
        urlTransform={(url) =>
          /^(https?:|mailto:|kb:\/\/|#|\/)/i.test(url) ? url : ""
        }
        components={{
          img: ({ alt, src }) => {
            const id = localNoteImageId(src);
            return id ? (
              <NoteImage key={id} id={id} alt={alt} />
            ) : (
              <span className={styles.image}>
                图片未加载：{alt || "图片"}
                。请通过插图按钮、粘贴或拖入将图片保存到本地。
              </span>
            );
          },
          a: ({ href, children }) => {
            const match = /^#paper-ref:([a-z]+):([A-Z\d.]+)$/.exec(href ?? "");
            const request = match && paperReferenceScope ? parseReferenceRequest({ ...paperReferenceScope, kind: match[1], label: match[2] }) : null;
            return request ? (
              <button type="button" className={styles.paperReference}
                aria-label={`定位原文：${String(children)}`}
                title="在当前 PDF 中定位，来源编号仍需核对"
                onClick={(event) => {
                  if (onPaperRef) onPaperRef(request);
                  else event.currentTarget.ownerDocument.defaultView?.dispatchEvent(new CustomEvent(PAPER_REFERENCE_EVENT, { detail: request }));
                }}>
                {children}
              </button>
            ) : href?.startsWith("kb://") ? (
              <a
                href={`#${href.slice(5)}`}
                data-md-copy-href={copyAsMarkdown ? href : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate?.(href);
                }}
              >
                {children}
              </a>
            ) : (
              <>
                <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
                {onFindPaper && href && (isLiteratureHref(href) || literatureLinks?.includes(href)) &&
                  <button type="button" className={styles.collectPaper} data-md-copy-ignore="true" title="核对题录、下载并加入文献库" aria-label="查找并收藏这篇文献"
                    onClick={() => onFindPaper(href)}>收藏</button>}
              </>
            );
          },
        }}
      >
        {normalizeMath(body) || "*还没有内容。开始记录你的理解。*"}
      </ReactMarkdown>
    </div>
  );
}
