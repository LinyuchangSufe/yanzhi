import { lookupMetadata, metadataLookupSchema } from "@/lib/import/enrichment";
import { assertLocalRequest, errorResponse, readJson } from "@/lib/security";
import { StoreError } from "@/lib/store-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || ""))
      throw new StoreError("请使用 JSON 请求", 415);
    const input = metadataLookupSchema.parse(await readJson(request, 10000));
    const result = await lookupMetadata(input, undefined, request.signal);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
