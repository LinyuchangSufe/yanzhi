import { useCallback, useEffect, useRef, useState } from "react";
import { PaperAIRequest, type PaperAIKind, type PaperAITask } from "../../lib/paper-ai-task";
import type { AIContent, Paper } from "../../lib/types";
import type { PdfSelection } from "../pdf/types";
import { publishLibraryChange } from "../../lib/editor/library-events";
import { readResponse } from "../WorkspaceShared";

export function usePaperAI(refresh: () => Promise<void>) {
  const [task, setTask] = useState<PaperAITask | null>(null);
  const [result, setResult] = useState<AIContent | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  const client = useRef<PaperAIRequest | null>(null);
  if (!client.current) client.current = new PaperAIRequest({
    run: async (input, signal) => {
      const response: { result: AIContent } = await readResponse(await fetch("/api/kb/ai", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input), signal,
      }));
      return response.result;
    },
    onTask: setTask,
    onResult: (next) => {
      setResult(next);
      publishLibraryChange();
      void latestRefresh.current();
    },
  });
  useEffect(() => () => client.current?.dispose(), []);
  const start = useCallback(async (paper: Paper, kind: PaperAIKind, selection?: PdfSelection, force = false) => {
    setCollapsed(false);
    return client.current!.start(paper, kind, selection, force);
  }, []);
  const cancel = useCallback(() => {
    client.current?.cancel();
    void latestRefresh.current();
  }, []);
  const dismiss = useCallback(() => client.current?.dismiss(), []);
  const showSaved = useCallback((paper: Paper, saved: AIContent) => {
    const shown = client.current!.showSaved(paper, saved);
    if (shown) setCollapsed(false);
    return shown;
  }, []);
  return { task, result, collapsed, setCollapsed, start, cancel, dismiss, showSaved };
}
