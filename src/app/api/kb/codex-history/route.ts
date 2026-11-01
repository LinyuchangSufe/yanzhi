import { getStore } from "@/lib/db";
import { createCodexHistoryHandlers } from "@/lib/codex-import/handlers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const { GET, POST } = createCodexHistoryHandlers({ getStore });
