"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { registerLeaveGuard } from "../../lib/editor/pending-edits";
import { ideaDiscussionClient } from "./idea-client";

export function useIdeaDiscussion(noteId: string) {
  const client = useMemo(() => ideaDiscussionClient(noteId), [noteId]);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getServerSnapshot);
  useEffect(() => { void client.load(); }, [client]);
  useEffect(() => registerLeaveGuard(client.persist), [client]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      const current = client.getSnapshot();
      if (!current.draft && !current.materials.length && !current.running && !current.summarizing) return;
      client.persist(); event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [client]);
  return { client, ...state };
}
