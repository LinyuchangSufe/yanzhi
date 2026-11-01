import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Response as PublicResponse } from "undici";
import { KBStore, StoreError } from "../src/lib/db";
import type { Paper } from "../src/lib/types";
import { attachFromSource } from "../src/lib/import/metadata";
import { downloadPdf, fetchPublicUrl, isPrivateAddress, type FetchedPublicResponse } from "../src/lib/import/download";
import { normalizeUrl, pdfUrlFromHtml } from "../src/lib/import/normalize";
import { errorResponse } from "../src/lib/security";
import { POST } from "../src/app/api/kb/resolve/route";

const pdf = Buffer.from("%PDF-1.7\nTEST DOWNLOAD FIXTURE ONLY\n%%EOF");
const source = "https://publisher.example/doi/full/10.1234/test";
const pdfLink = "https://publisher.example/doi/pdf/10.1234/test";
const title = "TEST reliable article download";
function fixtures(items: Record<string, { body: string | Buffer; status?: number; headers?: Record<string, string>; finalUrl?: string }>) {
  const requested: string[] = [], closed: string[] = [];
  return { requested, closed, fetch: async (url: string, signal?: AbortSignal): Promise<FetchedPublicResponse> => {
    assert.ok(signal, "requests must be cancellable and bounded in time");
    requested.push(url);
    const item = items[url];
    assert.ok(item, `Unexpected request: ${url}`);
    return { url: item.finalUrl ?? url, response: new PublicResponse(item.body, { status: item.status ?? 200, headers: item.headers }), close: async () => { closed.push(url); } };
  } };
}
const head = (extra: string, doi = "10.1234/test", paperTitle = title) => `<head><meta name="citation_title" content="${paperTitle}"><meta name="citation_doi" content="${doi}">${extra}</head>`;

test("download source normalization accepts DOI and versioned arXiv identifiers without widening OpenReview hosts", () => {
  assert.equal(normalizeUrl("DOI: 10.1234/TEST").url, "https://doi.org/10.1234/TEST");
  assert.deepEqual(normalizeUrl("arxiv:2106.09685v2"), { url: "https://arxiv.org/pdf/2106.09685v2", expectsPdf: true, arxivId: "2106.09685v2" });
  assert.equal(normalizeUrl("https://arxiv.org/abs/2106.09685v2?download=1").url, "https://arxiv.org/pdf/2106.09685v2");
  assert.equal(normalizeUrl("https://evilopenreview.net/forum?id=ABC").expectsPdf, false);
  assert.equal(normalizeUrl("https://openreview.net/forum?id=A%26B").url, "https://openreview.net/pdf?id=A%26B");
  assert.throws(() => normalizeUrl("file:///tmp/private.pdf"));
  assert.throws(() => normalizeUrl("https://user:password@publisher.example/a.pdf"));
});

test("HTML PDF links support attribute order, entities, alternate links and non-extension publisher endpoints", () => {
  assert.equal(pdfUrlFromHtml('<META CONTENT="/doi/pdf/10.1234/test?x=1&amp;y=2" NAME=citation_pdf_url>', source), `${pdfLink}?x=1&y=2`);
  assert.equal(pdfUrlFromHtml('<link href="/download/123" type="application/pdf" rel="alternate">', source), "https://publisher.example/download/123");
  assert.equal(pdfUrlFromHtml('<a href="/supplement.pdf">Supplement PDF</a><a href="/doi/pdf/10.1234/test">Download PDF</a>', source), pdfLink);
  assert.equal(pdfUrlFromHtml('<a href="/main.pdf">Download full text</a>', source), "https://publisher.example/main.pdf");
});

