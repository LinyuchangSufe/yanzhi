/** A small semantic tree shared by the renderer and the browser copy handler. */
export interface MarkdownCopyNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownCopyNode[];
}

const mathAttribute = "data-md-copy-math";
const displayAttribute = "data-md-copy-display";
const numberAttribute = "data-md-copy-number";
const editableSelector = "input, textarea, select, [contenteditable]:not([contenteditable=false])";

function plainText(node: MarkdownCopyNode): string {
  return node.type === "text" ? node.value ?? "" : (node.children ?? []).map(plainText).join("");
}

function classes(node: MarkdownCopyNode): string[] {
  const value = node.properties?.className;
  return Array.isArray(value) ? value.map(String) : String(value ?? "").split(/\s+/);
}

/**
 * Keep the original TeX outside KaTeX's duplicated visual/MathML trees. The
 * wrapper survives rehype-katex, including its invalid-formula error fallback.
 */
export function rehypeMarkdownCopy() {
  return (tree: MarkdownCopyNode) => {
    function walk(parent: MarkdownCopyNode) {
      parent.children = parent.children?.map((node) => {
        const code = node.tagName === "pre"
          ? node.children?.find((child) => child.tagName === "code")
          : node.tagName === "code" ? node : undefined;
        const names = code ? classes(code) : [];
        if (code && names.some((name) => ["language-math", "math-inline", "math-display"].includes(name))) {
          const display = node.tagName === "pre" || names.includes("math-display");
          return {
            type: "element", tagName: "span",
            properties: { [mathAttribute]: plainText(code), [displayAttribute]: display ? "block" : "inline" },
            children: [node],
          };
        }
        if (node.tagName === "ol") {
          let ordinal = Number(node.properties?.start) || 1;
          for (const child of node.children ?? []) if (child.tagName === "li") {
            child.properties = { ...child.properties, [numberAttribute]: String(ordinal++) };
          }
        }
        walk(node);
        return node;
      });
    }
    walk(tree);
  };
}

