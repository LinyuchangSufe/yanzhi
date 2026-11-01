import type { KBState, SearchResult } from "./types";

export function searchState(state: KBState, query: string): SearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const deletedIds = new Set(
    state.papers.filter((p) => p.deletedAt).map((p) => p.id),
  );
  const out: SearchResult[] = [];
  const add = (result: Omit<SearchResult, "snippet">, content: string) => {
    const index = content.toLocaleLowerCase().indexOf(needle);
    if (index >= 0)
      out.push({
        ...result,
        snippet: `${index > 60 ? "…" : ""}${content.slice(Math.max(0, index - 60), index + needle.length + 110)}${index + needle.length + 110 < content.length ? "…" : ""}`,
      });
  };
  for (const p of state.papers) {
    if (deletedIds.has(p.id)) continue;
    const tagNames = state.relations
      .filter(
        (r) =>
          r.fromType === "paper" && r.fromId === p.id && r.toType === "tag",
      )
      .map((r) => state.tags.find((t) => t.id === r.toId)?.name ?? "");
    add(
      { type: "paper", id: p.id, title: p.title, paperId: p.id },
      [
        p.title,
        p.authors.join(" "),
        p.year,
        p.abstract,
        p.doi,
        p.arxivId,
        ...tagNames,
      ].join("\n"),
    );
  }
  for (const n of state.notes) {
    const owners = state.relations.filter(
      (r) =>
        r.fromType === "note" &&
        r.fromId === n.id &&
        r.toType === "paper" &&
        r.purpose === "manual",
    );
    if (
      n.purpose === "paper" &&
      owners.length &&
      owners.every((r) => deletedIds.has(r.toId))
    )
      continue;
    const paperId = state.relations.find(
      (r) =>
        r.fromType === "note" &&
        r.fromId === n.id &&
        r.toType === "paper" &&
        !deletedIds.has(r.toId) &&
        r.purpose === "manual",
    )?.toId;
    const topicId = state.topics.find((t) => t.noteId === n.id)?.id;
    add(
      {
        type: n.purpose === "idea" ? "idea" : "note",
        id: n.id,
        title: n.title,
        ...(paperId ? { paperId } : {}),
        ...(topicId ? { topicId } : {}),
      },
      `${n.title}\n${n.body}`,
    );
  }
  for (const a of state.annotations) {
    if (deletedIds.has(a.paperId)) continue;
    add(
      {
        type: "annotation",
        id: a.id,
        title: state.papers.find((p) => p.id === a.paperId)?.title ?? "批注",
        paperId: a.paperId,
        attachmentId: a.attachmentId,
      },
      `${a.selectedText}\n${a.comment}`,
    );
  }
  for (const t of state.topics)
    add(
      { type: "topic", id: t.id, title: t.title, topicId: t.id },
      `${t.title}\n${t.description}`,
    );
  for (const a of state.aiContents) {
    if (deletedIds.has(a.paperId)) continue;
    add(
      {
        type: "ai",
        id: a.id,
        title: state.papers.find((p) => p.id === a.paperId)?.title ?? "AI 内容",
        paperId: a.paperId,
      },
      a.body,
    );
  }
  for (const discussion of state.externalDiscussions ?? []) {
    if (discussion.paperIds.length && !discussion.topicIds.length && !discussion.noteIds.length &&
        discussion.paperIds.every((id) => deletedIds.has(id))) continue;
    add({ type: "discussion", id: discussion.id, title: discussion.title },
      `${discussion.title}\n${discussion.messages.map((message) => message.text).join("\n")}`);
  }
  for (const item of state.researchItems ?? []) {
    if (item.archivedAt) continue;
    add({ type: "research-item", id: item.id, title: item.title, topicId: item.topicId },
      `${item.title}\n${item.body}\n${item.nextAction}\n${item.resolution}`);
  }
  return out;
}
