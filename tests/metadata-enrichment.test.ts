import assert from "node:assert/strict";
import { test } from "node:test";
import { Response as PublicResponse } from "undici";
import { lookupMetadata, metadataLookupSchema } from "../src/lib/import/enrichment";
import { parseEnrichmentHtml } from "../src/lib/import/enrichment-html";
import type { FetchedPublicResponse } from "../src/lib/import/download";
import { POST } from "../src/app/api/kb/metadata/route";

const title = "TEST exact paper title";
const doi = "10.1234/test";
const endpoint = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
const publisher = "https://publisher.example/article/test";
const work = (extra: Record<string, unknown> = {}) => ({ DOI: doi, title: [title], author: [{ given: "Test", family: "Author" }, { name: "Test Consortium" }], published: { "date-parts": [[2024, 1, 1]] }, resource: { primary: { URL: publisher } }, "container-title": ["TEST Journal"], publisher: "TEST Publisher", type: "journal-article", ...extra });
function fixture(responses: Record<string, { body: string; status?: number; length?: number }>) {
  const requested: string[] = [];
  const closed: string[] = [];
  return {
    requested, closed,
    fetch: async (url: string, signal?: AbortSignal): Promise<FetchedPublicResponse> => {
      assert.ok(signal, "every public lookup must have a timeout/cancellation signal");
      requested.push(url);
      const result = responses[url] ?? responses.search;
      assert.ok(result, `Unexpected request: ${url}`);
      return { url, response: new PublicResponse(result.body, { status: result.status ?? 200, headers: result.length ? { "content-length": String(result.length) } : undefined }), close: async () => { closed.push(url); } };
    },
  };
}
const head = (extra = "", pageDoi = doi, pageTitle = title) => `<head><meta name="citation_title" content="${pageTitle}"><meta name="citation_doi" content="${pageDoi}">${extra}</head>`;

test("title lookup returns up to five deduplicated candidates with identity hints and public field sources", async () => {
  const f = fixture({ search: { body: JSON.stringify({ message: { items: [work(), work(), work({ DOI: "10.1234/other", title: ["Unrelated result"], "container-title": [], publisher: "TEST Preprint Platform", type: "posted-content" }), {}, work({ DOI: "10.1234/third", abstract: "<jats:p>TEST public original abstract</jats:p>" }), work({ DOI: "10.1234/sixth" })] } }) } });
  const result = await lookupMetadata({ action: "search", title }, f.fetch);
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates[0].match, "exact");
  assert.equal(result.candidates[1].match, "different");
  assert.equal(result.candidates[1].publication, "TEST Preprint Platform");
  assert.equal(result.candidates[1].workType, "posted-content");
  assert.deepEqual(result.candidates[0].metadata.authors, ["Test Author", "Test Consortium"]);
  assert.equal(result.candidates[0].metadata.year, 2024);
  assert.equal(result.candidates[0].publication, "TEST Journal");
  assert.equal(result.candidates[0].workType, "journal-article");
  assert.equal(result.candidates[2].metadata.abstract, "TEST public original abstract");
  assert.equal(result.candidates[0].metadata.abstract, undefined);
  assert.match(result.candidates[0].warnings[0], /未提供.*摘要/);
  assert.equal(new URL(f.requested[0]).searchParams.get("rows"), "5");
  assert.equal(new URL(f.requested[0]).searchParams.get("query.title"), title);
  assert.equal(result.candidates[0].provenance[0].url, endpoint);
  assert.equal(result.candidates[0].provenance[0].fields.includes("abstract"), false);
  assert.equal(f.requested.length, 1, "title search never fetches publisher text or PDFs");
  assert.deepEqual(f.closed, f.requested);
});

test("exact DOI detail preserves registered metadata and gets a missing abstract from an identity-checked publisher", async () => {
  const f = fixture({
    [endpoint]: { body: JSON.stringify({ message: work() }) },
    [publisher]: { body: `${head('<meta name="citation_abstract" content="TEST complete original abstract.">')}<body>Full text not returned</body>` },
  });
  const result = await lookupMetadata({ action: "detail", source: doi, title }, f.fetch);
  const candidate = result.candidates[0];
  assert.equal(candidate.metadata.abstract, "TEST complete original abstract.");
  assert.equal(candidate.metadata.doi, doi);
  assert.equal(candidate.match, "exact");
  assert.equal(candidate.publication, "TEST Journal");
  assert.equal(candidate.workType, "journal-article");
  assert.deepEqual(candidate.provenance[1].fields, ["abstract"]);
  assert.equal(candidate.provenance[1].url, publisher);
  assert.deepEqual(candidate.warnings, []);
  assert.deepEqual(f.requested, [endpoint, publisher]);
});

test("registered abstracts do not trigger extra publisher requests", async () => {
  const f = fixture({ [endpoint]: { body: JSON.stringify({ message: work({ abstract: "<p>TEST registered abstract</p>" }) }) } });
  const result = await lookupMetadata({ action: "detail", source: `https://doi.org/${doi}`, title }, f.fetch);
  assert.equal(result.candidates[0].metadata.abstract, "TEST registered abstract");
  assert.deepEqual(f.requested, [endpoint]);
});

