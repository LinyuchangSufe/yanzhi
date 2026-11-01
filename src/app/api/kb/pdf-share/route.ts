import { z } from "zod";
import { getStore, StoreError } from "@/lib/db";
import { assertLocalRequest, errorResponse, readJson } from "@/lib/security";
import { uuid } from "@/lib/validation";
import { preparePDFShare } from "@/lib/pdf-share";
import { openPDFShareFolder } from "@/lib/pdf-share-open";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ paperId: uuid.optional(), open: z.boolean().default(false) }).strict();

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    // JSON POST plus explicit same-origin evidence prevents foreign pages opening Finder.
    // assertLocalRequest validates Origin against the loopback Host: Next may rebuild
    // request.url using localhost even when the browser accesses 127.0.0.1.
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if ((fetchSite && fetchSite !== "same-origin") || (!origin && fetchSite !== "same-origin"))
      throw new StoreError("仅允许知识库网页发起的同源操作。", 403);
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
      throw new StoreError("需要 JSON 请求。", 415);
    const { paperId, open } = schema.parse(await readJson(request, 4096));
    const prepared = preparePDFShare(getStore(), paperId);
    const result = open ? await openPDFShareFolder(prepared, { reveal: !!paperId }) : prepared;
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    return response.status === 500
      ? Response.json({ error: "无法整理 PDF 分享副本，请检查本地文件夹权限和剩余空间。原件未被修改。" }, { status: 500, headers: { "Cache-Control": "no-store" } })
      : response;
  }
}
