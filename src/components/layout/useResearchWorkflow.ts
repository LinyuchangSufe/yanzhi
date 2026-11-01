"use client";
import { useRef, useState, type RefObject } from "react";
import type { KBState, Note } from "../../lib/types";
import type { ExternalDiscussion, ExternalDiscussionContext } from "../../lib/codex-import/types";
import type { ResearchItem, ResearchItemDraft } from "../../lib/research-items/types";
import type { IdeaSourceDraft } from "../../lib/idea-lab/types";
import { researchItemMarkdown } from "../../lib/research-items/client";
import { researchItemDiscussionDraft } from "../../lib/research-discussion";
import { ideaDiscussionClient } from "../ideas/idea-client";
import { prepareIdeaMaterials } from "../ideas/idea-materials";
import type { Dialog, View } from "../WorkspaceShared";
import { errorMessage, linked } from "../WorkspaceShared";

type Context = Partial<ExternalDiscussionContext>;
interface Options {
  stateRef: RefObject<KBState | null>; activeNote?: Note; topicId?: string;
  leaveEditor: () => Promise<boolean>;
  createIdea: (title: string, body?: string, paperIds?: string[], topicIds?: string[]) => Promise<Note | undefined>;
  navigate: (view: View) => Promise<boolean>;
  setError: (message: string) => void; setMessage: (message: string) => void;
  setDialog: (dialog: Dialog) => void;
}

/** Cross-page actions prepare an explicit draft; only the composer can start AI. */
export function useResearchWorkflow(options: Options) {
  const [codexImportContext, setCodexImportContext] = useState<Context | null>(null);
  const [researchItemDraft, setResearchItemDraft] = useState<ResearchItemDraft | null>(null);
  const handingOff = useRef(false);
  const openResearchItem = (draft: ResearchItemDraft, context: Context = {}) => {
    const state = options.stateRef.current;
    const related = state?.topics.filter(topic => context.topicIds?.includes(topic.id) ||
      context.paperIds?.some(id => linked(state, "paper", id, "topic", topic.id)) ||
      (options.activeNote && linked(state, "note", options.activeNote.id, "topic", topic.id))) ?? [];
    setResearchItemDraft({ ...draft, topicId: draft.topicId || options.topicId || (related.length === 1 ? related[0].id : undefined) });
  };
  const discussSources = async (input: IdeaSourceDraft, context: Context = {}) => {
    if (handingOff.current) return;
    handingOff.current = true;
    try {
      if (!(await options.leaveEditor())) return;
      const state = options.stateRef.current;
      if (!state) return;
      if ((input.prompt?.length ?? 0) > 12000) throw new Error("问题与依据快照超过 12,000 字符，请先精简条目或选择更少的资料；原记录保留，尚未发送。");
      let note = options.activeNote?.purpose === "idea" ? state.notes.find(item => item.id === options.activeNote!.id) : undefined;
      const preview = prepareIdeaMaterials(state, note?.id ?? "", input.sources);
      if (preview.length > 8 || preview.reduce((size, source) => size + source.text.length, 0) > 24000)
        throw new Error("所选资料超过 8 项或 24,000 字符，请先缩小范围；尚未创建讨论或发送。");
      if (!note) note = await options.createIdea(input.title || "资料推敲", "", context.paperIds ?? [], context.topicIds ?? []);
      if (!note) throw new Error("未能确认想法笔记，请重试。");
      const client = ideaDiscussionClient(note.id);
      if (!client.prepareFromSources(options.stateRef.current!, input.sources, input.prompt))
        throw new Error(client.getSnapshot().error || client.getSnapshot().storageError || "讨论草稿未能保存，请重试。");
      if (await options.navigate({ kind: "note", id: note.id })) {
        options.setError(""); options.setMessage("问题和所选资料已放入讨论框，核对后发送。");
      }
    } catch (error) { options.setError(errorMessage(error)); }
    finally { handingOff.current = false; }
  };
  const discussExternal = (discussion: ExternalDiscussion) => discussSources({
    title: discussion.title,
    sources: [{ type: "externalDiscussion", id: discussion.id, revision: discussion.revision, field: "body" }],
    prompt: "请基于这段所选 Codex 讨论，梳理已知结论、尚待核验的假设和下一步研究问题。AI 回复仍需核验。",
  }, discussion);
  const discussResearchItem = (item: ResearchItem) => {
    try { return discussSources(researchItemDiscussionDraft(item), { topicIds: [item.topicId] }); }
    catch (error) { options.setError(errorMessage(error)); }
  };
  const writeResearchItemToNote = (item: ResearchItem) => {
    const state = options.stateRef.current;
    const topic = state?.topics.find(topic => topic.id === item.topicId);
    if (!topic || !state?.notes.some(note => note.id === topic.noteId)) { options.setError("归属研究问题的综合笔记不存在，请先检查条目归属。"); return; }
    options.setDialog({ kind: "insert", noteId: topic.noteId, text: researchItemMarkdown(item) });
  };
  return { codexImportContext, researchItemDraft, openResearchItem,
    openCodexImporter: (context: Context = {}) => setCodexImportContext(context),
    closeCodexImporter: () => setCodexImportContext(null), closeResearchItem: () => setResearchItemDraft(null),
    discussSources, discussExternal, discussResearchItem, writeResearchItemToNote };
}
