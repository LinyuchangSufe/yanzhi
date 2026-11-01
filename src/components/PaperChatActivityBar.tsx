"use client";

import { LoaderCircle, MessageCircle, Square } from "lucide-react";
import { usePaperChatActivities } from "./PaperChatPanel";
import { getPaperChatClient } from "../lib/paper-chat/client";
import type { WorkspaceController } from "./Workspace";
import styles from "./PaperChatActivityBar.module.css";
import ChatRunStatus from "./ai/ChatRunStatus";

/** Keep streaming conversations reachable while browsing notes and other papers. */
export default function PaperChatActivityBar({ c }: { c: WorkspaceController }) {
  const activities = usePaperChatActivities();
  const visible = activities.filter((activity) => activity.paperId !== c.paper?.id ||
    c.tab !== "chat" || c.readingLayout.notesHidden);
  if (!visible.length) return null;
  return <aside className={styles.activities} aria-label="正在进行的论文对话">
    {visible.map((activity) => <div className={styles.activity} key={activity.paperId}>
      <LoaderCircle size={15} className={styles.spin} aria-hidden="true" />
      <div className={styles.info}>
        <strong>{activity.stopping ? "正在停止论文对话…" : "论文对话生成中"}</strong>
        <span title={activity.paperTitle}>{activity.paperTitle || "论文对话"}</span>
        {activity.startedAt && <ChatRunStatus startedAt={activity.startedAt} progress={activity.progress} compact />}
      </div>
      <button type="button" disabled={activity.stopping}
        onClick={() => getPaperChatClient(activity.paperId).stop()}>
        <Square size={12} />停止
      </button>
      <button type="button" onClick={() => {
        void c.navigate({ kind: "paper", id: activity.paperId }, "chat").then((opened) => {
          if (opened) {
            c.readingLayout.revealNotes();
            const client = getPaperChatClient(activity.paperId);
            if (!client.revealRunning() && activity.conversationId) client.select(activity.conversationId);
          }
        });
      }}><MessageCircle size={13} />查看</button>
    </div>)}
  </aside>;
}
