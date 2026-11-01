import { readFileSync } from "node:fs";
import { getStore, StoreError } from "../../../../lib/db";
import { uuid } from "../../../../lib/validation";
import { assertLocalRequest, errorResponse } from "../../../../lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const id = uuid.parse(new URL(request.url).searchParams.get("id"));
    const store = getStore();
    const filename =
      store.snapshot().attachments.find((a) => a.id === id)?.filename ??
      "paper.pdf";
    return new Response(
      new Uint8Array(readFileSync(store.attachmentPath(id))),
      {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="paper.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    if (!request.headers.get("content-type")?.includes("multipart/form-data"))
      throw new StoreError("请通过文件上传提交PDF", 415);
    const reader = request.body?.getReader();
    if (!reader) throw new StoreError("请求正文为空");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 101 * 1024 * 1024) {
        await reader.cancel();
        throw new StoreError("PDF超过100 MiB", 413);
      }
      chunks.push(value);
    }
    const body = new Uint8Array(Buffer.concat(chunks));
    const form = await new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body,
    }).formData();
    const paperId = uuid.parse(form.get("paperId"));
    const file = form.get("file");
    if (!(file instanceof File)) throw new StoreError("缺少PDF文件");
    const store = getStore();
    const result = store.addAttachment(
      paperId,
      file.name,
      new Uint8Array(await file.arrayBuffer()),
    );
    return Response.json(
      { state: store.snapshot(), result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
