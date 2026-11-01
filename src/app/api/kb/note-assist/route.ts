import { z } from "zod";
import { aiConfiguration } from "@/lib/ai";
import { getStore, StoreError } from "@/lib/db";
import { getNoteAssistContext } from "@/lib/note-assist/context";
import {
  generateNoteAssistance,
  generationSchema,
} from "@/lib/note-assist/engine";
import { assertLocalRequest, errorResponse, readJson } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const noteId = z
      .string()
      .uuid()
      .parse(new URL(request.url).searchParams.get("noteId"));
    const store = getStore();
    const context = getNoteAssistContext(store, noteId);
    const state = store.snapshot();
    return Response.json(
      {
        assists: (state.noteAssists ?? []).filter(
          (item) => item.noteId === noteId,
        ),
        revisions: (state.noteRevisions ?? []).filter(
          (item) => item.noteId === noteId,
        ),
        context,
        configuration: aiConfiguration(),
      },
      { headers: noStore },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    if (!request.headers.get("content-type")?.includes("application/json"))
      throw new StoreError("需要 JSON 请求", 415);
    const input = generationSchema.parse(await readJson(request, 200000));
    const result = await generateNoteAssistance(input, request.signal);
    return Response.json({ result }, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
