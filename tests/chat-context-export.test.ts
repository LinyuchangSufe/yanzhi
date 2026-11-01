import assert from "node:assert/strict";
import test from "node:test";
import { exportChatContextsMarkdown } from "../src/lib/paper-chat/context-export";
import type { ChatContext } from "../src/lib/paper-chat/types";

test("chat context export preserves formula snapshots and a valid source link despite title punctuation", () => {
  const text = "公式 $\\alpha+\\beta=1$\n\n$$\nx^2\n$$";
  const snapshot: ChatContext = {
    noteId: "91b47adc-5b0f-4ad8-81c9-0d7aa234d61e", title: "想法 [A]\n第二行", purpose: "idea", revision: 3,
    mode: "excerpt", field: "body", text, start: 5, end: 5 + text.length,
    sourceHref: "kb://note/91b47adc-5b0f-4ad8-81c9-0d7aa234d61e",
  };
  const output = exportChatContextsMarkdown([snapshot]);
  assert.ok(output.includes("[想法 \\[A\\] 第二行](" + snapshot.sourceHref + ")"));
  assert.ok(output.includes("修订 3"));
  assert.ok(output.includes("非 PDF 原文"));
  assert.ok(output.includes("> 公式 $\\alpha+\\beta=1$\n> \n> $$\n> x^2\n> $$"));
});

test("legacy questions without contexts add no export text", () => {
  assert.equal(exportChatContextsMarkdown(), "");
  assert.equal(exportChatContextsMarkdown([]), "");
});
