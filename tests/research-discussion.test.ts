import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { researchItemDiscussionDraft } from "../src/lib/research-discussion";
import { verifyIdeaLinks } from "../src/lib/idea-lab/prompt";
import type { ResearchItem, ResearchItemSource } from "../src/lib/research-items/types";

function fixture(): ResearchItem {
  const at = "2026-10-31T00:00:00.000Z", externalId = randomUUID(), noteId = randomUUID();
  const source: ResearchItemSource = {
    id: randomUUID(), input: { kind: "externalDiscussion", id: externalId, revision: 2, messageIds: ["saved-old-message"] },
    title: "SYNTHETIC retained external revision", text: "用户：Saved historical question\r\n🧠\n\nAI：Unverified old hypothesis.",
    sourceHref: `codex://threads/${randomUUID()}`, fingerprint: "a".repeat(64), capturedAt: at, origin: "external",
  };
  return { id: randomUUID(), topicId: randomUUID(), title: "SYNTHETIC saved research question", body: "User rationale with $x^2$.",
    status: "in_progress", nextAction: "Check a synthetic boundary case.", resolution: "Only a software fixture, not a research result.",
    sourceRefs: [source], resultRefs: [{ ...source, id: randomUUID(), input: { kind: "noteSelection", id: noteId, revision: 3, from: 0, to: 24 },
      title: "SYNTHETIC user-selected result", text: "Explicit saved result 🧪", sourceHref: `kb://note/${noteId}`, origin: "personal" }],
    revision: 4, createdAt: at, updatedAt: at, archivedAt: null };
}

test("a research handoff carries exact saved source/result snapshots and never requests live versions", () => {
  const item = fixture(), before = structuredClone(item);
  const draft = researchItemDiscussionDraft(item);
  assert.deepEqual(draft.sources, [], "historical plaintext snapshots must not be re-resolved from current IDs");
  assert.ok(draft.prompt?.includes(item.sourceRefs[0].text), "CRLF and UTF-16 source text remain exact");
  assert.ok(draft.prompt?.includes(item.resultRefs[0].text));
  assert.ok(draft.prompt?.includes(item.sourceRefs[0].capturedAt));
  assert.ok(draft.prompt?.includes(`kb://research-item/${item.id}`));
  assert.deepEqual(item, before, "preparing a follow-up must not update the research item or source revisions");
});

test("handoff accepts the exact 12000 character bound and rejects one extra character without truncation", () => {
  const item = fixture(); item.sourceRefs = []; item.resultRefs = []; item.body = "";
  const overhead = researchItemDiscussionDraft(item).prompt!.length;
  // Adding a nonempty body also adds the joiner's two line feeds.
  item.body = "界".repeat(12000 - overhead - 2);
  const accepted = researchItemDiscussionDraft(item);
  assert.equal(accepted.prompt?.length, 12000); assert.ok(accepted.prompt?.includes(item.body));
  item.body += "界"; const before = structuredClone(item);
  assert.throws(() => researchItemDiscussionDraft(item), /超过 12,000/);
  assert.deepEqual(item, before);
});

test("oversized saved evidence is rejected as a whole without dropping result refs or mutating the item", () => {
  const item = fixture(); item.sourceRefs[0].text = `BEGIN\r\n${"🧠".repeat(6500)}\r\nEND`;
  const before = structuredClone(item);
  assert.throws(() => researchItemDiscussionDraft(item), /尚未发送/);
  assert.deepEqual(item, before);
});

test("the handoff's actual research and snapshot links remain valid citations while invented links are rejected", () => {
  const item = fixture(), draft = researchItemDiscussionDraft(item);
  const external = item.sourceRefs[0].input;
  assert.equal(external.kind, "externalDiscussion");
  if (external.kind !== "externalDiscussion") throw new Error("invalid test fixture");
  const hrefs = [`kb://research-item/${item.id}`, `kb://discussion/${external.id}`, item.sourceRefs[0].sourceHref, item.resultRefs[0].sourceHref];
  for (const href of hrefs) assert.doesNotThrow(() => verifyIdeaLinks([`[引用](${href})`], [], [draft.prompt!]));
  assert.throws(() => verifyIdeaLinks([`[伪造来源](kb://note/${randomUUID()})`], [], [draft.prompt!]), /未提供的链接/);
});

