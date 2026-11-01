import assert from "node:assert/strict";
import test from "node:test";
import { LiteratureImportError, LiteratureRequestError, LiteratureRequests, existingLiteraturePaper, literatureImportFeedback, literatureScopeFingerprint, literatureScopePaperIds, literatureScopeTags, safeLiteratureHref } from "../src/lib/literature/client";
import type { LiteratureCandidate, LiteratureImportResult, LiteratureSearchResult } from "../src/lib/literature/types";
import type { KBState, Paper } from "../src/lib/types";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const a = "00000000-0000-4000-8000-000000000001", b = "00000000-0000-4000-8000-000000000002", c = "00000000-0000-4000-8000-000000000003", noteId = "00000000-0000-4000-8000-000000000004";
const at = "2026-11-01T00:00:00.000Z";
const paper = (id: string): Paper => ({ id, title: "TEST paper", authors: [], year: null, abstract: "", sourceUrl: "", doi: "", arxivId: "", arxivVersion: null, readingStatus: "unread", revision: 1, createdAt: at, updatedAt: at });
function state(): KBState {
  return { papers: [paper(a), paper(b), { ...paper(c), deletedAt: at }], attachments: [], annotations: [], notes: [{ id: noteId, title: "TEST idea", body: "PRIVATE_NOTE_MUST_NOT_BE_SENT", purpose: "idea", revision: 1, createdAt: at, updatedAt: at }], topics: [], aiContents: [], tags: [{ id: "tag-a", name: "方法" }, { id: "tag-b", name: "理论" }], relations: [
    { id: "link-a", fromType: "note", fromId: noteId, toType: "paper", toId: a, purpose: "manual", createdAt: at },
    { id: "link-b", fromType: "paper", fromId: b, toType: "note", toId: noteId, purpose: "manual", createdAt: at },
    { id: "link-c", fromType: "note", fromId: noteId, toType: "paper", toId: c, purpose: "manual", createdAt: at },
    { id: "tag-link-a", fromType: "paper", fromId: a, toType: "tag", toId: "tag-a", purpose: "tag", createdAt: at },
    { id: "tag-link-b", fromType: "tag", fromId: "tag-b", toType: "paper", toId: b, purpose: "tag", createdAt: at },
  ], readingPositions: [], settings: { aiProvider: "none", codexModel: "", ollamaUrl: "http://localhost:11434", ollamaModel: "", openaiUrl: "https://api.example.invalid/v1", openaiModel: "", appearance: "light", splitRatio: 50 } };
}
const result = (query: string): LiteratureSearchResult => ({ candidates: [], inheritedTags: [query], contextPaperIds: [a], warnings: [], queriedAt: at });
const imported = (extra: Partial<LiteratureImportResult> = {}): LiteratureImportResult => ({ paperId: a, created: true, downloaded: false, alreadyHadPdf: false, warnings: ["TEST public PDF unavailable"], inheritedTags: ["方法"], state: state(), ...extra });

