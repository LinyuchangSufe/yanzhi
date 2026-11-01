import { z } from "zod";

const uuid = z.string().uuid();
const text = z.string().max(2_000_000);
const title = z.string().min(1).max(1000);
const revision = z.number().int().positive();
const sourceId = z.string().min(1).max(300);
export const noteAssistSelectionSchema = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    text: text.min(1),
  })
  .strict()
  .refine(
    (s) => s.to > s.from && s.to - s.from === s.text.length,
    "选段范围与原文不一致",
  );
export const noteAssistResultSchema = z
  .object({
    overview: text,
    edits: z
      .array(
        z
          .object({
            before: text.min(1),
            after: text,
            reason: z.string().min(1).max(20000),
          })
          .strict(),
      )
      .max(100),
    suggestions: z
      .array(
        z
          .object({
            title,
            body: text.min(1),
            basis: z.enum(["note", "literature", "hypothesis"]),
            evidenceIds: z.array(sourceId).max(500),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const noteAssistanceSchema = z
  .object({
    id: uuid,
    noteId: uuid,
    mode: z.enum(["polish", "structure", "advise"]),
    baseRevision: revision,
    baseTitle: title,
    baseBody: text,
    selection: noteAssistSelectionSchema.nullable(),
    paperIds: z.array(uuid).max(100),
    ideaIds: z.array(uuid).max(100),
    sources: z
      .array(
        z
          .object({
            id: sourceId,
            kind: z.enum([
              "note",
              "topic",
              "idea",
              "paper-abstract",
              "pdf-evidence",
            ]),
            title,
            text,
            noteId: uuid.optional(),
            paperId: uuid.optional(),
            attachmentId: uuid.optional(),
            attachmentSha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            pageIndex: z.number().int().nonnegative().max(100000).optional(),
            pageLabel: z.string().max(100).optional(),
          })
          .strict(),
      )
      .max(500),
    result: noteAssistResultSchema,
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(500),
    appliedEdits: z.array(z.number().int().nonnegative().max(99)).max(100),
    lastAppliedRevision: revision,
    createdAt: z.iso.datetime(),
  })
  .strict();
export const noteRevisionSchema = z
  .object({
    id: uuid,
    noteId: uuid,
    noteRevision: revision,
    title,
    body: text,
    reason: z.enum(["ai-start", "before-apply", "before-restore", "manual"]),
    createdAt: z.iso.datetime(),
  })
  .strict();
export const noteAssistApplySchema = z
  .object({
    noteId: uuid,
    revision,
    assistanceId: uuid,
    operation: z.enum(["edit", "all", "insert"]),
    editIndex: z.number().int().nonnegative().max(99).optional(),
    suggestionIndex: z.number().int().nonnegative().max(99).optional(),
    position: z.number().int().nonnegative().max(2_000_000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.operation === "edit"
        ? v.editIndex === undefined ||
          v.suggestionIndex !== undefined ||
          v.position !== undefined
        : v.operation === "insert"
          ? v.suggestionIndex === undefined || v.editIndex !== undefined
          : v.editIndex !== undefined ||
            v.suggestionIndex !== undefined ||
            v.position !== undefined
    )
      ctx.addIssue({ code: "custom", message: "采纳操作参数无效" });
  });
export const noteRevisionRestoreSchema = z
  .object({ noteId: uuid, revision, snapshotId: uuid })
  .strict();
export const recordSchemas = {
  assistance: noteAssistanceSchema,
  revision: noteRevisionSchema,
};
