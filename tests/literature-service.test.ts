import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Response as PublicResponse } from "undici";
import { KBStore } from "../src/lib/db";
import { StoreError } from "../src/lib/store-error";
import { lookupMetadata } from "../src/lib/import/enrichment";
import { attachFromSource } from "../src/lib/import/metadata";
import type { FetchedPublicResponse } from "../src/lib/import/download";
import type { MetadataCandidate } from "../src/lib/import/enrichment-types";
import type { Note, Paper } from "../src/lib/types";
import { importLiterature, searchLiterature, type LiteratureDependencies } from "../src/lib/literature/service";
import { cacheLiteratureCandidate, readLiteratureCandidate } from "../src/lib/literature/cache";
import { resolveLiteratureContext } from "../src/lib/literature/context";
import { literatureImportSchema } from "../src/lib/literature/schemas";

const title = "TEST controlled literature import", doi = "10.1234/literature-test", article = "https://publisher.example/article", pdfUrl = "https://publisher.example/article.pdf";
const bytes = Buffer.from("%PDF-1.7\nSYNTHETIC LITERATURE ACCEPTANCE ONLY\n%%EOF");
const status = (code: number) => (error: unknown) => error instanceof StoreError && error.status === code;
async function library(run: (store: KBStore, source: Paper) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-literature-test-")); const store = new KBStore(root);
  try { const source = store.dispatch("paper.create", { title: "TEST source paper", tags: ["Online Learning", "Theory"] }) as Paper; await run(store, source); }
  finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
}
function boundaries() {
  const calls: string[] = [];
  const fetcher = async (url: string, signal?: AbortSignal): Promise<FetchedPublicResponse> => {
    calls.push(url); assert.ok(signal);
    let body: string | Buffer;
    if (url.startsWith("https://api.crossref.org/works")) {
      const work = { DOI: doi, title: [title], abstract: "TEST public abstract", author: [{ given: "Test", family: "Author" }], published: { "date-parts": [[2025]] }, resource: { primary: { URL: article } } };
      body = JSON.stringify({ message: url.includes("query.title=") ? { items: [work] } : work });
    } else if (url === article) body = `<head><meta name="citation_title" content="${title}"><meta name="citation_doi" content="${doi}"><meta name="citation_pdf_url" content="${pdfUrl}"></head>`;
    else if (url === pdfUrl) body = bytes;
    else throw new Error(`Unexpected fixture request ${url}`);
    return { url, response: new PublicResponse(body), close: async () => {} };
  };
  const deps: LiteratureDependencies = {
    lookup: (input, _fetcher, signal) => lookupMetadata(input, fetcher, signal),
    attach: (id, source, options) => attachFromSource(id, source, { ...options, fetcher }),
  };
  return { deps, calls };
}
const tagsFor = (store: KBStore, id: string) => { const state = store.snapshot(); return state.tags.filter(tag => state.relations.some(relation => relation.fromId === id && relation.toId === tag.id && relation.purpose === "tag")).map(tag => tag.name).sort(); };

test("literature search performs public lookup without writes; import trusts the signed server candidate and inherited tags", async () => library(async (store, source) => {
  const before = store.snapshot(), { deps, calls } = boundaries(), context = { paperIds: [source.id] };
  const found = await searchLiterature({ query: title, context }, store, undefined, deps);
  assert.deepEqual(store.snapshot(), before); assert.equal(found.candidates.length, 1); assert.deepEqual(found.inheritedTags.sort(), ["Online Learning", "Theory"]);
  assert.equal(calls.length, 1); assert.match(calls[0], /^https:\/\/api.crossref.org\/works\?query.title=/);
  const token = found.candidates[0].candidateToken;
  found.candidates[0].metadata.title = "CLIENT FORGED TITLE";
  assert.throws(() => literatureImportSchema.parse({ candidateToken: token, context, downloadPdf: false, tags: ["FORGED"] }));
  await assert.rejects(importLiterature({ candidateToken: token.slice(0, -1) + (token.endsWith("a") ? "b" : "a"), context, downloadPdf: false }, store), status(409));
  const result = await importLiterature({ candidateToken: token, context, downloadPdf: false }, store);
  assert.equal(result.created, true); assert.equal(result.downloaded, false); assert.equal(result.alreadyHadPdf, false);
  assert.equal(result.state.papers.find(paper => paper.id === result.paperId)?.title, title);
  assert.deepEqual(tagsFor(store, result.paperId), ["Online Learning", "Theory"]);
  assert.deepEqual(result.state.notes.filter(note => before.notes.some(old => old.id === note.id)), before.notes);
  assert.equal(result.state.aiContents.length, 0); assert.equal(result.state.chatConversations?.length, 0);
}));