test("ambiguous, supplementary, scripted, commented and unsafe PDF links are never silently selected", () => {
  for (const html of [
    '<a href="/supplement.pdf">Supplement PDF</a>',
    '<a href="/one.pdf">PDF</a><a href="/two.pdf">PDF</a>',
    '<!-- <meta name="citation_pdf_url" content="/wrong.pdf"> -->',
    '<script>"<meta name=\'citation_pdf_url\' content=\'/wrong.pdf\'>"</script>',
    '<meta name="citation_pdf_url" content="javascript:alert(1)">',
    '<meta name="citation_pdf_url" content="https://user:secret@publisher.example/main.pdf">',
    '<head><title>Article</title></head><body><meta name="citation_pdf_url" content="/reference.pdf"></body>',
  ]) assert.equal(pdfUrlFromHtml(html, source), null, html);
});

test("direct PDF downloads use bytes even with absent or incorrect Content-Type", async () => {
  const choices: Record<string, string>[] = [{}, { "content-type": "application/octet-stream" }, { "content-type": "text/html" }];
  for (const headers of choices) {
    const f = fixtures({ [source]: { body: pdf, headers } });
    const result = await downloadPdf(source, { fetcher: f.fetch });
    assert.deepEqual(result.bytes, pdf);
    assert.equal(result.finalUrl, source);
    assert.deepEqual(f.closed, f.requested);
  }
  const largerPdf = Buffer.concat([pdf, Buffer.alloc(2 * 1024 * 1024)]);
  const larger = fixtures({ [source]: { body: largerPdf, headers: { "content-type": "application/octet-stream" } } });
  assert.equal((await downloadPdf(source, { fetcher: larger.fetch })).bytes.length, largerPdf.length, "binary PDF bytes retain the PDF limit even without an application/pdf header");
});

test("DOI redirects inspect the final article URL and follow only its advertised PDF", async () => {
  const doiUrl = "https://doi.org/10.1234/test";
  const f = fixtures({
    [doiUrl]: { body: head('<meta name="citation_pdf_url" content="/doi/pdf/10.1234/test">'), finalUrl: source },
    [pdfLink]: { body: pdf },
  });
  const result = await downloadPdf("10.1234/test", { fetcher: f.fetch, expectedDoi: "10.1234/test", expectedTitle: title });
  assert.equal(result.finalUrl, pdfLink);
  assert.deepEqual(f.requested, [doiUrl, pdfLink]);
  assert.deepEqual(f.closed, f.requested);
});

test("article HTML viewer can advertise its actual PDF without requiring a .pdf extension", async () => {
  const f = fixtures({
    [source]: { body: head('<meta name="citation_pdf_url" content="/doi/pdf/10.1234/test">') },
    [pdfLink]: { body: head('<link rel="alternate" type="application/pdf" href="/download?article=123">') },
    "https://publisher.example/download?article=123": { body: pdf },
  });
  assert.deepEqual((await downloadPdf(source, { fetcher: f.fetch, expectedTitle: title })).bytes, pdf);
  assert.equal(f.requested.length, 3);
});

test("source DOI, article identity, advertised PDF and final redirects reject explicit mismatches before attaching", async () => {
  const wrong = "https://publisher.example/doi/pdf/10.1234/wrong";
  const noFetch = fixtures({});
  await assert.rejects(() => downloadPdf(source, { fetcher: noFetch.fetch, expectedDoi: "10.1234/other" }), /DOI.*不一致/);
  assert.equal(noFetch.requested.length, 0);
  for (const item of [
    { body: head('<meta name="citation_pdf_url" content="/main.pdf">', "10.1234/wrong") },
    { body: head('<meta name="citation_pdf_url" content="/main.pdf">', "10.1234/test", "Completely unrelated manuscript") },
    { body: head(`<meta name="citation_pdf_url" content="${wrong}">`) },
    { body: pdf, finalUrl: wrong },
  ]) {
    const f = fixtures({ [source]: item });
    await assert.rejects(() => downloadPdf(source, { fetcher: f.fetch, expectedDoi: "10.1234/test", expectedTitle: title }), (error: unknown) => error instanceof Error && "status" in error && error.status === 409);
    assert.equal(f.requested.length, 1);
    assert.deepEqual(f.closed, f.requested);
  }
  const arxiv = "https://arxiv.org/pdf/2306.03372";
  const versioned = fixtures({ [arxiv]: { body: pdf, finalUrl: `${arxiv}v2` } });
  assert.deepEqual((await downloadPdf(arxiv, { fetcher: versioned.fetch })).bytes, pdf, "an unspecified version may resolve to the current version of the same paper");
  for (const [requested, finalUrl] of [[`${arxiv}v2`, `${arxiv}v3`], [arxiv, "https://arxiv.org/pdf/2106.09685"]]) {
    const f = fixtures({ [requested]: { body: pdf, finalUrl } });
    await assert.rejects(() => downloadPdf(requested, { fetcher: f.fetch }), /另一篇文献/);
    assert.deepEqual(f.closed, f.requested);
  }
});

