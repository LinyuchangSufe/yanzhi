import assert from "node:assert/strict";
import test from "node:test";
import { plainTextPreview } from "../src/lib/plain-text-preview";

test("preview strips Markdown presentation and links while preserving readable meaning", () => {
  const source = "# 我的想法\n\n## 问题与动机\n\n**比较** [已有论文](kb://paper/a) 与 `SGD`，公式 $x_t^2$。\n\n- 第一步\n- 第二步\n\n![局部图](image.png)";
  assert.equal(plainTextPreview(source, { title: "我的想法", maxLength: 200 }), "问题与动机 比较 已有论文 与 SGD，公式 x_t^2。 第一步 第二步 局部图");
  assert.ok(source.startsWith("# 我的想法"), "excerpt generation never edits the source document");
});
test("preview removes an exact duplicate title without dropping different headings or code", () => {
  assert.equal(plainTextPreview("研究问题\n\n### 不同的小标题\n\n```text\n保留算法描述\n```", { title: "研究问题" }), "不同的小标题 保留算法描述");
  assert.equal(plainTextPreview("# C++\n\n说明", { title: "C" }), "C++ 说明");
  assert.equal(plainTextPreview("# 我的想法：\n\n正文", { title: " 我的想法 " }), "正文");
  assert.equal(plainTextPreview("SGD paper Author · 2026 This paper studies learning.", { title: "SGD paper" }), "Author · 2026 This paper studies learning.");
  assert.equal(plainTextPreview("新的研究想法：在线学习与步长机制", { title: "新的研究想法" }), "在线学习与步长机制");
  assert.equal(plainTextPreview("SGDifferent has another meaning", { title: "SGD" }), "SGDifferent has another meaning");
});
test("preview handles nested text, references and Unicode truncation without broken characters", () => {
  assert.equal(plainTextPreview("[已有资料][source]\n\n[source]: https://example.org/private-path\n\n正文"), "已有资料 正文");
  assert.equal(plainTextPreview("**想法**🙂甲乙丙丁", { maxLength: 5 }), "想法🙂甲…");
  assert.equal(plainTextPreview("", { maxLength: 10 }), "");
  assert.equal(plainTextPreview("正文", { maxLength: 0 }), "");
});
