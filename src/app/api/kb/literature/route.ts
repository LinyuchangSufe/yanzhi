import { literatureRequestSchema } from "@/lib/literature/schemas";
import { importLiterature, searchLiterature } from "@/lib/literature/service";
import { assertLocalRequest, errorResponse, readJson } from "@/lib/security";
import { StoreError } from "@/lib/store-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new StoreError("请使用 JSON 请求", 415);
    const input = literatureRequestSchema.parse(await readJson(request, 10000));
    const { action, ...payload } = input;
    const result = action === "search" ? await searchLiterature(payload as Parameters<typeof searchLiterature>[0], undefined, request.signal)
      : await importLiterature(payload as Parameters<typeof importLiterature>[0], undefined, request.signal);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error); response.headers.set("Cache-Control", "no-store"); return response;
  }
}
