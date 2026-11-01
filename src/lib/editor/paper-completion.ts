import {
  autocompletion,
  closeCompletion,
  pickedCompletion,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { Paper } from "../types";

export interface PaperTrigger {
  from: number;
  to: number;
  text: string;
  query: string;
}

export function markdownLabel(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_{}\[\]<>!|~&$]/g, "\\$&");
}

export function paperMarkdown(paper: Pick<Paper, "id" | "title">): string {
  return `[${markdownLabel(paper.title)}](kb://paper/${paper.id})`;
}

export function paperTrigger(
  state: EditorState,
  at: number,
): PaperTrigger | null {
  const line = state.doc.lineAt(at);
  const match = /\[\[([^\[\]\n]*)$/.exec(line.text.slice(0, at - line.from));
  if (!match || /\\$/.test(line.text.slice(0, match.index))) return null;
  let node = syntaxTree(state).resolveInner(at, -1);
  do {
    // Markdown parses the inner [label] of [[label]] as a shortcut link.
    // Keep that notation available while excluding actual link destinations.
    if (
      /Code|HTML|Image|URL/.test(node.name) ||
      (node.name === "Link" && node.getChild("URL"))
    )
      return null;
    if (!node.parent) break;
    node = node.parent;
  } while (true);
  const from = line.from + match.index;
  const to = at + (state.doc.sliceString(at, at + 2) === "]]" ? 2 : 0);
  return {
    from,
    to,
    text: state.doc.sliceString(from, to),
    query: match[1].trim(),
  };
}

export function searchPapers(papers: readonly Paper[], query: string): Paper[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const score = (paper: Paper) => {
    const title = paper.title.toLocaleLowerCase();
    const corpus = [
      title,
      ...paper.authors,
      paper.year ?? "",
      paper.doi,
      paper.arxivId,
    ]
      .join(" ")
      .toLocaleLowerCase();
    if (!words.every((word) => corpus.includes(word))) return -1;
    return title.startsWith(query.toLocaleLowerCase().trim()) && words.length
      ? 12
      : 0;
  };
  return papers
    .map((paper) => ({ paper, score: score(paper) }))
    .filter((entry) => entry.score >= 0)
    .sort(
      (a, b) =>
        b.score - a.score || b.paper.updatedAt.localeCompare(a.paper.updatedAt),
    )
    .map((entry) => entry.paper);
}

export function paperInsertion(
  state: EditorState,
  paper: Paper,
  target?: PaperTrigger | null,
): TransactionSpec {
  const valid =
    target &&
    target.from >= 0 &&
    target.to >= target.from &&
    target.to <= state.doc.length &&
    state.doc.sliceString(target.from, target.to) === target.text;
  const from = valid ? target.from : state.selection.main.head;
  const to = valid ? target.to : from;
  const text = paperMarkdown(paper);
  return {
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
    userEvent: "input.complete",
  };
}

export function insertPaperAt(
  view: EditorView,
  paper: Paper,
  target?: PaperTrigger | null,
) {
  view.dispatch(paperInsertion(view.state, paper, target));
  view.focus();
}

export function paperCompletion(options: {
  papers: () => readonly Paper[];
  addPaper: (query: string, trigger: PaperTrigger) => void;
  canAdd: () => boolean;
}) {
  const source: CompletionSource = (context) => {
    const trigger = paperTrigger(context.state, context.pos);
    if (!trigger) return null;
    const matches = searchPapers(options.papers(), trigger.query).slice(0, 30);
    const choices: Completion[] = matches.map((paper) => ({
      label: paper.title,
      detail: [
        paper.year,
        paper.authors.slice(0, 2).join(", "),
      ]
        .filter(Boolean)
        .join(" · "),
      apply: (view, completion) => {
        const current = paperTrigger(
          view.state,
          view.state.selection.main.head,
        );
        if (!current) return;
        const text = paperMarkdown(paper);
        view.dispatch({
          changes: { from: current.from, to: current.to, insert: text },
          selection: { anchor: current.from + text.length },
          annotations: pickedCompletion.of(completion),
          userEvent: "input.complete",
        });
      },
    }));
    if (options.canAdd())
      choices.push({
        label: "添加文献并引用…",
        detail: trigger.query
          ? `搜索或新建：${trigger.query}`
          : "通过 DOI、arXiv、URL 或 PDF 添加",
        apply: (view) => {
          const current = paperTrigger(
            view.state,
            view.state.selection.main.head,
          );
          if (!current) return;
          closeCompletion(view);
          options.addPaper(current.query, current);
        },
      });
    if (!choices.length)
      choices.push({
        label: "未找到文献",
        detail: "请先将文献加入文献库",
        apply: () => {},
      });
    return {
      from: trigger.from,
      to: context.pos,
      options: choices,
      filter: false,
    };
  };
  return autocompletion({
    override: [source],
    activateOnTypingDelay: 0,
    interactionDelay: 0,
    icons: false,
    maxRenderedOptions: 15,
    tooltipClass: () => "paper-completion",
  });
}
