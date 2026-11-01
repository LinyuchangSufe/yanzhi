import { createHash } from "node:crypto";
import type { KBStore } from "../db";
import { StoreError } from "../store-error";
import type { GuideData } from "../guide/types";
import { guideDataSchema } from "../validation";
import { resolveExternalDiscussionSource } from "../codex-import/store";
import { researchItemSourceSchema, researchSourceInputSchema } from "./schemas";
import type { ResearchItemSource, ResearchSourceInput } from "./types";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const researchSourceKey = (input: ResearchSourceInput) => hash(researchSourceInputSchema.parse(input));
export function researchSourceFingerprint(source: Omit<ResearchItemSource, "id" | "fingerprint" | "capturedAt">) {
  return hash({ input: source.input, title: source.title, text: source.text, sourceHref: source.sourceHref, origin: source.origin,
    paperId: source.paperId, attachmentId: source.attachmentId, attachmentSha256: source.attachmentSha256, pageIndex: source.pageIndex, pageLabel: source.pageLabel });
}
function row(store: KBStore, table: "notes" | "annotations" | "ai_contents" | "idea_lab_messages", id: string) {
  const value = store.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  if (!value) throw new StoreError("来源已不存在，请重新选择", 404); return value;
}
function attachment(store: KBStore, id: string, paperId: string, sha?: string) {
  const file = store.db.prepare("SELECT * FROM attachments WHERE id=? AND paper_id=?").get(id, paperId);
  if (!file || (sha && file.sha256 !== sha)) throw new StoreError("来源附件或指纹不一致", 409);
  return String(file.sha256);
}
export function resolveResearchSource(store: KBStore, raw: ResearchSourceInput): ResearchItemSource {
  const input = researchSourceInputSchema.parse(raw);
  let source: Omit<ResearchItemSource, "id" | "fingerprint" | "capturedAt">;
  if (input.kind === "note" || input.kind === "noteSelection") {
    const note = row(store, "notes", input.id);
    if (Number(note.revision) !== input.revision) throw new StoreError("来源笔记已更新，请重新选择选段", 409);
    const body = String(note.body);
    if (input.kind === "noteSelection" && input.to > body.length) throw new StoreError("笔记选段超出原文范围", 400);
    source = { input, title: String(note.title) || "个人笔记", text: input.kind === "noteSelection" ? body.slice(input.from, input.to) : body,
      sourceHref: `kb://note/${input.id}`, origin: "personal" };
  } else if (input.kind === "annotation") {
    const mark = row(store, "annotations", input.id);
    if (Number(mark.revision) !== input.revision) throw new StoreError("来源批注已更新，请重新选择", 409);
    const paperId = String(mark.paper_id), attachmentId = String(mark.attachment_id);
    source = { input, title: `标注 · 物理第 ${Number(mark.page_index) + 1} 页`, text: [String(mark.selected_text), String(mark.comment)].filter(value => value.trim()).join("\n\n") || "页内区域标注（无文字）",
      sourceHref: `kb://annotation/${input.id}`, origin: "annotation", paperId, attachmentId,
      attachmentSha256: attachment(store, attachmentId, paperId), pageIndex: Number(mark.page_index), pageLabel: String(mark.page_label) };
  } else if (input.kind === "guideEvidence" || input.kind === "guideQuestion") {
    const ai = row(store, "ai_contents", input.id);
    const parsed = guideDataSchema.safeParse(ai.guide_data ? JSON.parse(String(ai.guide_data)) : null);
    if (!parsed.success) throw new StoreError("这条 AI 记录不是有效的导读报告", 400);
    const data: GuideData = parsed.data;
    if (input.kind === "guideQuestion") {
      const text = data.questions[input.questionIndex];
      if (!text?.trim()) throw new StoreError("所选导读问题不存在", 404);
      source = { input, title: "AI 导读提出的待核验问题", text, sourceHref: `kb://ai/${input.id}`, origin: "ai", paperId: String(ai.paper_id) };
    } else {
      const evidence = data.evidence.find(value => value.id === input.evidenceId);
      if (!evidence) throw new StoreError("所选导读证据不存在", 404);
      source = { input, title: evidence.title, text: `${evidence.quote}\n\nAI 解释（待核验）：${evidence.explanation}`, sourceHref: `kb://ai/${input.id}`, origin: "ai",
        paperId: evidence.paperId, attachmentId: evidence.attachmentId, attachmentSha256: attachment(store, evidence.attachmentId, evidence.paperId, evidence.attachmentSha256), pageIndex: evidence.pageIndex, pageLabel: evidence.pageLabel };
    }
  } else if (input.kind === "ideaMessage") {
    const value = row(store, "idea_lab_messages", input.messageId);
    const message = JSON.parse(String(value.data)) as { status: string; role: string; body: string; conversationId: string };
    if (message.conversationId !== input.conversationId || message.status !== "completed") throw new StoreError("讨论消息尚未完成或归属不一致", 409);
    source = { input, title: message.role === "assistant" ? "AI 讨论回复（待核验）" : "我的讨论记录", text: message.body,
      sourceHref: `kb://note/${String(value.note_id)}`, origin: message.role === "assistant" ? "ai" : "personal" };
  } else {
    const imported = resolveExternalDiscussionSource(store, { discussionId: input.id, revision: input.revision, messageIds: input.messageIds });
    source = { input, title: imported.title, text: imported.text, sourceHref: imported.sourceHref, origin: "external" };
  }
  if (!source.text.trim()) throw new StoreError("来源内容为空，请选择有内容的记录", 400);
  if (source.text.length > 32000) throw new StoreError("来源过长，请选择较小的笔记选段或讨论范围；没有截断内容", 413);
  return researchItemSourceSchema.parse({ ...source, id: researchSourceKey(input), fingerprint: researchSourceFingerprint(source), capturedAt: new Date().toISOString() });
}
export function resolveResearchSources(store: KBStore, inputs: readonly ResearchSourceInput[]) {
  if (inputs.length > 12) throw new StoreError("每次最多选择 12 个来源", 400);
  const values = inputs.map(input => resolveResearchSource(store, input));
  if (new Set(values.map(value => value.id)).size !== values.length) throw new StoreError("来源重复，请移除重复选择", 400);
  if (values.reduce((sum, value) => sum + value.text.length, 0) > 192000) throw new StoreError("所选来源总量过长，请减少范围", 413);
  return values;
}
/** Historical snapshots can outlive edits; validate identity/FKs without replacing their saved text. */
export function validateResearchSource(store: KBStore, raw: ResearchItemSource) {
  const source = researchItemSourceSchema.parse(raw), input = source.input;
  if (source.id !== researchSourceKey(input) || source.fingerprint !== researchSourceFingerprint(source)) throw new StoreError("待核验来源快照指纹不一致", 400);
  if (input.kind === "note" || input.kind === "noteSelection") {
    const note = row(store, "notes", input.id);
    if (input.revision > Number(note.revision) || source.sourceHref !== `kb://note/${input.id}` || source.origin !== "personal" || (input.kind === "noteSelection" && input.to - input.from !== source.text.length)) throw new StoreError("待核验笔记来源不一致", 400);
    if (source.paperId || source.attachmentId || source.pageIndex !== undefined) throw new StoreError("笔记来源不能冒充 PDF 来源", 400);
    if (input.revision === Number(note.revision) && source.text !== (input.kind === "noteSelection" ? String(note.body).slice(input.from, input.to) : String(note.body))) throw new StoreError("待核验笔记快照与所选原文不一致", 400);
  } else if (input.kind === "annotation") {
    const mark = row(store, "annotations", input.id);
    if (input.revision > Number(mark.revision) || source.sourceHref !== `kb://annotation/${input.id}` || source.origin !== "annotation" || source.paperId !== mark.paper_id || source.attachmentId !== mark.attachment_id || source.pageIndex !== Number(mark.page_index) || source.pageLabel !== String(mark.page_label)) throw new StoreError("待核验标注来源不一致", 400);
    if (input.revision === Number(mark.revision) && resolveResearchSource(store, input).fingerprint !== source.fingerprint) throw new StoreError("待核验标注快照与所选原文不一致", 400);
  } else if (input.kind === "guideEvidence" || input.kind === "guideQuestion" || input.kind === "ideaMessage") {
    if (resolveResearchSource(store, input).fingerprint !== source.fingerprint) throw new StoreError("待核验 AI 来源与已保存记录不一致", 400);
  } else {
    const imported = resolveExternalDiscussionSource(store, { discussionId: input.id, revision: input.revision, messageIds: input.messageIds });
    if (imported.revision !== input.revision || imported.sourceHref !== source.sourceHref || source.origin !== "external" || imported.title !== source.title || imported.text !== source.text || source.paperId || source.attachmentId || source.pageIndex !== undefined) throw new StoreError("待核验导入讨论来源不一致", 400);
  }
  if (source.attachmentId) {
    if (!source.paperId || !source.attachmentSha256) throw new StoreError("待核验来源缺少附件信息", 400);
    attachment(store, source.attachmentId, source.paperId, source.attachmentSha256);
  }
  return source;
}
