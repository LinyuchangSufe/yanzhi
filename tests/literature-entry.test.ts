import assert from "node:assert/strict";
import test from "node:test";
import { isLiteratureHref, literatureReferenceQuery } from "../src/lib/literature-links";
import { markdownFromCopyTree } from "../src/lib/render/selection-markdown";
import { ideaMessageSchema } from "../src/lib/idea-lab/schemas";
import { ideaLiteratureLinks, verifyIdeaLinks } from "../src/lib/idea-lab/prompt";

test("paper collection actions recognize article identifiers without mistaking search pages, credentials or executable links", () => {
  for (const url of ["https://doi.org/10.1000/alpha", "https://publisher.example/doi/pdf/10.1000/beta", "https://arxiv.org/abs/1706.03762", "https://arxiv.org/pdf/math/0309136v2.pdf"]) assert.equal(isLiteratureHref(url), true, url);
  for (const url of ["https://example.org/search?q=10.1000/alpha", "https://arxiv.org.evil.example/abs/1706.03762", "https://arxiv.org/search?query=1706.03762", "https://user:secret@arxiv.org/abs/1706.03762", "javascript:alert(1)", "file:///private/article.pdf"]) assert.equal(isLiteratureHref(url), false, url);
  assert.equal(literatureReferenceQuery("Authors. The title. DOI: 10.1000/alpha. Other metadata"), "10.1000/alpha");
  assert.equal(literatureReferenceQuery("[1] Vaswani et al. Attention Is All You Need. arXiv:1706.03762 (2017)."), "1706.03762");
  assert.equal(literatureReferenceQuery("Author. arXiv: math/0309136v2."), "math/0309136v2");
  assert.equal(literatureReferenceQuery("Smith. Title. (https://doi.org/10.1234/test)."), "10.1234/test");
  assert.equal(literatureReferenceQuery("Title. (doi:10.1234/test(1997)abc)."), "10.1234/test(1997)abc");
  assert.equal(literatureReferenceQuery("  Author  2026\n An article title  "), "Author 2026 An article title");
});

test("copying a response preserves its paper link and omits the collection control", () => {
  const value = markdownFromCopyTree({ type: "root", children: [{ type: "element", tagName: "p", children: [
    { type: "element", tagName: "a", properties: { href: "https://arxiv.org/abs/1706.03762" }, children: [{ type: "text", value: "Paper" }] },
    { type: "element", tagName: "button", properties: { "data-md-copy-ignore": "true" }, children: [{ type: "text", value: "收藏" }] },
  ] }] });
  assert.equal(value, "[Paper](https://arxiv.org/abs/1706.03762)");
});

test("verified bibliographic links containing DOI parentheses remain exact citations", () => {
  const url = "https://doi.org/10.1000/example(unbalanced";
  const supplied = ideaLiteratureLinks([{ literatureSources: [url] }]);
  assert.doesNotThrow(() => verifyIdeaLinks([`[论文](<${url}>)`], [], supplied));
  assert.throws(() => verifyIdeaLinks(["[伪造](https://doi.org/10.1000/invented)"], [], supplied));
  const base = { id: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222", requestId: "33333333-3333-4333-8333-333333333333", role: "assistant", body: "reply", status: "completed", sources: [], provider: "codex", model: "fixture", error: "", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", literatureSources: [url] };
  assert.equal(ideaMessageSchema.safeParse(base).success, true);
  assert.equal(ideaMessageSchema.safeParse({ ...base, role: "user" }).success, false);
  for (const unsafe of ["bad-url", "javascript:alert(1)", "https://user:secret@example.org/a", "https://example.org/a<b"]) assert.equal(ideaMessageSchema.safeParse({ ...base, literatureSources: [unsafe] }).success, false);
});
