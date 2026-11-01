import { z } from "zod";

export const literatureContextSchema = z.object({
  paperIds: z.array(z.string().uuid()).max(16).refine(ids => new Set(ids).size === ids.length, "文献范围重复").optional(),
  noteId: z.string().uuid().optional(),
}).strict();
export const literatureSearchSchema = z.object({
  query: z.string().trim().min(2).max(4000), context: literatureContextSchema.optional(),
}).strict();
export const literatureImportSchema = z.object({
  candidateToken: z.string().min(1).max(200), context: literatureContextSchema.optional(), downloadPdf: z.boolean(),
}).strict();
export const literatureRequestSchema = z.discriminatedUnion("action", [
  literatureSearchSchema.extend({ action: z.literal("search") }),
  literatureImportSchema.extend({ action: z.literal("import") }),
]);
