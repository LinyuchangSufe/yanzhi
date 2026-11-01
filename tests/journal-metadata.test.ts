import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Response as PublicResponse } from "undici";
import { KBStore, normalizeIdentifiers } from "../src/lib/db";
import { createBackup, restoreBackup } from "../src/lib/archive";
import { doiFromSourceUrl } from "../src/lib/import/identifiers";
import { parseHtmlMetadata } from "../src/lib/import/html-metadata";
import { resolveMetadata } from "../src/lib/import/metadata";
import type { FetchedPublicResponse } from "../src/lib/import/download";

const source = "https://www.tandfonline.com/doi/full/10.1080/01621459.2026.2674413";
const doi = "10.1080/01621459.2026.2674413";
const endpoint = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
const crossref = (data: Record<string, unknown> = {}) => JSON.stringify({message: {
  DOI: doi,
  title: ["TEST: A &amp; B"],
  author: [{given: "First", family: "Author"}, {given: "Second", family: "Author"}, {name: "Test Consortium"}],
  published: {"date-parts": [[2026, 4, 3]]},
  abstract: "<jats:p>Original &lt;data&gt; &#8212; abstract.</jats:p>",
  ...data,
}});
function fixtures(responses: Record<string, {body: string; status?: number; headers?: Record<string, string>}>) {
  const requested: string[] = [];
  const closed: string[] = [];
  return {
    requested,
    closed,
    fetch: async (url: string): Promise<FetchedPublicResponse> => {
      requested.push(url);
      const fixture = responses[url];
      assert.ok(fixture, `Unexpected request: ${url}`);
      return {
        response: new PublicResponse(fixture.body, {status: fixture.status ?? 200, headers: fixture.headers}),
        url,
        close: async () => { closed.push(url); },
      };
    },
  };
}

test("publisher DOI routes identify one article and ignore query/hash tracking", () => {
  for (const mode of ["full", "abs", "abstract", "pdf", "epdf", "pdfplus", "reader", "am-pdf"]) {
    assert.equal(doiFromSourceUrl(`https://publisher.example/doi/${mode}/10.1080/ABC.123?ref=10.1234/other#references`), "10.1080/abc.123");
  }
  assert.equal(doiFromSourceUrl("https://publisher.example/doi/10.1234/Some%2FSuffix"), "10.1234/some/suffix");
  assert.equal(doiFromSourceUrl("https://link.springer.com/article/10.1007/s00180-026-01234-5"), "10.1007/s00180-026-01234-5");
  assert.equal(doiFromSourceUrl("https://doi.org/10.1234%2FTEST?q=ignore"), "10.1234/test");
  assert.equal(normalizeIdentifiers({sourceUrl: source}).doi, doi);
});

test("DOI extraction never mines queries, lists, references, credentials or nested article URLs", () => {
  for (const url of [
    "https://publisher.example/search?q=10.1234/test",
    "https://publisher.example/issues/10.1234/test",
    "https://publisher.example/doi/full/10.1234/test/references",
    "https://publisher.example/doi/full/10.1234/test/10.5678/other",
    "https://publisher.example/go?url=https://doi.org/10.1234/test",
    "https://user:password@publisher.example/doi/10.1234/test",
    "https://publisher.example/doi/10.1234/test%20title",
    "https://publisher.example/doi/10.1234/%E0%A4%A",
    "file:///doi/10.1234/test",
  ]) assert.equal(doiFromSourceUrl(url), "", url);
});

test("journal URL uses Crossref before publisher HTML and preserves the exact source", async () => {
  const fixture = fixtures({[endpoint]: {body: crossref()}});
  const result = await resolveMetadata(`${source}?campaign=example#abstract`, fixture.fetch);
  assert.equal(result.metadata.sourceUrl, `${source}?campaign=example#abstract`);
  assert.equal(result.metadata.doi, doi);
  assert.equal(result.metadata.title, "TEST: A & B");
  assert.deepEqual(result.metadata.authors, ["First Author", "Second Author", "Test Consortium"]);
  assert.equal(result.metadata.year, 2026);
  assert.equal(result.metadata.abstract, "Original <data> — abstract.");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(fixture.requested, [endpoint]);
  assert.deepEqual(fixture.closed, [endpoint]);
});