function property(node: MarkdownCopyNode | undefined, key: string): string | undefined {
  const value = node?.properties?.[key];
  return value === undefined || value === null || value === false ? undefined : String(value);
}

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\")
    .replace(/[`*_[\]<>~$#!|]/g, "\\$&")
    .replace(/^(\s*)([-+]\s|\d+[.)]\s)/gm, (_, spaces: string, marker: string) => spaces + marker.replace(/[-+.)]/, "\\$&"));
}

function wrapInline(value: string, marker: string): string {
  const [, before, content, after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(value)!;
  return content ? `${before}${marker}${content}${marker}${after}` : value;
}

function codeSpan(value: string): string {
  const delimiter = "`".repeat(Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length)) + 1);
  const padding = /^`|`$/.test(value) || (/^ .* $/.test(value) && /\S/.test(value)) ? " " : "";
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}

function destination(value: string): string {
  return value.replace(/[\\()<>\s]/g, (character) => encodeURIComponent(character).replace(/[()]/g, (symbol) => `%${symbol.charCodeAt(0).toString(16).toUpperCase()}`));
}

function childrenMarkdown(node: MarkdownCopyNode): string {
  const blockContainer = ["root", "div", "section", "article", "blockquote", "li"].includes(node.tagName ?? node.type);
  return (node.children ?? []).map((child) =>
    blockContainer && child.type === "text" && /^\s*\n\s*$/.test(child.value ?? "") ? "" : serialize(child),
  ).join("");
}

function listMarkdown(node: MarkdownCopyNode): string {
  const start = Number(property(node, "start")) || 1;
  return (node.children ?? []).filter((child) => child.tagName === "li").map((item, index) => {
    const marker = node.tagName === "ol" ? `${Number(property(item, numberAttribute)) || start + index}. ` : "- ";
    // A task checkbox may be wrapped in a paragraph, but never borrow a nested
    // list item's checkbox for the containing item.
    function checkbox(child: MarkdownCopyNode): MarkdownCopyNode | undefined {
      if (child.tagName === "input" && property(child, "type") === "checkbox") return child;
      return (child.children ?? []).filter((entry) => entry.tagName !== "li").map(checkbox).find(Boolean);
    }
    const task = checkbox(item);
    const content = childrenMarkdown(item).trim();
    const taskMarker = task ? `[${property(task, "checked") === undefined ? " " : "x"}] ` : "";
    return `${marker}${taskMarker}${content.replace(/\n/g, `\n${" ".repeat(marker.length)}`)}`;
  }).join("\n") + "\n\n";
}

function tableMarkdown(node: MarkdownCopyNode): string {
  function rows(parent: MarkdownCopyNode): MarkdownCopyNode[] {
    return (parent.children ?? []).flatMap((child) => child.tagName === "tr" ? [child] : rows(child));
  }
  const sourceRows = rows(node);
  const cells = sourceRows.map((row) => (row.children ?? []).filter((cell) => ["th", "td"].includes(cell.tagName ?? "")));
  const width = Math.max(0, ...cells.map((row) => row.length));
  if (!width) return "";
  function row(values: string[]) { return `| ${Array.from({ length: width }, (_, index) => values[index] ?? "").join(" | ")} |`; }
  const values = cells.map((entries) => entries.map((cell) => childrenMarkdown(cell).trim().replace(/\n+/g, "<br>").replace(/(?<!\\)\|/g, "\\|")));
  const hasHeader = cells[0]?.some((cell) => cell.tagName === "th");
  const header = hasHeader ? values.shift()! : Array<string>(width).fill("");
  const alignments = Array.from({ length: width }, (_, index) => {
    const cell = cells[0]?.[index];
    const align = property(cell, "align") ?? /text-align:\s*(left|right|center)/.exec(property(cell, "style") ?? "")?.[1];
    return align === "left" ? ":---" : align === "right" ? "---:" : align === "center" ? ":---:" : "---";
  });
  return [row(header), row(alignments), ...values.map(row)].join("\n") + "\n\n";
}

function serialize(node: MarkdownCopyNode): string {
  if (property(node, "data-md-copy-ignore") === "true") return "";
  if (node.type === "text") return escapeText(node.value ?? "");
  const math = property(node, mathAttribute);
  if (math !== undefined) return property(node, displayAttribute) === "block" ? `$$\n${math}\n$$\n\n` : `$${math}$`;
  if (property(node, "aria-hidden") === "true" || ["script", "style", "input", "textarea", "select"].includes(node.tagName ?? "")) return "";
  const tag = node.tagName ?? "";
  if (tag === "pre") {
    const code = node.children?.find((child) => child.tagName === "code") ?? node;
    const value = plainText(code).replace(/\n$/, "");
    const delimiter = "`".repeat(Math.max(2, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length)) + 1);
    const language = classes(code).find((name) => name.startsWith("language-"))?.slice(9) ?? "";
    return `${delimiter}${language}\n${value}\n${delimiter}\n\n`;
  }
  if (tag === "code") return codeSpan(plainText(node));
  if (["ul", "ol"].includes(tag)) return listMarkdown(node);
  if (tag === "table") return tableMarkdown(node);
  if (tag === "br") return "  \n";
  if (tag === "hr") return "---\n\n";
  if (tag === "img") return `![${escapeText(property(node, "alt") ?? "")}](${destination(property(node, "src") ?? "")})`;
  const content = childrenMarkdown(node);
  if (["strong", "b"].includes(tag)) return wrapInline(content, "**");
  if (["em", "i"].includes(tag)) return wrapInline(content, "*");
  if (["del", "s"].includes(tag)) return wrapInline(content, "~~");
  if (/^h[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${content.trim()}\n\n`;
  if (tag === "p") return `${content}\n\n`;
  if (tag === "blockquote") return content.trim().split("\n").map((line) => line ? `> ${line}` : ">").join("\n") + "\n\n";
  if (tag === "a") {
    const href = property(node, "data-md-copy-href") ?? property(node, "href");
    return href ? `[${content}](${destination(href)})` : content;
  }
  return content;
}

/** Format a selected semantic fragment. Never serialize untrusted HTML. */
export function markdownFromCopyTree(tree: MarkdownCopyNode): string {
  return serialize(tree).trim();
}

function domTree(node: Node): MarkdownCopyNode {
  if (node.nodeType === 3) return { type: "text", value: node.textContent ?? "" };
  const element = node.nodeType === 1 ? node as Element : undefined;
  const properties: Record<string, unknown> = {};
  for (const name of element?.getAttributeNames() ?? []) properties[name === "class" ? "className" : name] = element!.getAttribute(name);
  return { type: element ? "element" : "root", tagName: element?.tagName.toLowerCase(), properties, children: Array.from(node.childNodes, domTree) };
}

/**
 * Only intercept a nonempty selection wholly contained in one enabled reply.
 * A formula is an atomic copy unit: selecting any of it copies its full TeX.
 * The user's visible selection is never changed.
 */
export function selectedMarkdown(root: HTMLElement, selection: Selection | null): string | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const parentElement = (node: Node) => node.nodeType === 1 ? node as Element : node.parentElement;
  if ([range.startContainer, range.endContainer].some((node) => parentElement(node)?.closest(editableSelector))) return null;
  const copied = range.cloneRange();
  const startMath = parentElement(copied.startContainer)?.closest(`[${mathAttribute}]`);
  const endMath = parentElement(copied.endContainer)?.closest(`[${mathAttribute}]`);
  if (startMath && root.contains(startMath)) copied.setStartBefore(startMath);
  if (endMath && root.contains(endMath)) copied.setEndAfter(endMath);
  let fragment: Node = copied.cloneContents();
  // cloneContents omits the common ancestor. Restore its semantic ancestors so
  // copying the middle of bold text, a heading, a list or a cell keeps its format.
  let ancestor = parentElement(copied.commonAncestorContainer);
  while (ancestor && ancestor !== root) {
    const wrapper = ancestor.cloneNode(false);
    wrapper.appendChild(fragment);
    fragment = wrapper;
    ancestor = ancestor.parentElement;
  }
  return markdownFromCopyTree(domTree(fragment)) || null;
}

/**
 * Browsers may dispatch copy to body rather than the element containing the
 * text selection. Listen on this reply's document and gate by its actual range.
 * This also covers the context menu and still works while a reply is streaming.
 */
export function listenForMarkdownCopy(root: HTMLElement): () => void {
  const document = root.ownerDocument;
  const copy = (event: ClipboardEvent) => {
    if (event.defaultPrevented || !event.clipboardData) return;
    const target = event.target as Node | null;
    const element = target?.nodeType === 1 ? target as Element : target?.parentElement;
    if (element?.closest(editableSelector)) return;
    const markdown = selectedMarkdown(root, document.getSelection());
    if (markdown === null) return;
    // Clipboard writes are synchronous and restricted to this native copy event.
    // If a browser denies text/plain, leave its own copy behavior in charge.
    try { event.clipboardData.setData("text/plain", markdown); } catch { return; }
    try { event.clipboardData.setData("text/markdown", markdown); } catch { /* Plain text is enough for a Markdown editor. */ }
    event.preventDefault();
  };
  document.addEventListener("copy", copy);
  return () => document.removeEventListener("copy", copy);
}
