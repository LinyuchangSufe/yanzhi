import type { AIContent, Attachment, Paper } from "../types";

/** Check references against authoritative records, not labels supplied by a model/archive. */
export function validateGuideSources<T extends Pick<AIContent, "guideData">>(
  content: T,
  paper: (id: string) => Paper,
  attachment: (id: string) => Attachment,
): T {
  if (!content.guideData) return content;
  const sources = content.guideData.sources.map((source) => {
    const currentPaper = paper(source.paperId);
    const currentAttachment = attachment(source.attachmentId);
    if (
      currentAttachment.paperId !== source.paperId ||
      currentAttachment.sha256 !== source.attachmentSha256 ||
      currentAttachment.filename !== source.filename
    )
      throw new Error("导读来源与文献、附件指纹或文件名不一致");
    // A later metadata correction must not make a legitimate historical guide unrestorable.
    return { ...source, paperTitle: currentPaper.title };
  });
  return { ...content, guideData: { ...content.guideData, sources } };
}
