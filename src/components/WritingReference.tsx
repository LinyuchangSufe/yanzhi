"use client";

import { useState } from "react";
import { ArrowLeft, Check, Copy, Search, X } from "lucide-react";
import {
  searchWritingReference,
  writingReferenceEntries,
  type WritingReferenceCategory,
} from "../lib/writing-reference";
import Markdown from "./Markdown";
import styles from "./WritingReference.module.css";

const categories = [
  { id: "all", title: "全部" },
  { id: "markdown", title: "Markdown 排版" },
  { id: "latex", title: "LaTeX 公式" },
] as const;

export default function WritingReference({
  onBack,
}: {
  onBack?: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<WritingReferenceCategory | "all">(
    "all",
  );
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState("");
  const entries = searchWritingReference(query, category);
  async function copy(id: string, code: string) {
    setCopyError("");
    try {
      await navigator.clipboard.writeText(code);
      setCopied(id);
    } catch {
      setCopied("");
      setCopyError("复制未成功，请选中写法手动复制。");
    }
  }
  return (
    <section
      className={styles.page}
      aria-labelledby="writing-reference-heading"
    >
      <div className={styles.heading}>
        <div>
          <h1 id="writing-reference-heading">格式速查</h1>
        </div>
        {onBack && (
          <button className={styles.back} onClick={() => void onBack()}>
            <ArrowLeft size={15} />
            返回工作区
          </button>
        )}
      </div>
      <div className={styles.tools}>
        <div className={styles.search}>
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索格式用法"
            placeholder={"搜索：表格、矩阵、期望、\\frac…"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button aria-label="清空格式搜索" onClick={() => setQuery("")}>
              <X size={15} />
            </button>
          )}
        </div>
        <div className={styles.categories} role="group" aria-label="格式分类">
          {categories.map((item) => (
            <button
              key={item.id}
              aria-pressed={category === item.id}
              onClick={() => setCategory(item.id)}
            >
              {item.title}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.hint}>
        <p>选择写法，复制到笔记中。</p>
        <span role="status" aria-live="polite">
          {entries.length} / {writingReferenceEntries.length} 条
        </span>
      </div>
      {(copyError || copied) && <p className={styles.copyStatus} role="status" aria-live="polite">{copyError || "已复制写法，可返回笔记粘贴。"}</p>}
      {entries.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.srOnly}>
              Markdown 和 LaTeX 常用格式：用途、可复制写法与实际效果
            </caption>
            <thead>
              <tr>
                <th scope="col">用法</th>
                <th scope="col">写法</th>
                <th scope="col">效果</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <th scope="row">
                    <span className={styles.group}>
                      {entry.category === "markdown" ? "Markdown" : "LaTeX"} ·{" "}
                      {entry.group}
                    </span>
                    <strong>{entry.title}</strong>
                    <p>{entry.description}</p>
                  </th>
                  <td>
                    <div className={styles.codeTop}>
                      <button
                        className={styles.copy}
                        aria-label={"复制" + entry.title}
                        onClick={() => void copy(entry.id, entry.code)}
                      >
                        {copied === entry.id ? (
                          <Check size={13} />
                        ) : (
                          <Copy size={13} />
                        )}
                        {copied === entry.id ? "已复制" : "复制"}
                      </button>
                    </div>
                    <pre className={styles.code}>
                      <code>{entry.code}</code>
                    </pre>
                  </td>
                  <td>
                    <div className={styles.preview}>
                      <Markdown body={entry.code} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={styles.empty}>
          <Search size={25} />
          <h2>没有找到这个格式</h2>
          <p>试试“分数”“列表”“alpha”或 LaTeX 命令，也可以切换分类。</p>
          <button
            onClick={() => {
              setQuery("");
              setCategory("all");
            }}
          >
            查看全部格式
          </button>
        </div>
      )}
      <details className={styles.footnote}><summary>使用说明与支持范围</summary>
        <p>公式写在 <code>$…$</code>（行内）或 <code>$$…$$</code>（独立一行）中，在笔记“预览”中查看效果。这里与笔记使用相同的渲染方式。</p>
        <p>支持 Markdown 中的数学公式，不支持完整 .tex 文档、HTML 和部分 LaTeX 宏包命令。图片可通过插图按钮、粘贴或拖入保存在本地。</p>
      </details>
    </section>
  );
}
