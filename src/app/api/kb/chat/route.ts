import { z } from "zod";
import { getStore } from "@/lib/db";
import { assertLocalRequest, errorResponse, readJson } from "@/lib/security";
import { paperChatInputSchema, paperChatRenameSchema } from "@/lib/paper-chat/schemas";
import { expirePaperChatLeases, paperChatSnapshot, renamePaperChat, requireChatPaper } from "@/lib/paper-chat/store";
import { runPaperChat } from "@/lib/paper-chat/engine";
import { publicPaperChatConfiguration } from "@/lib/paper-chat/configuration";
import type { ChatStreamEvent } from "@/lib/paper-chat/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const paperId = z.string().uuid().parse(new URL(request.url).searchParams.get("paperId"));
    const store = getStore(); requireChatPaper(store, paperId); expirePaperChatLeases(store);
    return Response.json({conversations: paperChatSnapshot(store, paperId), configuration: publicPaperChatConfiguration()}, {headers: {"Cache-Control": "no-store"}});
  } catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request) {
  try {
    assertLocalRequest(request);
    const input = paperChatRenameSchema.parse(await readJson(request, 2000));
    return Response.json({conversation: renamePaperChat(getStore(), input)}, {headers: {"Cache-Control": "no-store"}});
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const input = paperChatInputSchema.parse(await readJson(request, 60000));
    const store = getStore(); requireChatPaper(store, input.paperId, input.attachmentId);
    const abort = new AbortController();
    const signal = AbortSignal.any([request.signal, abort.signal]);
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: ChatStreamEvent) => {
          if (!closed && !signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        void runPaperChat(input, emit, signal, store).catch((error: unknown) => {
          const value = error as {status?: number; message?: string};
          emit({type: "error", message: value.status ? value.message || "对话生成失败" : "对话生成失败，请重试", status: value.status || 500});
        }).finally(() => { if (!closed) { closed = true; controller.close(); } });
      },
      cancel() { closed = true; abort.abort(); },
    });
    return new Response(stream, {headers: {"Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"}});
  } catch (error) { return errorResponse(error); }
}
