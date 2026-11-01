import assert from "node:assert/strict";
import test from "node:test";
import {
  candidateValues, defaultMetadataFields, metadataContextKey, metadataQuery,
  metadataDoiConflict, metadataSourceUrl, selectedMetadataChanges, type MetadataValues,
} from "../src/lib/metadata-enrichment";
import type { MetadataCandidate } from "../src/lib/import/enrichment-types";

const original: MetadataValues = {
  title: "Loss of plasticity in deep continual learning", authors: "", year: "",
  doi: "", arxiv: "", source: "", abstract: "My manually entered abstract",
};
const candidate: MetadataCandidate = {
  id: "test", match: "exact", metadata: {
    title: original.title, authors: ["Test Author"], year: 2024,
    doi: "10.1234/test", sourceUrl: "https://doi.org/10.1234/test",
    abstract: "Public abstract",
  }, provenance: [{ label: "Crossref", url: "https://api.crossref.org/works/10.1234%2Ftest", fields: ["authors", "year"] }], warnings: [],
};

test("a title-only paper uses explicit title search; identifiers prefer exact lookup", () => {
  assert.deepEqual(metadataQuery(original), { action: "search", title: original.title });
  assert.deepEqual(metadataQuery({ ...original, doi: "10.1234/test", source: "https://publisher.test/paper" }),
    { action: "detail", source: "10.1234/test", title: original.title });
  assert.deepEqual(metadataQuery({ ...original, arxiv: "2601.01234v2" }),
    { action: "detail", source: "arxiv:2601.01234v2", title: original.title });
  assert.deepEqual(metadataQuery({ ...original, doi: "10.1234/test" }, true),
    { action: "search", title: original.title });
  assert.equal(metadataQuery({ ...original, title: "" }), null);
});

test("comparison defaults select only missing fields and never erase unavailable metadata", () => {
  const proposed = candidateValues(candidate);
  assert.deepEqual(defaultMetadataFields(original, proposed), ["authors", "year", "doi", "source"]);
  assert.equal(proposed.arxiv, "");
  assert.deepEqual(selectedMetadataChanges(original, original, proposed, ["arxiv"]), { changes: {}, skipped: [] });
  assert.equal(original.abstract, "My manually entered abstract");
});

test("existing values change only when explicitly selected and unchanged since preview", () => {
  const proposed = candidateValues(candidate);
  const defaults = defaultMetadataFields(original, proposed);
  const result = selectedMetadataChanges(original, original, proposed, defaults);
  assert.equal(result.changes.abstract, undefined);
  assert.deepEqual(selectedMetadataChanges(original, original, proposed, ["abstract"]).changes,
    { abstract: "Public abstract" });
  assert.equal(original.abstract, "My manually entered abstract", "selection must not mutate the source record");
});

test("typing after a preview wins over its selected candidate, while other missing fields may be filled", () => {
  const current = { ...original, authors: "My corrected author", abstract: "New personal correction" };
  assert.deepEqual(selectedMetadataChanges(current, original, candidateValues(candidate), ["authors", "year", "abstract"]),
    { changes: { year: "2024" }, skipped: ["authors", "abstract"] });
  assert.deepEqual(selectedMetadataChanges(current, current, candidateValues(candidate), ["authors"]),
    { changes: { authors: "Test Author" }, skipped: [] }, "a fresh comparison can be explicitly approved");
});

test("identity edits and PDF switches invalidate an older request, source links reject executable URLs", () => {
  const key = metadataContextKey(original, 1);
  for (const field of ["title", "source", "doi", "arxiv"] as const)
    assert.notEqual(metadataContextKey({ ...original, [field]: `${original[field]} changed` }, 1), key);
  assert.notEqual(metadataContextKey(original, 2), key);
  assert.equal(metadataSourceUrl("javascript:alert(1)"), null);
  assert.equal(metadataSourceUrl("https://user:secret@example.com"), null);
  assert.equal(metadataSourceUrl("https://doi.org/10.1234/test"), "https://doi.org/10.1234/test");
});

test("a candidate from another DOI is flagged even if the old DOI only exists in the journal URL", () => {
  const proposed = candidateValues(candidate);
  assert.equal(metadataDoiConflict({ ...original, doi: "10.1234/other" }, proposed), true);
  assert.equal(metadataDoiConflict({ ...original, source: "https://publisher.test/doi/full/10.1234/other" }, proposed), true);
  assert.equal(metadataDoiConflict({ ...original, doi: "https://doi.org/10.1234/TEST" }, proposed), false);
  assert.equal(metadataDoiConflict(original, proposed), false);
});
