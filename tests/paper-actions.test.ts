import { test } from "node:test";
import assert from "node:assert/strict";
import { paperSource } from "../src/lib/paper-actions";

test("paper actions use a saved HTTP source and fall back to valid DOI or arXiv identifiers", () => {
  const paper = { sourceUrl: "https://projecteuclid.org/journals/example", doi: "10.1214/25-AOS2588", arxivId: "2601.01234" };
  assert.equal(paperSource(paper), paper.sourceUrl);
  assert.equal(paperSource({ ...paper, sourceUrl: "" }), "https://doi.org/10.1214/25-AOS2588");
  assert.equal(paperSource({ ...paper, sourceUrl: "", doi: "https://doi.org/10.1214/25-AOS2588" }), "https://doi.org/10.1214/25-AOS2588");
  assert.equal(paperSource({ sourceUrl: "", doi: "", arxivId: "2601.01234v2" }), "https://arxiv.org/abs/2601.01234v2");
  assert.equal(paperSource({ sourceUrl: "", doi: "", arxivId: "math.ST/0601234" }), "https://arxiv.org/abs/math.ST/0601234");
  assert.equal(paperSource({ sourceUrl: "", doi: "", arxivId: "2601.01234", arxivVersion: 3 }), "https://arxiv.org/abs/2601.01234v3");
  assert.equal(paperSource({ sourceUrl: "", doi: "", arxivId: "2601.01234v2", arxivVersion: 3 }), "https://arxiv.org/abs/2601.01234v2");
  assert.equal(paperSource({ sourceUrl: "", doi: "", arxivId: "2601.01234", arxivVersion: null }), "https://arxiv.org/abs/2601.01234");
});

test("paper action links reject executable schemes, embedded credentials and malformed identifiers", () => {
  for (const sourceUrl of ["javascript:alert(1)", "data:text/html,unsafe", "file:///private/test.pdf", "https://user:password@example.org/paper", "not a URL"])
    assert.equal(paperSource({ sourceUrl, doi: "", arxivId: "" }), "");
  assert.equal(paperSource({ sourceUrl: "javascript:alert(1)", doi: "10.1214/25-AOS2588", arxivId: "" }), "https://doi.org/10.1214/25-AOS2588");
  assert.equal(paperSource({ sourceUrl: "", doi: "missing/doi", arxivId: "../../private/secret" }), "");
  assert.equal(paperSource({ sourceUrl: "", doi: "10.1234/path?query#fragment", arxivId: "" }), "https://doi.org/10.1234/path%3Fquery%23fragment");
});
