"use client";
import { useEffect, useSyncExternalStore } from "react";
import type { WorkspaceController } from "../Workspace";
import { getIdeaActivities, getServerIdeaActivities, ideaDiscussionClient, subscribeIdeaActivities } from "./idea-client";
import styles from "./IdeaWorkspace.module.css";
import ChatRunStatus from "../ai/ChatRunStatus";

function IdeaRunStatus({ noteId }: { noteId: string }) {
  const client = ideaDiscussionClient(noteId);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getServerSnapshot);
  return state.runStartedAt ? <ChatRunStatus compact startedAt={state.runStartedAt} progress={state.progress}
    label={state.summarizing ? "整理" : state.configuration?.provider === "codex" ? "Codex" : "AI"} /> : null;
}

export default function IdeaActivityBar({ c }: { c: WorkspaceController }) {
  const activities = useSyncExternalStore(subscribeIdeaActivities, getIdeaActivities, getServerIdeaActivities);
  useEffect(() => {
    const preserve = (event: BeforeUnloadEvent) => {
      if (!getIdeaActivities().length) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", preserve);
    return () => window.removeEventListener("beforeunload", preserve);
  }, []);
  const hidden = activities.filter((item) => c.view.kind !== "note" || c.view.id !== item.noteId);
  if (!hidden.length) return null;
  return <aside className={styles.activity} aria-label="进行中的想法讨论">
    {hidden.map((item) => <div key={item.noteId}>
      <span>{c.state.notes.find((note) => note.id === item.noteId)?.title || "想法"}<IdeaRunStatus noteId={item.noteId} /></span>
      <button type="button" onClick={() => void c.navigate({ kind: "note", id: item.noteId })}>返回想法讨论</button>
      <button type="button" onClick={() => ideaDiscussionClient(item.noteId).stop()}>停止</button>
    </div>)}
  </aside>;
}
