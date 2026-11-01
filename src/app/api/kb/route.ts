import { getStore, StoreError } from "../../../lib/db";
import { requestSchema } from "../../../lib/validation";
import { assertLocalRequest, errorResponse, readJson } from "../../../lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const query = new URL(request.url).searchParams.get("q");
    if (query && query.length > 500) throw new StoreError("搜索词过长");
    return Response.json(getStore().snapshot(query ?? undefined), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    if (!request.headers.get("content-type")?.includes("application/json"))
      throw new StoreError("需要JSON请求", 415);
    const parsed = requestSchema.parse(await readJson(request,5*1024*1024));
    const store = getStore();
    const result = store.dispatch(parsed.action, parsed.payload);
    return Response.json(
      { state: store.snapshot(), result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
