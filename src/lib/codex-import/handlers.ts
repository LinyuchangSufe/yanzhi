import { z } from "zod";
import type { KBStore } from "../db";
import { assertLocalRequest, errorResponse, readJson } from "../security";
import { StoreError } from "../store-error";
import { listCodexThreads, readCodexHistory } from "./bridge";
import { codexHistoryRequestSchema } from "./schemas";
import { codexHistoryHash, initCodexImportSchema, linkExternalDiscussion, refreshCodexDiscussion, requireExternalDiscussion, saveCodexDiscussion } from "./store";

const query = z.object({ threadId: z.string().min(1).max(300).optional(), cursor: z.string().max(4000).optional(), search: z.string().max(500).optional(), cwd: z.string().max(2000).optional() }).strict();
export function createCodexHistoryHandlers(deps: { getStore: () => KBStore; list?: typeof listCodexThreads; read?: typeof readCodexHistory }) {
  const list = deps.list ?? listCodexThreads, read = deps.read ?? readCodexHistory;
  const store = () => { const value = deps.getStore(); initCodexImportSchema(value); return value; };
  return {
    GET: async (request: Request): Promise<Response> => {
      try {
        assertLocalRequest(request);
        const input = query.parse(Object.fromEntries(new URL(request.url).searchParams));
        if (input.threadId) {
          const history = await read(input.threadId, request.signal);
          return Response.json({ ...history, historyHash: codexHistoryHash(history) }, { headers: { "Cache-Control": "no-store" } });
        }
        return Response.json(await list(input, request.signal), { headers: { "Cache-Control": "no-store" } });
      } catch (error) { return errorResponse(error); }
    },
    POST: async (request: Request): Promise<Response> => {
      try {
        assertLocalRequest(request);
        const input = codexHistoryRequestSchema.parse(await readJson(request, 128 * 1024));
        const target = store();
        if (input.action === "link") {
          const discussion = linkExternalDiscussion(target, input.id, input.revision, input.context);
          return Response.json({ discussion, state: target.snapshot() }, { headers: { "Cache-Control": "no-store" } });
        }
        const old = input.action === "refresh" ? requireExternalDiscussion(target, input.id) : null;
        if (input.action === "refresh" && old && old.revision !== input.revision) throw new StoreError("讨论资料已更新，请重新打开后刷新", 409);
        const history = await read(old?.threadId ?? (input.action === "import" ? input.threadId : ""), request.signal);
        if (request.signal.aborted) throw new StoreError("读取已取消，资料未改变", 499);
        if (input.action === "import") {
          if (history.source.id !== input.sourceId) throw new StoreError("Codex 主机或资料目录发生变化，请重新预览", 409);
          if (codexHistoryHash(history) !== input.historyHash) throw new StoreError("会话在预览后发生变化，请重新读取并核对轮次", 409);
          const result = saveCodexDiscussion(target, history, input.selectedTurnIds, input.context);
          return Response.json({ ...result, state: target.snapshot() }, { headers: { "Cache-Control": "no-store" } });
        }
        const result = refreshCodexDiscussion(target, input.id, input.revision, history);
        return Response.json({ ...result, state: target.snapshot() }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) { return errorResponse(error); }
    },
  };
}
