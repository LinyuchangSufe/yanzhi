import { z } from "zod";
import { getStore } from "@/lib/db";
import { exportMarkdown } from "@/lib/archive";
import { exportNoteBundle } from "@/lib/note-export";
import { assertLocalRequest, errorResponse } from "@/lib/security";
import { uuid } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const querySchema = z
  .object({
    noteId: uuid.optional(),
    format: z.enum(["markdown", "bundle"]).default("markdown"),
  })
  .strict();

export function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const parameters = new URL(request.url).searchParams;
    for (const key of parameters.keys())
      if (parameters.getAll(key).length !== 1)
        throw Object.assign(new Error("导出参数不能重复"), { status: 400 });
    const { noteId, format } = querySchema.parse(
      Object.fromEntries(parameters),
    );
    const store = getStore();
    if (format === "bundle") {
      const bytes = exportNoteBundle(store, noteId);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": "attachment; filename=research-notes.tar.gz",
          "Cache-Control": "no-store",
        },
      });
    }
    return new Response(exportMarkdown(store.snapshot(), noteId), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": "attachment; filename=research-notes.md",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