test("concurrent imports and fresh searches reuse one archive and PDF without overwriting original metadata or notes", async () => library(async (store, source) => {
  const { deps, calls } = boundaries(), context = { paperIds: [source.id] }, found = await searchLiterature({ query: doi, context }, store, undefined, deps);
  const input = { candidateToken: found.candidates[0].candidateToken, context, downloadPdf: true };
  const [first, second] = await Promise.all([importLiterature(input, store, undefined, deps), importLiterature(input, store, undefined, deps)]);
  assert.equal(first.paperId, second.paperId); assert.equal(first.created, true); assert.equal(first.downloaded, true); assert.equal(second.created, false); assert.equal(second.alreadyHadPdf, true);
  assert.equal(calls.filter(url => url === pdfUrl).length, 1); assert.equal(store.snapshot().attachments.length, 1);
  const file = store.snapshot().attachments[0]; assert.deepEqual(readFileSync(path.join(store.dataDir, file.relativePath)), bytes);
  const note = store.snapshot().notes.find(note => store.snapshot().relations.some(relation => relation.fromId === note.id && relation.toId === first.paperId))!;
  store.dispatch("note.update", { id: note.id, revision: note.revision, title: note.title, body: "KEEP ORIGINAL PERSONAL RESEARCH" });
  const existing = store.snapshot().papers.find(paper => paper.id === first.paperId)!;
  store.dispatch("paper.update", { id: existing.id, revision: existing.revision, title: "KEEP CURATED TITLE", abstract: "KEEP CURATED ABSTRACT", tags: ["Existing Tag"] });
  const curated = store.snapshot().papers.find(paper => paper.id === first.paperId)!;
  const searched = await searchLiterature({ query: doi, context }, store, undefined, deps);
  assert.equal(searched.candidates[0].existingPaperId, first.paperId); assert.equal(searched.candidates[0].hasPdf, true);
  const reused = await importLiterature({ ...input, candidateToken: searched.candidates[0].candidateToken }, store, undefined, deps);
  assert.equal(reused.created, false); assert.deepEqual(store.snapshot().papers.find(paper => paper.id === first.paperId), curated);
  assert.deepEqual(tagsFor(store, first.paperId), ["Existing Tag", "Online Learning", "Theory"]);
  assert.equal(store.snapshot().notes.find(item => item.id === note.id)?.body, "KEEP ORIGINAL PERSONAL RESEARCH");
  assert.equal(calls.filter(url => url === pdfUrl).length, 1);
}));

test("a failed download preserves the saved archive and tags and a retry can obtain its PDF", async () => library(async (store, source) => {
  const { deps } = boundaries(), context = { paperIds: [source.id] }, found = await searchLiterature({ query: title, context }, store, undefined, deps);
  const input = { candidateToken: found.candidates[0].candidateToken, context, downloadPdf: true };
  const failed = await importLiterature(input, store, undefined, { ...deps, attach: async () => { throw new StoreError("需要登录，尚未获取正文", 422); } });
  assert.equal(failed.created, true); assert.equal(failed.downloaded, false); assert.equal(failed.state.attachments.length, 0); assert.match(failed.warnings.join(" "), /题录和标签已保存.*需要登录/);
  const retry = await importLiterature(input, store, undefined, deps);
  assert.equal(retry.created, false); assert.equal(retry.paperId, failed.paperId); assert.equal(retry.downloaded, true);
}));

test("tokens are bound to reviewed scope and current inherited tags; deleted sources, trash and cancelled requests never silently import", async () => library(async (store, source) => {
  const { deps } = boundaries(), context = { paperIds: [source.id] }, found = await searchLiterature({ query: title, context }, store, undefined, deps);
  const input = { candidateToken: found.candidates[0].candidateToken, context, downloadPdf: false };
  await assert.rejects(importLiterature({ ...input, context: {} }, store), status(409));
  store.dispatch("paper.update", { id: source.id, revision: source.revision, tags: ["Changed"] });
  await assert.rejects(importLiterature(input, store), status(409)); assert.equal(store.snapshot().papers.length, 1);
  const fresh = await searchLiterature({ query: title, context }, store, undefined, deps), freshInput = { ...input, candidateToken: fresh.candidates[0].candidateToken };
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(importLiterature(freshInput, store, aborted.signal), status(499)); assert.equal(store.snapshot().papers.length, 1);
  const saved = await importLiterature(freshInput, store); const paper = store.snapshot().papers.find(item => item.id === saved.paperId)!;
  store.dispatch("paper.trash", { id: paper.id, revision: paper.revision });
  const trash = await searchLiterature({ query: title, context }, store, undefined, deps);
  assert.equal(trash.candidates[0].existingTrashed, true);
  await assert.rejects(importLiterature({ ...freshInput, candidateToken: trash.candidates[0].candidateToken }, store), status(409));
  assert.equal(store.snapshot().papers.length, 2); assert.ok(store.snapshot().papers.find(item => item.id === paper.id)?.deletedAt);
}));

