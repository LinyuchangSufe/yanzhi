import { getStore, StoreError } from "../../../../lib/db";
import {
  addNoteImage,
  MAX_NOTE_IMAGE_BYTES,
  readNoteImage,
} from "../../../../lib/note-images";
import { assertLocalRequest, errorResponse } from "../../../../lib/security";
import { uuid } from "../../../../lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const id = uuid.parse(new URL(request.url).searchParams.get("id"));
    const { image, bytes } = readNoteImage(getStore(), id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": image.mimeType,
        "Content-Disposition": `inline; filename="image"; filename*=UTF-8''${encodeURIComponent(image.filename)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    if (!request.headers.get("content-type")?.includes("multipart/form-data"))
      throw new StoreError("请通过文件上传提交图片", 415);
    const limit = MAX_NOTE_IMAGE_BYTES + 64 * 1024;
    if (Number(request.headers.get("content-length")) > limit)
      throw new StoreError("图片不得超过 10 MiB", 413);
    const reader = request.body?.getReader();
    if (!reader) throw new StoreError("请求正文为空", 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new StoreError("图片不得超过 10 MiB", 413);
      }
      chunks.push(value);
    }
    const form = await new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: new Uint8Array(Buffer.concat(chunks)),
    }).formData();
    if (
      Array.from(form.keys()).some(
        (key) => !["noteId", "file"].includes(key),
      ) ||
      form.getAll("noteId").length !== 1 ||
      form.getAll("file").length !== 1
    )
      throw new StoreError("图片上传字段无效", 400);
    const noteId = uuid.parse(form.get("noteId"));
    const file = form.get("file");
    if (!(file instanceof File)) throw new StoreError("缺少图片文件", 400);
    if (file.size > MAX_NOTE_IMAGE_BYTES)
      throw new StoreError("图片不得超过 10 MiB", 413);
    const store = getStore();
    const result = addNoteImage(
      store,
      noteId,
      file.name,
      new Uint8Array(await file.arrayBuffer()),
    );
    return Response.json(
      { result, state: store.snapshot() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
