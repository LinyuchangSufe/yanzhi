import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  listenForMarkdownCopy, markdownFromCopyTree, rehypeMarkdownCopy, selectedMarkdown, type MarkdownCopyNode,
} from "../src/lib/render/selection-markdown";

const text = (value: string): MarkdownCopyNode => ({ type: "text", value });
const element = (tagName: string, children: MarkdownCopyNode[], properties?: Record<string, unknown>): MarkdownCopyNode => ({ type: "element", tagName, children, properties });

function render(body: string) {
  let tree: MarkdownCopyNode | undefined;
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkMath],
    rehypePlugins: [rehypeMarkdownCopy, rehypeKatex, () => (result: MarkdownCopyNode) => { tree = result; }],
  }, body));
  assert.ok(tree);
  return { html, markdown: markdownFromCopyTree(tree), tree };
}

test("copy serialization keeps actual rendered headings, inline formatting, quotes, links and lists as Markdown", () => {
  const original = "## Heading\n\nA **bold** and *italic* [link](https://example.org/a) with ~~old~~ text.\n\n> Quoted **source**\n\n3. First\n4. Second\n\n- [x] Done\n- [ ] Pending";
  assert.equal(render(original).markdown,
    "## Heading\n\nA **bold** and *italic* [link](https://example.org/a) with ~~old~~ text.\n\n> Quoted **source**\n\n3. First\n4. Second\n\n- [x] Done\n- [ ] Pending");
});

test("the pre-KaTeX wrapper keeps one exact TeX source, including invalid formulas", () => {
  const { html, markdown } = render("Inline $x_{t+1} = x_t - \\eta$ and $\\notARealCommand{x}$\n\n$$\n\\sum_{i=1}^n x_i\n$$");
  assert.match(html, /data-md-copy-math="x_\{t\+1\} = x_t - \\eta"/);
  assert.match(html, /class="katex"/);
  assert.match(html, /data-md-copy-display="block"/);
  assert.equal(markdown, "Inline $x_{t+1} = x_t - \\eta$ and $\\notARealCommand{x}$\n\n$$\n\\sum_{i=1}^n x_i\n$$");
  assert.equal(markdown.match(/\\sum/g)?.length, 1);
  assert.doesNotMatch(markdown, /annotation|MathML|katex|aria-hidden/);
});

test("a partial semantic fragment keeps its formatting ancestors and complete atomic formulas", () => {
  assert.equal(markdownFromCopyTree(element("h2", [element("strong", [text("middle")])])), "## **middle**");
  assert.equal(markdownFromCopyTree(element("p", [element("strong", [text(" middle ")])])), "**middle**");
  assert.equal(markdownFromCopyTree(element("p", [
    element("span", [text("x"), text("x"), text("irrelevant duplicate")], { "data-md-copy-math": "\\frac{x}{y}", "data-md-copy-display": "inline" }),
  ])), "$\\frac{x}{y}$");
  assert.equal(markdownFromCopyTree(element("ol", [element("li", [text("Selected second item")], { "data-md-copy-number": "7" })])), "7. Selected second item");
});

test("copy keeps code contents verbatim and chooses safe fences around embedded backticks", () => {
  const source = "```js\nconst literal = `a`;\n\n\nconsole.log(literal);\n```\n\n`` `inline` ``";
  assert.equal(render(source).markdown, source);
  assert.equal(markdownFromCopyTree(element("pre", [element("code", [text("```\nhello\n")], { className: ["language-md"] })])), "````md\n```\nhello\n````");
});

test("plain punctuation stays literal and link destinations survive whitespace and parentheses", () => {
  const result = markdownFromCopyTree(element("p", [text("literal *stars* $price [brackets] #tag | pipe\n1. literal number\n- literal dash "),
    element("a", [text("reference")], { href: "#paper/id", "data-md-copy-href": "kb://paper/id" }),
    text(" "), element("a", [text("URL")], { href: "https://example.org/a (b)" }),
  ]));
  assert.equal(result, "literal \\*stars\\* \\$price \\[brackets\\] \\#tag \\| pipe\n1\\. literal number\n\\- literal dash [reference](kb://paper/id) [URL](https://example.org/a%20%28b%29)");
});

test("tables retain Markdown cells, alignment, formatting and a valid header for a body-only fragment", () => {
  const original = "| Method | Score |\n| :--- | ---: |\n| **Ours** | $x_i$ |";
  assert.equal(render(original).markdown, original);
  assert.equal(markdownFromCopyTree(element("table", [element("tbody", [element("tr", [element("td", [text("partial cell")])])])])), "|  |\n| --- |\n| partial cell |");
});

test("nested lists preserve task states without borrowing a nested checkbox", () => {
  const original = "- Parent\n  - [x] Nested\n\n- Sibling";
  assert.equal(render(original).markdown, "- Parent\n  \n  - [x] Nested\n- Sibling");
});

test("navigation buttons copy as prose; hidden helper nodes do not leak", () => {
  const tree = element("p", [element("button", [text("Eq. (3)")]), text(" "), element("span", [text("HIDDEN DUPLICATE")], { "aria-hidden": "true" })]);
  assert.equal(markdownFromCopyTree(tree), "Eq. (3)");
});

test("empty and cross-reply selections use native copy without touching the range", () => {
  const root = { contains: () => false } as unknown as HTMLElement;
  assert.equal(selectedMarkdown(root, null), null);
  assert.equal(selectedMarkdown(root, { rangeCount: 0, isCollapsed: false } as Selection), null);
  assert.equal(selectedMarkdown(root, { rangeCount: 1, isCollapsed: true } as Selection), null);
  const outside = { collapsed: false, startContainer: {}, endContainer: {} };
  assert.equal(selectedMarkdown(root, { rangeCount: 1, isCollapsed: false, getRangeAt: () => outside } as unknown as Selection), null);
});

test("copy is observed on the owning document even when body is the event target, and cleans up", () => {
  let callback: ((event: ClipboardEvent) => void) | undefined;
  let reads = 0;
  let removed = false;
  const root = { ownerDocument: {
    addEventListener(name: string, listener: (event: ClipboardEvent) => void) { assert.equal(name, "copy"); callback = listener; },
    removeEventListener(name: string, listener: (event: ClipboardEvent) => void) { assert.equal(name, "copy"); assert.equal(listener, callback); removed = true; },
    getSelection() { reads++; return null; },
  } } as unknown as HTMLElement;
  const cleanup = listenForMarkdownCopy(root);
  assert.ok(callback);
  const body = { nodeType: 1, closest: () => null };
  const event = { target: body, clipboardData: { setData() { assert.fail("an empty selection must use native copy"); } }, preventDefault() { assert.fail("an empty selection must use native copy"); } };
  callback(event as unknown as ClipboardEvent);
  assert.equal(reads, 1, "document-level copy must inspect selections even when no copy event bubbles through the reply");
  callback({ ...event, defaultPrevented: true } as unknown as ClipboardEvent);
  callback({ ...event, target: { nodeType: 1, closest: () => ({ tagName: "TEXTAREA" }) } } as unknown as ClipboardEvent);
  assert.equal(reads, 1, "handled events and editor copy should not inspect or overwrite the document selection");
  cleanup();
  assert.equal(removed, true);
});
