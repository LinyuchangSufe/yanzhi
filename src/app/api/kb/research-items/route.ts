import { z } from "zod";
import { getStore } from "@/lib/db";
import { assertLocalRequest, errorResponse, readJson } from "@/lib/security";
import { StoreError } from "@/lib/store-error";
import { researchItemRequestSchema } from "@/lib/research-items/schemas";
import { initResearchItemSchema, mutateResearchItem, researchItemsSnapshot, requireResearchItem } from "@/lib/research-items/store";
import { resolveResearchSources } from "@/lib/research-items/sources";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export function GET(request: Request) {
  try {
    assertLocalRequest(request); const store = getStore(); initResearchItemSchema(store);
    const query = new URL(request.url).searchParams, raw = query.get("topicId"), topicId = raw ? z.string().uuid().parse(raw) : undefined;
    if (query.has("id")) return Response.json({ items: [requireResearchItem(store, z.string().uuid().parse(query.get("id")))] }, { headers });
    const items = researchItemsSnapshot(store, topicId).filter(item => query.get("archived") === "true" || !item.archivedAt);
    return Response.json({ items }, { headers });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    if (!request.headers.get("content-type")?.includes("application/json")) throw new StoreError("需要 JSON 请求", 415);
    const input = researchItemRequestSchema.parse(await readJson(request, 100000));
    const store = getStore(); initResearchItemSchema(store);
    if (input.action === "preview") return Response.json({ sources: resolveResearchSources(store, input.sourceRefs) }, { headers });
    const item = mutateResearchItem(store, input);
    return Response.json({ item, items: researchItemsSnapshot(store, item.topicId) }, { headers });
  } catch (error) { return errorResponse(error); }
}