test("publisher SEO snippets, comments, scripts and abstract previews cannot become an abstract", () => {
  for (const html of [
    head('<meta name="description" content="TEST truncated preview...">'),
    head('<meta name="dc.description" content="TEST truncated preview..."><meta property="og:description" content="TEST preview...">'),
    `${head()}<script><section data-title="Abstract"><h2>Abstract</h2><p>This is a fake reference abstract with many words.</p></section></script>`,
    `${head()}<!-- <meta name="citation_abstract" content="TEST hidden"> -->`,
    `${head()}<section data-title="References"><h2>Abstract</h2><p>Reference abstract text should never be imported.</p></section>`,
  ]) assert.equal(parseEnrichmentHtml(html).metadata.abstract, undefined);
});

test("an explicit article Abstract section can provide the original abstract", () => {
  const result = parseEnrichmentHtml(`${head()}<section data-title="Abstract" aria-labelledby="Abs1"><h2 id="Abs1">Abstract</h2><div><p>TEST article original abstract containing complete sentences.</p><p>TEST second original paragraph.</p></div></section><section><h2>Results</h2><p>Do not import results.</p></section>`);
  assert.equal(result.metadata.abstract, "TEST article original abstract containing complete sentences.\n\nTEST second original paragraph.");
  assert.equal(result.abstractLabel, "出版商 Abstract 段");
});

test("mismatched publisher DOI and matching-looking titles cannot enrich a selected DOI", async () => {
  for (const [pageDoi, pageTitle] of [["10.1234/wrong", title], [doi, "Unrelated title"]]) {
    const f = fixture({ [endpoint]: { body: JSON.stringify({ message: work() }) }, [publisher]: { body: head('<meta name="citation_abstract" content="WRONG ABSTRACT">', pageDoi, pageTitle) } });
    const result = await lookupMetadata({ action: "detail", source: doi, title }, f.fetch);
    assert.equal(result.candidates[0].metadata.abstract, undefined);
    assert.equal(result.candidates[0].provenance.length, 1);
    assert.match(result.warnings[0], /无法核对/);
  }
});

test("a Crossref DOI mismatch rejects all fields instead of applying the first response", async () => {
  const f = fixture({ [endpoint]: { body: JSON.stringify({ message: work({ DOI: "10.1234/wrong" }) }) } });
  await assert.rejects(() => lookupMetadata({ action: "detail", source: doi, title }, f.fetch), /不同 DOI/);
  assert.deepEqual(f.requested, [endpoint]);
});

test("publisher fetch failures preserve verified DOI candidates and never invent missing abstracts", async () => {
  const f = fixture({ [endpoint]: { body: JSON.stringify({ message: work() }) }, [publisher]: { body: "Forbidden", status: 403 } });
  const result = await lookupMetadata({ action: "detail", source: doi, title: "Different paper" }, f.fetch);
  assert.equal(result.candidates[0].metadata.title, title);
  assert.equal(result.candidates[0].metadata.abstract, undefined);
  assert.equal(result.candidates[0].match, "different");
  assert.match(result.warnings[0], /403/);
  assert.deepEqual(f.closed, f.requested);
});

test("publisher URL details merge only explicitly identified original abstracts and record provenance", async () => {
  const f = fixture({ [publisher]: { body: head('<meta name="citation_abstract" content="TEST complete explicit publisher abstract">') }, [endpoint]: { body: JSON.stringify({ message: work() }) } });
  const result = await lookupMetadata({ action: "detail", source: publisher, title }, f.fetch);
  assert.equal(result.candidates[0].metadata.sourceUrl, publisher);
  assert.equal(result.candidates[0].metadata.abstract, "TEST complete explicit publisher abstract");
  assert.equal(result.candidates[0].provenance.length, 2);
  assert.deepEqual(f.requested, [publisher, endpoint]);
});

test("public metadata responses are bounded and always close their streams", async () => {
  const f = fixture({ search: { body: "{}", length: 2 * 1024 * 1024 + 1 } });
  await assert.rejects(() => lookupMetadata({ action: "search", title }, f.fetch), /暂时无法读取/);
  assert.deepEqual(f.closed, f.requested);
});

test("query cancellation rejects without falling back to another source", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture({});
  await assert.rejects(() => lookupMetadata({ action: "search", title }, f.fetch, controller.signal), /已取消/);
  assert.deepEqual(f.requested, []);
});

test("metadata route rejects cross-site requests and non-JSON or unknown fields before lookup", async () => {
  const request = (body: unknown, headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3000/api/kb/metadata", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await POST(request({ action: "search", title }, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await POST(request({ action: "search", title }, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await POST(request({ action: "search", title, notes: "PRIVATE_NOTE" }))).status, 400);
  assert.equal((await POST(request({ action: "detail", source: publisher, pdf: "PRIVATE_PDF" }))).status, 400);
  assert.equal(metadataLookupSchema.safeParse({ action: "search", title: "x" }).success, false);
});
