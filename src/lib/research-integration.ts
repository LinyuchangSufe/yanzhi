import type { KBStore } from "./db";
import { StoreError } from "./store-error";
import { initCodexImportSchema, externalDiscussionSnapshot, importExternalDiscussions, detachExternalDiscussionEntity } from "./codex-import/store";
import { initResearchItemSchema, researchItemsSnapshot, importResearchItems, researchItemReferences } from "./research-items/store";

export function initializeResearchKnowledge(store: KBStore) {
  initCodexImportSchema(store);
  initResearchItemSchema(store);
}
export function researchKnowledgeSnapshot(store: KBStore) {
  return { externalDiscussions: externalDiscussionSnapshot(store), researchItems: researchItemsSnapshot(store) };
}
export { importExternalDiscussions, importResearchItems };

/** Run inside the existing mutation transaction, before deleting an original object. */
export function protectResearchDeletion(store: KBStore, kind: "topic" | "annotation", id: string) {
  const references = researchItemReferences(store, kind, id);
  if (references.length) throw new StoreError("此来源仍被待核验条目使用，请先调整条目来源或归属。归档条目也会保留引用。", 409, { researchItemIds: references });
  if (kind === "topic") detachExternalDiscussionEntity(store, "topic", id);
}
