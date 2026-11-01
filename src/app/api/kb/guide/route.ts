import { z } from "zod";
import { guideAction, guideActionSchema, guideJobs } from "@/lib/guide/engine";
import { assertLocalRequest, errorResponse, readJson } from "@/lib/security";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const paperId = z
      .string()
      .uuid()
      .parse(new URL(request.url).searchParams.get("paperId"));
    return Response.json(
      { jobs: guideJobs(paperId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    return Response.json(
      {
        job: guideAction(
          guideActionSchema.parse(await readJson(request, 20000)),
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
