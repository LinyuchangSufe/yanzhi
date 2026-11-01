import { z } from "zod";
import { resolveMetadata, attachFromSource } from "@/lib/import/metadata";
import { getStore } from "@/lib/db";
import { assertLocalRequest, errorResponse, readJson } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const schema = z.object({
  source: z.string().trim().min(1).max(4000),
  paperId: z.string().uuid().optional(),
  downloadPdf: z.boolean().default(false),
}).strict();

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
      throw Object.assign(new Error("请发送 JSON 请求"), { status: 415 });
    const input = schema.parse(await readJson(request, 10000));
    if (input.downloadPdf) {
      if (!input.paperId) throw Object.assign(new Error("请先保存文献档案"), { status: 400 });
      // A saved source can be downloaded without a second metadata lookup.
      const result = await attachFromSource(input.paperId, input.source, { signal: request.signal });
      return Response.json({ result, warnings: [], state: getStore().snapshot() }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json(await resolveMetadata(input.source), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
