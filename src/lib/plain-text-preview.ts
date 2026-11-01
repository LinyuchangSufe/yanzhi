import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

interface PreviewNode { type: string; value?: string; alt?: string; children?: PreviewNode[] }
const markdown = unified().use(remarkParse).use(remarkGfm);
const comparable = (value: string) => value.normalize("NFKC").replace(/\s+/g, "").replace(/[：:。.!！?？]+$/u, "").toLocaleLowerCase();
function readable(node: PreviewNode): string {
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (node.type === "html") return (node.value ?? "").replace(/<[^>]*>/g, " ");
  if (node.type === "definition" || node.type === "footnoteDefinition" || node.type === "footnoteReference") return "";
  if (node.type === "break" || node.type === "thematicBreak") return " ";
  if (node.value !== undefined) return node.value;
  const separator = ["root", "list", "listItem", "table", "tableRow", "tableCell"].includes(node.type) ? " " : "";
  return (node.children ?? []).map(readable).join(separator);
}

/** Display-only excerpt. Original Markdown and research content remain untouched. */
export function plainTextPreview(body: string, options: { title?: string; maxLength?: number } = {}): string {
  const maximum = Number.isFinite(options.maxLength) ? Math.max(0, Math.floor(options.maxLength!)) : 140;
  if (!maximum || !body.trim()) return "";
  const root = markdown.parse(body) as PreviewNode;
  const title = options.title ? comparable(options.title) : "";
  const blocks = (root.children ?? []).filter((node, index) =>
    !(title && (node.type === "heading" || index === 0) && comparable(readable(node)) === title));
  let value = blocks.map(readable).join(" ")
    .replace(/\$\$?([^$]+)\$\$?/g, "$1")
    .replace(/\\\(([\s\S]*?)\\\)/g, "$1")
    .replace(/\\\[([\s\S]*?)\\\]/g, "$1")
    .replace(/\s+/g, " ").trim();
  const leadingTitle = options.title?.trim();
  if (leadingTitle && value.toLocaleLowerCase().startsWith(leadingTitle.toLocaleLowerCase()) &&
      (!value[leadingTitle.length] || /[\s：:·\-—]/u.test(value[leadingTitle.length]))) {
    value = value.slice(leadingTitle.length).replace(/^[\s：:·\-—]+/u, "");
  }
  const characters = Array.from(value);
  return characters.length > maximum ? `${characters.slice(0, Math.max(0, maximum - 1)).join("").trimEnd()}…` : value;
}
