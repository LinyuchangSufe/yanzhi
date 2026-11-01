import { unified } from "unified";
import remarkParse from "remark-parse";
import type { EntityType } from "./types";

interface MarkdownNode {
  type: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
}
/** Parse Markdown rather than counting source-like strings in code or plain text. */
export function sourceLinks(
  body: string,
): Array<{ type: EntityType; id: string }> {
  const tree = unified().use(remarkParse).parse(body) as MarkdownNode;
  const definitions = new Map<string, string>();
  const walk = (node: MarkdownNode, fn: (node: MarkdownNode) => void) => {
    fn(node);
    for (const child of node.children ?? []) walk(child, fn);
  };
  walk(tree, (node) => {
    if (node.type === "definition" && node.identifier && node.url)
      definitions.set(node.identifier.toLowerCase(), node.url);
  });
  const links: Array<{ type: EntityType; id: string }> = [];
  walk(tree, (node) => {
    const url =
      node.type === "link"
        ? node.url
        : node.type === "linkReference" && node.identifier
          ? definitions.get(node.identifier.toLowerCase())
          : undefined;
    const match = url?.match(
      /^kb:\/\/(paper|annotation|note|topic|ai|tag)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    );
    if (match)
      links.push({
        type: match[1].toLowerCase() as EntityType,
        id: match[2].toLowerCase(),
      });
  });
  return links;
}