test("cancelled and superseded searches never replace the newest result, even if the transport ignores abort", async () => {
  const pending = [deferred<Response>(), deferred<Response>()], requests: RequestInit[] = [];
  const client = new LiteratureRequests(async (_url, init) => { requests.push(init!); return pending[requests.length - 1]!.promise; });
  const old = client.search("old title", { paperIds: [a] });
  const newest = client.search("new title", { paperIds: [b] });
  assert.equal(requests[0]!.signal?.aborted, true);
  pending[1]!.resolve(Response.json(result("new"))); assert.deepEqual(await newest, result("new"));
  pending[0]!.resolve(Response.json(result("old"))); assert.equal(await old, null);
  const cancelledResponse = deferred<Response>();
  const cancelled = new LiteratureRequests(async () => cancelledResponse.promise); const operation = cancelled.search("TEST title", {});
  cancelled.cancelSearch(); cancelledResponse.resolve(Response.json(result("cancelled"))); assert.equal(await operation, null);
});
test("import sends only the verified candidate token and exact search context; repeated clicks cannot issue concurrent writes", async () => {
  const pending = deferred<Response>(), calls: { body: Record<string, unknown>; signal?: AbortSignal | null }[] = [];
  const client = new LiteratureRequests(async (_url, init) => { calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, signal: init?.signal }); return pending.promise; });
  const context = { noteId, paperIds: [b, a] };
  const first = client.importCandidate("server-verified-token", context);
  await assert.rejects(client.importCandidate("second-token", context), LiteratureRequestError);
  await assert.rejects(client.search("another title", context), LiteratureRequestError);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.body, { action: "import", candidateToken: "server-verified-token", context, downloadPdf: true });
  assert.equal(calls[0]!.signal, undefined, "the dialog cannot abort an uncertain write while it is submitted");
  assert.equal(JSON.stringify(calls).includes("PRIVATE_NOTE_MUST_NOT_BE_SENT"), false);
  pending.resolve(Response.json(imported())); assert.equal((await first).downloaded, false);
});
test("a cancelled or failed import preserves confirmed saved IDs and otherwise keeps its result uncertain", async () => {
  const saved = new LiteratureRequests(async () => Response.json({ error: "已取消后续下载，题录保留。", details: { paperId: a, created: true } }, { status: 499 }));
  await assert.rejects(saved.importCandidate("verified", {}), (error: unknown) => error instanceof LiteratureImportError && error.status === 499 && error.paperId === a && /题录保留/.test(error.message));
  const interrupted = new LiteratureRequests(async () => { throw new DOMException("Synthetic interrupted connection", "AbortError"); });
  await assert.rejects(interrupted.importCandidate("verified", {}), (error: unknown) => error instanceof LiteratureImportError && error.paperId === undefined);
});
test("PDF feedback distinguishes a saved citation from a completed download or an existing usable PDF", () => {
  assert.deepEqual(literatureImportFeedback(imported()), { label: "题录已保存，PDF 待补", pdfReady: false });
  assert.deepEqual(literatureImportFeedback(imported({ downloaded: true })), { label: "题录与 PDF 已保存", pdfReady: true });
  assert.deepEqual(literatureImportFeedback(imported({ created: false, alreadyHadPdf: true })), { label: "已复用库中的 PDF，所选标签已同步", pdfReady: true });
  assert.deepEqual(literatureImportFeedback(imported({ created: false })), { label: "文献已在库中，PDF 待补", pdfReady: false });
});
test("scope derives active manual associations and tag union, while an explicit empty or reduced selection stays exact", () => {
  const value = state();
  assert.deepEqual(literatureScopePaperIds(value, { noteId }), [a, b]);
  assert.deepEqual(literatureScopePaperIds(value, { noteId, paperIds: [] }), []);
  assert.deepEqual(literatureScopePaperIds(value, { noteId, paperIds: [b, b] }), [b]);
  assert.deepEqual(literatureScopeTags(value, [a, b]), ["方法", "理论"]);
  const before = literatureScopeFingerprint(value, { noteId, paperIds: [a] }); value.tags[0]!.name = "新标签";
  assert.notEqual(literatureScopeFingerprint(value, { noteId, paperIds: [a] }), before);
  value.papers[0]!.deletedAt = at; assert.deepEqual(literatureScopePaperIds(value, { noteId }), [b]);
});
test("refreshed records are recognized by stable identifiers rather than similar titles, and source links reject executable URLs", () => {
  const value = state(); value.papers[0]!.doi = "10.1234/test";
  const candidate: LiteratureCandidate = { id: "candidate", candidateToken: "verified", match: "exact", warnings: [], provenance: [], metadata: { title: "TEST paper", sourceUrl: "https://doi.org/10.1234/test", doi: "10.1234/TEST" } };
  assert.equal(existingLiteraturePaper(value, candidate)?.id, a);
  assert.equal(existingLiteraturePaper(value, { ...candidate, metadata: { title: "TEST paper", sourceUrl: "https://example.org/different" } }), undefined);
  assert.equal(safeLiteratureHref("javascript:alert(1)"), undefined); assert.equal(safeLiteratureHref("https://user:password@example.org/paper"), undefined);
  assert.equal(safeLiteratureHref("https://doi.org/10.1234/test"), "https://doi.org/10.1234/test");
});
