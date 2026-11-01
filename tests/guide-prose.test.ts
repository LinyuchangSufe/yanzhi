import test from "node:test";
import assert from "node:assert/strict";
import { cleanGuideText } from "../src/lib/guide/text";

const first = "1d6797eb-4de5-4eba-80b0-ab818ef04e39:0:1";
const second = "1d6797eb-4de5-4eba-80b0-ab818ef04e39:2:4";

test("guide prose hides known bracketed and bare anchors across narrative and follow-up questions", () => {
  const text = `  原文条件 [${first}]\n分析判断 ${second}\n\n如何放宽该条件？ [${first}]  `;
  assert.equal(cleanGuideText(text, [first, second]), "原文条件\n分析判断\n\n如何放宽该条件？");
  assert.equal(cleanGuideText(`首处 [${first}]，再次 [${first}]；裸引用 ${first}`, [first]), "首处 ，再次 ；裸引用");
});

test("guide prose cleanup preserves scientific citations, ordinary quoted text and LaTeX", () => {
  const science = String.raw`由 [1] 和 [Smith et al., 2024]，在 [Eq. (2)] 的条件下有 $x_t=(1-\eta)^t x_0$。

$$\mathbb{E}[X\mid\mathcal F_t]\le C\sqrt{n}.$$

作者称 "bounded second moments"；详见 [Proof](https://example.org/proof)。`;
  assert.equal(cleanGuideText(`${science}\n\n[${first}]`, [first]), science);
  const unknown = "9fcbec20-746c-4e15-a872-89cfa6ea226d:0:1";
  assert.equal(cleanGuideText(`保留未登记文本 [${unknown}] 和 t=2026。`, [first]), `保留未登记文本 [${unknown}] 和 t=2026。`);
});

test("guide prose removes only evidence-only parentheticals with known abbreviated anchors", () => {
  const third = "1d6797eb-4de5-4eba-80b0-ab818ef04e39:0:4";
  for (const citation of ["（证据0:1）", "(证据 0:1)", "（证据0:1、0:4）", "(证据 0:1, 证据0:4)", "（ 证据0:1；证据0:4 ）"])
    assert.equal(cleanGuideText(`结论${citation}成立。`, [first, third]), "结论成立。");
  for (const preserved of ["(0:1)", "（0:1）", "（证据9:9）", "（证据0:1、9:9）", "（证据0:1说明了边界）", "（见证据0:1）", "[1, 4]", String.raw`$x=(0:1),\quad\text{证据0:1}$`, String.raw`$\left(\text{证据0:1}\right)$`])
    assert.equal(cleanGuideText(preserved, [first, third]), preserved);
  assert.equal(cleanGuideText("（证据0:1）", ["ordinary-reference:0:1"]), "（证据0:1）", "Only known UUID anchors supply abbreviated suffixes");
});

test("cleaning generated prose does not alter the separately retained literal evidence quote", () => {
  const evidence = { id: first, quote: `The literal source discusses [1], prints identifier ${first}, and contains （证据0:1）.`, explanation: "原文原样保留" };
  const original = structuredClone(evidence);
  const reportBody = cleanGuideText(`该段讨论了引用格式 [${evidence.id}]`, [evidence.id]);
  assert.equal(reportBody, "该段讨论了引用格式");
  assert.deepEqual(evidence, original);
  assert.ok(evidence.quote.includes(first), "Literal quotations must not be routed through prose cleanup");
});