test("publisher HTML fallback reads all authors, entity-safe values and publication dates", async () => {
  const html = `<META CONTENT='TEST: A &quot;quoted&quot; title &amp; O&#39;Brien' NAME='citation_title'>
    <meta name=citation_author content='Alpha O&#x27;Brien'>
    <meta content="Beta &amp; Gamma" name="citation_author">
    <meta name="citation_publication_date" content="2025/06/12">
    <meta name="citation_doi" content="${doi}">
    <meta name="citation_abstract" content="A &gt; B; &#945; is a symbol.">`;
  const fixture = fixtures({[endpoint]: {body: "Unavailable", status: 503}, [source]: {body: html}});
  const result = await resolveMetadata(source, fixture.fetch);
  assert.equal(result.metadata.title, 'TEST: A "quoted" title & O\'Brien');
  assert.deepEqual(result.metadata.authors, ["Alpha O'Brien", "Beta & Gamma"]);
  assert.equal(result.metadata.year, 2025);
  assert.equal(result.metadata.abstract, "A > B; α is a symbol.");
  assert.equal(result.metadata.doi, doi);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(fixture.requested, [endpoint, source]);
  assert.deepEqual(fixture.closed, [endpoint, source]);
});

test("HTML-derived citation DOI can enrich a journal URL without erasing page fields", async () => {
  const url = "https://publisher.example/journal/article/1234";
  const fixture = fixtures({
    [url]: {body: `<meta name="citation_title" content="TEST page title"><meta name="citation_doi" content="https://doi.org/${doi}"><meta name="citation_abstract" content="TEST original abstract">`},
    [endpoint]: {body: crossref({abstract: undefined, published: undefined, "published-online": {"date-parts": [[2024]]}})},
  });
  const result = await resolveMetadata(url, fixture.fetch);
  assert.equal(result.metadata.title, "TEST: A & B");
  assert.equal(result.metadata.abstract, "TEST original abstract");
  assert.equal(result.metadata.year, 2024);
  assert.equal(result.metadata.sourceUrl, url);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(fixture.requested, [url, endpoint]);
});

test("mismatched DOI responses cannot import another paper's title or authors", async () => {
  const fixture = fixtures({
    [endpoint]: {body: crossref({DOI: "10.1234/different"})},
    [source]: {body: '<meta name="citation_doi" content="10.5678/wrong"><meta name="citation_title" content="Wrong paper"><meta name="citation_author" content="Wrong author">'},
  });
  const result = await resolveMetadata(source, fixture.fetch);
  assert.equal(result.metadata.doi, doi);
  assert.equal(result.metadata.sourceUrl, source);
  assert.equal(result.metadata.title, undefined);
  assert.equal(result.metadata.authors, undefined);
  assert.equal(result.warnings.length, 1);
});

test("publisher restrictions retain known DOI and source without treating challenge text as a title", async () => {
  for (const page of [
    {body: "Forbidden", status: 403},
    {body: '<title>Just a moment...</title><meta name="description" content="Checking your browser">'},
  ]) {
    const fixture = fixtures({[endpoint]: {body: "Unavailable", status: 404}, [source]: page});
    const result = await resolveMetadata(source, fixture.fetch);
    assert.equal(result.metadata.doi, doi);
    assert.equal(result.metadata.title, undefined);
    assert.equal(result.metadata.abstract, undefined);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /PDF.*自行上传/);
  }
});

test("metadata body limits are retained and close both oversized Crossref and publisher responses", async () => {
  const fixture = fixtures({
    [endpoint]: {body: "{}", headers: {"content-length": String(2 * 1024 * 1024 + 1)}},
    [source]: {body: '<meta name="citation_title" content="Too large">', headers: {"content-length": String(2 * 1024 * 1024 + 1)}},
  });
  const result = await resolveMetadata(source, fixture.fetch);
  assert.equal(result.metadata.title, undefined);
  assert.equal(result.metadata.doi, doi);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(fixture.closed, [endpoint, source]);
});

test("PDF routes resolve DOI metadata without downloading restricted or large full text", async () => {
  const url = source.replace("/full/", "/pdf/");
  const fixture = fixtures({[endpoint]: {body: "Unavailable", status: 404}});
  const result = await resolveMetadata(url, fixture.fetch);
  assert.equal(result.metadata.doi, doi);
  assert.equal(result.metadata.sourceUrl, url);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(fixture.requested, [endpoint]);
});