test("note contexts inherit the union of explicitly linked paper tags; URL-only candidates deduplicate by normalized source", async () => library(async (store, source) => {
  const second = store.dispatch("paper.create", { title: "TEST other source", tags: ["Second", "Theory"] }) as Paper;
  const idea = store.dispatch("note.create", { title: "TEST idea", body: "KEEP", purpose: "idea", paperIds: [source.id, second.id] }) as Note;
  const context = { noteId: idea.id };
  const candidate: MetadataCandidate = { id: "url-only", metadata: { title, sourceUrl: "https://publisher.example/url-only/?b=2&a=1#view" }, match: "unknown", provenance: [], warnings: [] };
  const deps: LiteratureDependencies = { lookup: async () => ({ candidates: [candidate], warnings: [], queriedAt: new Date().toISOString() }) };
  const first = await searchLiterature({ query: title, context }, store, undefined, deps);
  assert.deepEqual(first.contextPaperIds.sort(), [source.id, second.id].sort()); assert.deepEqual(first.inheritedTags.sort(), ["Online Learning", "Second", "Theory"]);
  const saved = await importLiterature({ candidateToken: first.candidates[0].candidateToken, context, downloadPdf: false }, store);
  candidate.metadata.sourceUrl = "https://publisher.example/url-only?a=1&b=2";
  const fresh = await searchLiterature({ query: title, context }, store, undefined, deps);
  const reused = await importLiterature({ candidateToken: fresh.candidates[0].candidateToken, context, downloadPdf: false }, store);
  assert.equal(reused.paperId, saved.paperId); assert.equal(reused.created, false); assert.equal(store.snapshot().papers.length, 3);
  assert.equal(store.snapshot().relations.some(relation => relation.fromType === "paper" && relation.fromId === saved.paperId && relation.toType === "topic"), false);
}));

test("cancellation during download leaves no late PDF write; cached candidates expire and cannot be transferred between libraries", async t => library(async (store, source) => {
  const { deps } = boundaries(), context = { paperIds: [source.id] }, found = await searchLiterature({ query: title, context }, store, undefined, deps);
  const controller = new AbortController();
  await assert.rejects(importLiterature({ candidateToken: found.candidates[0].candidateToken, context, downloadPdf: true }, store, controller.signal, { ...deps,
    attach: async () => { controller.abort(); throw new StoreError("已取消", 499); } }), error => status(499)(error) && Boolean((error as StoreError).details));
  assert.equal(store.snapshot().papers.length, 2); assert.equal(store.snapshot().attachments.length, 0);
  const cached = cacheLiteratureCandidate(store.dataDir, resolveLiteratureContext(store, context), found.candidates[0]);
  assert.throws(() => readLiteratureCandidate(cached, store.dataDir + "-other"), status(409));
  const now = Date.now(); t.mock.method(Date, "now", () => now + 31 * 60 * 1000);
  assert.throws(() => readLiteratureCandidate(cached, store.dataDir), status(409));
}));

test("explicit arXiv candidate versions disclose existing-version reuse and downloaded-source differences without rewriting the record", async () => library(async (store, source) => {
  const existing = store.dispatch("paper.create", { title, arxivId: "1706.03762", arxivVersion: 2, sourceUrl: "https://arxiv.org/abs/1706.03762v2" }) as Paper;
  const file = store.addAttachment(existing.id, "synthetic-v2.pdf", bytes);
  const context = { paperIds: [source.id] }, candidate: MetadataCandidate = { id: "arxiv-v3", metadata: { title, arxivId: "1706.03762", arxivVersion: 3, sourceUrl: "https://arxiv.org/abs/1706.03762v3" }, match: "unknown", provenance: [], warnings: [] };
  let downloads = 0;
  const deps: LiteratureDependencies = { lookup: async () => ({ candidates: [candidate], warnings: [], queriedAt: new Date().toISOString() }),
    attach: async (id, address, options) => { downloads++; assert.equal(address, candidate.metadata.sourceUrl); assert.equal(options?.store, store); return store.addAttachment(id, "synthetic-v3.pdf", Buffer.concat([bytes, Buffer.from("VERSION 3 FIXTURE")])); } };
  const found = await searchLiterature({ query: "1706.03762v3", context }, store, undefined, deps), input = { candidateToken: found.candidates[0].candidateToken, context, downloadPdf: true };
  const reused = await importLiterature(input, store, undefined, deps);
  assert.equal(reused.alreadyHadPdf, true); assert.equal(reused.downloaded, false); assert.equal(downloads, 0);
  assert.match(reused.warnings.join(" "), /候选指定 arXiv v3，已有记录为arXiv v2.*没有下载或替换/);
  assert.equal(store.snapshot().papers.find(paper => paper.id === existing.id)?.arxivVersion, 2);
  const current = store.snapshot().papers.find(paper => paper.id === existing.id)!;
  store.dispatch("paper.update", { id: existing.id, revision: current.revision, arxivVersion: null });
  const unknown = await importLiterature(input, store, undefined, deps);
  assert.match(unknown.warnings.join(" "), /已有记录为未记录版本.*没有下载或替换/); assert.equal(downloads, 0);
  unlinkSync(path.join(store.dataDir, file.relativePath));
  const downloaded = await importLiterature(input, store, undefined, deps);
  assert.equal(downloaded.alreadyHadPdf, false); assert.equal(downloaded.downloaded, true); assert.equal(downloads, 1);
  assert.match(downloaded.warnings.join(" "), /候选指定的 arXiv v3 来源链接获取.*题录版本未修改/);
  assert.equal(store.snapshot().papers.find(paper => paper.id === existing.id)?.arxivVersion, null);
}));
