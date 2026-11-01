import type { z } from "zod";
import type { chatContextInputSchema, chatContextSchema } from "./context-schemas";

export type ChatContextInput = z.infer<typeof chatContextInputSchema>;
export type ChatContext = z.infer<typeof chatContextSchema>;