test("ordinary page import does not mine referenced DOI links or ambiguous citation identifiers", async () => {
  const url = "https://publisher.example/journal/current";
  const fixture = fixtures({[url]: {body: '<title>TEST journal index</title><a href="https://doi.org/10.1234/reference">Reference</a>'}});
  const result = await resolveMetadata(url, fixture.fetch);
  assert.equal(result.metadata.title, "TEST journal index");
  assert.equal(result.metadata.doi, "");
  assert.deepEqual(fixture.requested, [url]);
  assert.equal(parseHtmlMetadata('<meta name="citation_doi" content="10.1234/one"><meta name="citation_doi" content="10.1234/two">').doi, undefined);
  const headOnly = parseHtmlMetadata('<head><title>TEST own title</title><!-- <meta name="citation_doi" content="10.1234/comment"> --><script>"<meta name=\'citation_doi\' content=\'10.1234/script\'>"</script></head><body><meta name="citation_doi" content="10.1234/reference"></body>');
  assert.equal(headOnly.title, "TEST own title");
  assert.equal(headOnly.doi, undefined);
});

test("arXiv metadata import still preserves version and all authors", async () => {
  const endpoint = "https://export.arxiv.org/api/query?id_list=2601.01234v2";
  const fixture = fixtures({[endpoint]: {body: '<feed><entry><title>TEST arXiv title</title><summary>TEST abstract</summary><published>2026-01-01</published><author><name>Author One</name></author><author><name>Author Two</name></author></entry></feed>'}});
  const result = await resolveMetadata("arxiv:2601.01234v2", fixture.fetch);
  assert.equal(result.metadata.arxivId, "2601.01234");
  assert.equal(result.metadata.arxivVersion, 2);
  assert.deepEqual(result.metadata.authors, ["Author One", "Author Two"]);
  assert.equal(result.metadata.year, 2026);
  assert.deepEqual(result.warnings, []);
});

test("saved publisher URLs normalize DOI for deduplication without a metadata fetch", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kb-journal-import-"));
  const store = new KBStore(dir);
  try {
    store.dispatch("paper.create", {title: "TEST publisher source", sourceUrl: source});
    assert.equal(store.snapshot().papers[0].doi, doi);
    assert.equal(store.snapshot().papers[0].sourceUrl, source);
    assert.throws(() => store.dispatch("paper.create", {title: "TEST same DOI", doi}), /DOI|已存在|重复/);
    assert.equal(store.snapshot().papers.length, 1);
  } finally {
    store.db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test("legacy publisher source-only snapshots and full backups restore identifiers without enrichment or merging", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-legacy-journal-"));
  const legacy = new KBStore(path.join(root, "legacy"));
  const direct = new KBStore(path.join(root, "direct"));
  let restored: KBStore | undefined;
  try {
    legacy.dispatch("paper.create", {title: "TEST legacy source-only record"});
    const id = legacy.snapshot().papers[0].id;
    // Model the persisted row written before publisher-URL DOI recognition.
    legacy.db.prepare("UPDATE papers SET source_url=? WHERE id=?").run(source, id);
    legacy.dispatch("paper.create", {title: "TEST separate existing DOI record", doi});
    const snapshot = legacy.snapshot();
    assert.equal(snapshot.papers.find((paper) => paper.id === id)?.doi, "");
    assert.equal(normalizeIdentifiers(snapshot.papers.find((paper) => paper.id === id)!).doi, doi);

    direct.importSnapshot(snapshot);
    assert.deepEqual(direct.snapshot(), snapshot);
    const result = restoreBackup(createBackup(legacy), root);
    restored = new KBStore(result.restoredDirectory);
    assert.deepEqual(restored.snapshot(), snapshot);
    assert.equal(restored.snapshot().papers.length, 2);
    assert.equal(restored.snapshot().papers.find((paper) => paper.id === id)?.sourceUrl, source);
    assert.equal(restored.snapshot().papers.find((paper) => paper.id === id)?.doi, "");
    assert.deepEqual(legacy.snapshot(), snapshot);
  } finally {
    restored?.close();
    direct.close();
    legacy.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test("snapshot imports still reject unnormalized explicitly saved identifiers", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-journal-validation-"));
  const sourceStore = new KBStore(path.join(root, "source"));
  const target = new KBStore(path.join(root, "target"));
  try {
    sourceStore.dispatch("paper.create", {title: "TEST identifier validation", doi});
    const snapshot = sourceStore.snapshot();
    snapshot.papers[0].doi = `https://doi.org/${doi}`;
    assert.throws(() => target.importSnapshot(snapshot), /未规范化/);
    assert.equal(target.snapshot().papers.length, 0);
  } finally {
    target.close();
    sourceStore.close();
    rmSync(root, {recursive: true, force: true});
  }
});
