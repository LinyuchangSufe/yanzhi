import { aiConfiguration } from "@/lib/ai";
import { listModelOptions } from "@/lib/ai/model-options";
import { assertLocalRequest, errorResponse } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const config = aiConfiguration();
    try {
      const models = await listModelOptions(config, request.signal);
      return Response.json({ provider: config.provider, currentModel: config.model, models,
        ...(config.provider === "codex" ? { warning: "列表来自 Codex 返回的模型目录；实际可用性以调用结果为准。" } : {}),
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const value = error as { status?: number; message?: string };
      if (value.status === 499) throw error;
      return Response.json({ provider: config.provider, currentModel: config.model, models: [],
        warning: value.status ? value.message : "暂时无法读取模型列表，可手动填写模型 ID。",
      }, { headers: { "Cache-Control": "no-store" } });
    }
  } catch (error) { return errorResponse(error); }
}