test("HTTP access, missing links and rate limits report the source problem instead of local storage errors", async () => {
  for (const [status, pattern, responseStatus] of [[403, /自动访问|登录/, 422], [404, /失效/, 422], [429, /频繁/, 429], [503, /来源站点暂时不可用/, 502]] as const) {
    const f = fixtures({ [source]: { body: "TEST source failure", status } });
    try { await downloadPdf(source, { fetcher: f.fetch }); assert.fail("must reject"); }
    catch (error) { const response = errorResponse(error); assert.equal(response.status, responseStatus); assert.match((await response.json()).error, pattern); }
    assert.deepEqual(f.closed, f.requested);
  }
  for (const body of ['<title>Log in</title><input type="password">', '<p>Request unsuccessful. Incapsula incident ID: TEST-only</p><script>sessionStorage.setItem("distil_referrer", "TEST");</script>', `<head><title>${title}</title></head>`, '<a href="/supplement.pdf">Supplement PDF</a>']) {
    const f = fixtures({ [source]: { body, headers: { "content-type": "application/pdf" } } });
    await assert.rejects(() => downloadPdf(source, { fetcher: f.fetch, expectedTitle: title }), /登录|正文 PDF|网页而非 PDF/);
    assert.deepEqual(f.closed, f.requested);
  }
});

test("HTML and PDF byte limits remain separate and close responses on failure", async () => {
  const choices: { body: string | Buffer; headers: Record<string, string> }[] = [
    { body: "<html>TEST</html>", headers: { "content-length": String(2 * 1024 * 1024 + 1) } },
    { body: pdf, headers: { "content-length": String(100 * 1024 * 1024 + 1) } },
    { body: "<html>" + "x".repeat(2 * 1024 * 1024), headers: {} },
  ];
  for (const item of choices) {
    const f = fixtures({ [source]: item });
    await assert.rejects(() => downloadPdf(source, { fetcher: f.fetch }), (error: unknown) => error instanceof Error && "status" in error && error.status === 413);
    assert.deepEqual(f.closed, f.requested);
  }
});

test("cancelled and timed out downloads release the slot and never fall back to other papers", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixtures({});
  await assert.rejects(() => downloadPdf(source, { fetcher: f.fetch, signal: controller.signal }), /已取消/);
  assert.equal(f.requested.length, 0);
  await assert.rejects(() => downloadPdf(source, { fetcher: async () => { throw new DOMException("TEST timeout", "TimeoutError"); } }), (error: unknown) => error instanceof Error && "status" in error && error.status === 504);
  await assert.rejects(() => downloadPdf(source, { fetcher: async () => { throw new Error("TEST nested fetch timeout", { cause: new DOMException("TEST timeout", "TimeoutError") }); } }), (error: unknown) => error instanceof Error && "status" in error && error.status === 504);
  const success = fixtures({ [source]: { body: pdf } });
  assert.deepEqual((await downloadPdf(source, { fetcher: success.fetch })).bytes, pdf);
});

