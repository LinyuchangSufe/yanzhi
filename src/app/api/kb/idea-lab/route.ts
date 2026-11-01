import { z } from "zod";
import { getStore } from "@/lib/db";
import { StoreError } from "@/lib/store-error";
import { assertLocalRequest, errorResponse, readJson } from "@/lib/security";
import { publicPaperChatConfiguration } from "@/lib/paper-chat/configuration";
import { ideaSendRequestSchema, ideaSummaryRequestSchema } from "@/lib/idea-lab/schemas";
import { expireIdeaLeases, ideaConversationSnapshot, ideaSummarySnapshot, requireIdeaNote } from "@/lib/idea-lab/store";
import { runIdeaChat, summarizeIdea, type IdeaChatStreamEvent } from "@/lib/idea-lab/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };
const postSchema = z.object({ action: z.enum(["send", "summarize"]) }).passthrough();

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const noteId = z.string().uuid().parse(new URL(request.url).searchParams.get("noteId"));
    const store = getStore(); requireIdeaNote(store, noteId); expireIdeaLeases(store);
    return Response.json({ conversations: ideaConversationSnapshot(store, noteId), summaries: ideaSummarySnapshot(store, noteId),
      configuration: publicPaperChatConfiguration() }, { headers: noStore });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    if (!request.headers.get("content-type")?.includes("application/json")) throw new StoreError("需要 JSON 请求", 415);
    const input = postSchema.parse(await readJson(request, 90000));
    const { action, ...payload } = input;
    if (action === "summarize") return Response.json({ summary: await summarizeIdea(ideaSummaryRequestSchema.parse(payload), request.signal) }, { headers: noStore });
    const send = ideaSendRequestSchema.parse(payload);
    const store = getStore(); requireIdeaNote(store, send.noteId);
    const abort = new AbortController(), signal = AbortSignal.any([request.signal, abort.signal]);
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: IdeaChatStreamEvent) => {
          if (!closed && !signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        void runIdeaChat(send, emit, signal, store).catch((error: unknown) => {
          const value = error as { status?: number; message?: string };
          emit({ type: "error", message: value.status ? value.message || "讨论生成失败" : "讨论生成失败，请重试", status: value.status || 500 });
        }).finally(() => { if (!closed) { closed = true; controller.close(); } });
      },
      cancel() { closed = true; abort.abort(); },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
  } catch (error) { return errorResponse(error); }
}
