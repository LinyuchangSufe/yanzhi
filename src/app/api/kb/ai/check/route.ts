import { z } from "zod";
import { StoreError } from "../../../../../lib/db";
import { testCodexConnection } from "../../../../../lib/ai/codex-check";
import {
  assertLocalRequest,
  errorResponse,
  readJson,
} from "../../../../../lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 75;

const checkSchema = z
  .object({
    provider: z.literal("codex"),
    model: z.string().trim().max(300).default(""),
  })
  .strict();

// POST deliberately prevents page loads and passive status checks from running a model.
export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    if (!request.headers.get("content-type")?.includes("application/json"))
      throw new StoreError("需要 JSON 请求", 415);
    const input = checkSchema.parse(await readJson(request, 4096));
    const codexStatus = await testCodexConnection({
      model: process.env.KB_CODEX_MODEL || input.model,
      signal: request.signal,
    });
    return Response.json(
      { codexStatus },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
