"use client";
import { ArrowLeft, FileText, FolderOpen } from "lucide-react";
import type { WorkspaceController } from "./Workspace";
import baseStyles from "./Workspace.module.css";
import { Empty } from "./WorkspaceDialogs";
import { linked } from "./WorkspaceShared";
import contentStyles from "./styles/WorkspaceContent.module.css";
import pageStyles from "./styles/ResearchPages.module.css";
import IdeaWorkspace from "./ideas/IdeaWorkspace";
import ObjectActions from "./menus/ObjectActions";
import CodexImportPanel, { ExternalDiscussionView } from "./codex-import/CodexImportPanel";
import ResearchItemsPanel from "./research-items/ResearchItemsPanel";
import type { ExternalDiscussion } from "../lib/codex-import/types";
const styles = { ...baseStyles, ...contentStyles, ...pageStyles };

export function ResearchPages({ c }: { c: WorkspaceController }) {
  const { state, view, paper, topic, activeNote, ideas, sourceLists, editorFor, setDialog, safeMutate, leaveEditor, navigate, createIdea } = c;
  const editingWithAI = Boolean(activeNote && c.assistNoteId === activeNote.id);
  const papers = topic ? state.papers.filter((item) => !item.deletedAt && linked(state, "paper", item.id, "topic", topic.id)) : [];
  const relatedIdeas = topic ? ideas.filter((item) => linked(state, "note", item.id, "topic", topic.id)) : [];
  const discussions = state.externalDiscussions ?? [];
  const discussion = view.kind === "discussion" ? discussions.find((item) => item.id === view.id) : undefined;
  const topicDiscussions = topic ? discussions.filter((item) => item.topicIds.includes(topic.id)) : [];
  const findDiscussionPaper = (query: string | undefined, item: ExternalDiscussion) => c.openLiterature(query, item.paperIds.length
    ? { paperIds: item.paperIds } : item.noteIds.length === 1 ? { noteId: item.noteIds[0] } : {});
  const refreshImported = async () => { await c.refresh(); };
  return <>
    {view.kind === "home" && c.section === "discussions" && <div className={styles.detailPage}>
      <div className={styles.pageHeading}><h1>Codex 讨论</h1></div>
      <CodexImportPanel discussions={discussions} onChanged={refreshImported} onFindPaper={findDiscussionPaper} onDiscuss={(item) => void c.discussExternal(item)} title="已导入的讨论资料" />
    </div>}
    {discussion && <div className={styles.detailPage}>
      <button className={styles.back} onClick={() => void c.chooseSection("discussions")}><ArrowLeft size={15} />Codex 讨论</button>
      <ExternalDiscussionView key={discussion.id} discussion={discussion} onChanged={refreshImported} onFindPaper={(query) => findDiscussionPaper(query, discussion)} onDiscuss={(item) => void c.discussExternal(item)} />
    </div>}
    {topic && <div className={styles.detailPage}>
      <button className={styles.back} onClick={() => void c.chooseSection("topics")}><ArrowLeft size={15} />研究问题</button>
      <div className={styles.titleRow}><h1>{topic.title}</h1>
        <ObjectActions label="研究问题操作" actions={[
          { label: "编辑研究问题", onSelect: () => setDialog({ kind: "topic", topic }) },
          { label: "删除研究问题", danger: true, onSelect: async () => {
            if (!(await leaveEditor())) return;
            if (!window.confirm("删除此研究问题？关联文献和想法不会删除，综合笔记将移入我的想法。")) return;
            if (await safeMutate("topic.delete", { id: topic.id })) await c.chooseSection("topics");
          } },
        ]} />
      </div>
      {topic.description && <p className={styles.description}>{topic.description}</p>}
      <div className={`${styles.topicColumns} ${editingWithAI ? styles.topicColumnsAssist : ""}`}>
        <div className={styles.topicNote}>{activeNote && editorFor(activeNote)}
        <ResearchItemsPanel state={state} topicId={topic.id} onChanged={c.refresh}
          onNavigate={(href) => void c.navigateLink(href)}
          onDiscuss={(item) => void c.discussResearchItem(item)}
          onWriteToNote={(item) => void c.writeResearchItemToNote(item)}
          onOpenExternal={(id) => void navigate({ kind: "discussion", id })}
          focusItemId={c.focusResearchItemId} />
        </div>
        <aside className={styles.relatedPanel}>
          <details className={styles.relatedFold}>
            <summary>关联材料 <span>{papers.length} 篇论文 · {relatedIdeas.length} 个想法{topicDiscussions.length > 0 ? ` · ${topicDiscussions.length} 份 Codex 讨论` : ""}</span></summary>
            <div>
              <div className={styles.sectionHeading}><h3>论文与想法</h3>
                <button onClick={() => setDialog({ kind: "links", type: "topic", id: topic.id })}>管理关联材料</button></div>
              {papers.map((item) => <div key={item.id} className={styles.relatedItem}><button onClick={() => void navigate({ kind: "paper", id: item.id })}><FileText size={15} />{item.title}</button></div>)}
              {!papers.length && <p className={styles.muted}>尚未关联论文，可从资料库中选择。</p>}
              <div className={styles.sectionHeading}><h3>相关想法</h3><button onClick={async () => {
                if (!(await leaveEditor())) return;
                const note = await createIdea("新的研究想法", "", [], [topic.id]);
                if (note) await navigate({ kind: "note", id: note.id });
              }}>新建关联想法</button></div>
              {relatedIdeas.map((item) => <div key={item.id} className={styles.relatedItem}><button onClick={() => void navigate({ kind: "note", id: item.id })}>{item.title}</button></div>)}
              {!relatedIdeas.length && <p className={styles.muted}>把正在发展的想法放到这个研究问题下。</p>}
              <p className={styles.muted}>关联只用于组织材料，不会自动交给 AI。管理关联时选择即保存。</p>
              <CodexImportPanel context={{ topicIds: [topic.id] }} discussions={discussions} onChanged={refreshImported} onFindPaper={findDiscussionPaper} onDiscuss={(item) => void c.discussExternal(item)} />
              {sourceLists("topic", topic.id)}
            </div>
          </details>
        </aside>
      </div>
    </div>}
    {view.kind === "note" && activeNote?.purpose === "idea" && <IdeaWorkspace key={activeNote.id} note={activeNote} c={c} onImportCodex={() => c.openCodexImporter({ noteIds: [activeNote.id] })} />}
    {view.kind === "note" && activeNote && activeNote.purpose !== "idea" && <div className={styles.detailPage}>
      <button className={styles.back} onClick={() => void c.chooseSection("ideas")}><ArrowLeft size={15} />我的想法</button>
      <div className={styles.pageHeading}><h1>{activeNote.title || "研究笔记"}</h1></div>
      <div className={`${styles.ideaEditor} ${editingWithAI ? styles.ideaEditorAssist : ""}`}>{editorFor(activeNote)}</div>
      <details className={styles.linkedObjects}><summary>关联材料与反向引用</summary>
        <button onClick={() => setDialog({ kind: "links", type: "note", id: activeNote.id })}>管理关联材料</button>
        {state.papers.filter((item) => !item.deletedAt && linked(state, "note", activeNote.id, "paper", item.id)).map((item) => <button key={item.id} onClick={() => void navigate({ kind: "paper", id: item.id })}><FileText size={14} />{item.title}</button>)}
        {state.topics.filter((item) => linked(state, "note", activeNote.id, "topic", item.id)).map((item) => <button key={item.id} onClick={() => void navigate({ kind: "topic", id: item.id })}><FolderOpen size={14} />{item.title}</button>)}
        {sourceLists("note", activeNote.id)}
      </details>
    </div>}
    {view.kind !== "home" && !paper && !topic && !activeNote && !discussion && <Empty title="内容不存在或尚未加载" text="可返回文献库检查原有内容和关联。" action="返回文献库" onAction={() => void navigate({ kind: "home" })} />}
  </>;
}
