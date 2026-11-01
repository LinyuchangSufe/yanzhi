import { z } from "zod";

export interface ChatProgress {
  startedAt: string;
  phase: "starting" | "connecting" | "waiting" | "thinking" | "responding" | "retrying";
  /** Latest actual provider/protocol activity, never a server heartbeat or UI tick. */
  lastActivityAt: string | null;
  heartbeatAt: string;
  /** null for HTTP providers where this app does not own the model process. */
  processRunning: boolean | null;
}

export const chatProgressSchema = z.object({
  startedAt: z.string().datetime(),
  phase: z.enum(["starting", "connecting", "waiting", "thinking", "responding", "retrying"]),
  lastActivityAt: z.string().datetime().nullable(),
  heartbeatAt: z.string().datetime(),
  processRunning: z.boolean().nullable(),
}).strict();