test("public fetching retains private-address and URL-credential guards", async () => {
  for (const address of ["127.0.0.1", "10.0.0.2", "192.168.1.2", "::1", "::ffff:127.0.0.1", "169.254.169.254"])
    assert.equal(isPrivateAddress(address), true);
  assert.equal(isPrivateAddress("1.1.1.1"), false);
  for (const url of ["http://127.0.0.1/private", "https://user:secret@publisher.example/a", "http://1.1.1.1:9000/a", "file:///tmp/private.pdf"])
    await assert.rejects(() => fetchPublicUrl(url), /public internet|credentials|default HTTP|HTTP or HTTPS/);
});

test("attachment download preserves existing PDFs, comments and metadata, and fails atomically", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kb-source-download-"));
  const store = new KBStore(dir);
  try {
    const paper = store.dispatch("paper.create", { title, doi: "10.1234/test", sourceUrl: source, tags: ["TEST tag"] }) as Paper;
    const original = store.addAttachment(paper.id, "original.pdf", Buffer.from("%PDF-1.7\nTEST ORIGINAL\n%%EOF"));
    const note = store.snapshot().notes[0];
    store.dispatch("note.update", { id: note.id, revision: note.revision, body: "TEST 用户原稿 $x^2$" });
    const before = store.snapshot();
    const failed = fixtures({ [source]: { body: "Forbidden", status: 403 } });
    await assert.rejects(() => attachFromSource(paper.id, source, { store, fetcher: failed.fetch }), /来源站点限制/);
    assert.deepEqual(store.snapshot(), before);
    const success = fixtures({ [source]: { body: pdf } });
    await attachFromSource(paper.id, source, { store, fetcher: success.fetch });
    const { attachments: _before, ...oldState } = before;
    const { attachments, ...newState } = store.snapshot();
    assert.deepEqual(newState, oldState);
    assert.equal(attachments.length, before.attachments.length + 1);
    assert.match(readFileSync(store.attachmentPath(original.id), "utf8"), /TEST ORIGINAL/);
    await attachFromSource(paper.id, source, { store, fetcher: success.fetch });
    assert.equal(store.snapshot().attachments.length, attachments.length, "repeated exact PDF is deduplicated");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("missing, trashed, changed and mismatched records do not write a downloaded attachment", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kb-source-race-"));
  const store = new KBStore(dir);
  try {
    const paper = store.dispatch("paper.create", { title, doi: "10.1234/test", sourceUrl: source }) as Paper;
    const f = fixtures({ [source]: { body: pdf } });
    await assert.rejects(() => attachFromSource("00000000-0000-4000-8000-000000000000", source, { store, fetcher: f.fetch }), (error: unknown) => error instanceof StoreError && error.status === 404);
    await assert.rejects(() => attachFromSource(paper.id, "https://doi.org/10.1234/other", { store, fetcher: f.fetch }), /不一致/);
    assert.equal(f.requested.length, 0);
    await assert.rejects(() => attachFromSource(paper.id, source, { store, fetcher: async (url, signal) => {
      store.dispatch("paper.trash", { id: paper.id, revision: paper.revision });
      return f.fetch(url, signal);
    } }), /文献信息已变化/);
    const before = store.snapshot();
    await assert.rejects(() => attachFromSource(paper.id, source, { store, fetcher: f.fetch }), /回收站/);
    assert.deepEqual(store.snapshot(), before);
    assert.equal(before.attachments.length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("resolve route rejects foreign requests, invalid input and unsaved downloads before any public request", async () => {
  const request = (body: unknown, headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3000/api/kb/resolve", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await POST(request({ source, downloadPdf: true }, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await POST(request({ source }, { "content-type": "text/plain" }))).status, 415);
  const missing = await POST(request({ source, downloadPdf: true }));
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /先保存/);
  assert.equal((await POST(request({ source, notes: "TEST PRIVATE" }))).status, 400);
});
