import { aiConfiguration, generationSchema, generateAI } from "@/lib/ai";
import { getStore } from "@/lib/db";
import { assertLocalRequest, errorResponse, readJson } from "@/lib/security";
import { checkCodex } from "@/lib/ai/codex";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const configuration = aiConfiguration();
    const check = new URL(request.url).searchParams.get("check") === "codex";
    return Response.json(
      {
        ...configuration,
        ...(check ? { codexStatus: await checkCodex(request.signal) } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const input = generationSchema.parse(await readJson(request, 100000));
    const result = await generateAI(input, request.signal);
    return Response.json({ state: getStore().snapshot(), result });
  } catch (error) {
    return errorResponse(error);
  }
}
