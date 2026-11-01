import test from "node:test";
import assert from "node:assert/strict";
import { originalTextOffset } from "../src/components/chat-context-selection";

test("textarea selections preserve original CRLF offsets and formulas", () => {
  const original = "标题\r\n公式 $x^2$\r\n最后一行";
  const displayed = original.replace(/\r\n?/g, "\n");
  const start = displayed.indexOf("公式");
  const end = displayed.indexOf("\n最后");
  assert.equal(original.slice(originalTextOffset(original, start), originalTextOffset(original, end)), "公式 $x^2$");
  assert.equal(originalTextOffset(original, displayed.length), original.length);
});

test("selection mapping handles mixed newlines, UTF-16 emoji and end bounds", () => {
  const original = "A\r\n🧠\rB\nC";
  const displayed = original.replace(/\r\n?/g, "\n");
  const start = displayed.indexOf("🧠");
  assert.equal(original.slice(originalTextOffset(original, start), originalTextOffset(original, start + 2)), "🧠");
  assert.equal(originalTextOffset(original, -2), 0);
  assert.equal(originalTextOffset(original, 999), original.length);
  assert.equal(originalTextOffset("plain\ntext", 6), 6);
});
