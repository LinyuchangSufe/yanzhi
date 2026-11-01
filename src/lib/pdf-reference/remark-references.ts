import { findPaperRefs } from "./paper-refs";

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

/** Link ordinary prose only. Code, math and existing links remain byte-for-byte. */
export function remarkPaperReferences() {
  return (tree: MarkdownNode) => {
    const walk = (parent: MarkdownNode) => {
      if (!parent.children || ["link", "image", "code", "inlineCode", "math", "inlineMath"].includes(parent.type)) return;
      parent.children = parent.children.flatMap((node) => {
        if (node.type !== "text" || !node.value) { walk(node); return [node]; }
        const value = node.value;
        const refs = findPaperRefs(value);
        if (!refs.length) return [node];
        const nodes: MarkdownNode[] = [];
        let offset = 0;
        for (const ref of refs) {
          if (ref.start < offset) continue;
          if (ref.start > offset) nodes.push({ type: "text", value: value.slice(offset, ref.start) });
          nodes.push({ type: "link", url: `#paper-ref:${ref.kind}:${ref.label}`, children: [{ type: "text", value: value.slice(ref.start, ref.end) }] });
          offset = ref.end;
        }
        if (offset < value.length) nodes.push({ type: "text", value: value.slice(offset) });
        return nodes;
      });
    };
    walk(tree);
  };
}
