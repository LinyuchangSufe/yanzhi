import assert from "node:assert/strict";
import test from "node:test";
import {
  matchingTagNames,
  normalizeTagNames,
  parseTagInput,
  submittedTagNames,
  toggleTagName,
} from "../src/lib/tag-selection";

test("new tags accept either comma and saving includes text without an Enter key", () => {
  const saved = ["SGD", "统计理论"];
  assert.deepEqual(parseTagInput(" 在线学习，证明技巧,  "), ["在线学习", "证明技巧"]);
  assert.deepEqual(submittedTagNames(["统计理论"], " sgd, 新想法，SGD, 新想法 ", saved),
    ["统计理论", "SGD", "新想法"]);
  assert.deepEqual(saved, ["SGD", "统计理论"], "form preparation must not modify saved tags");
});

test("editing preserves preselected labels and cancelling one keeps all others", () => {
  const existing = ["SGD", "统计理论", "Theory, Method"];
  const selected = ["SGD", "Theory, Method"];
  assert.deepEqual(submittedTagNames(selected, "", existing), selected,
    "an existing label with a comma remains one label");
  assert.deepEqual(toggleTagName(selected, "sgd", existing), ["Theory, Method"]);
  assert.deepEqual(toggleTagName(selected, "统计理论", existing), [...selected, "统计理论"]);
  assert.deepEqual(selected, ["SGD", "Theory, Method"]);
});

test("typed existing names reuse saved spelling, trim whitespace and deduplicate case", () => {
  assert.deepEqual(normalizeTagNames([" sgd ", "SGD", "   ", " Local ", "local", "统计理论"], ["SGD"]),
    ["SGD", "Local", "统计理论"]);
  assert.deepEqual(submittedTagNames(["SGD"], " sgd，SGD ", ["SGD"]), ["SGD"]);
});

test("search only filters existing labels and cannot add its query to the submission", () => {
  const existing = ["在线学习", "SGD", "sgd", "统计理论"];
  assert.deepEqual(matchingTagNames(existing, "sg"), ["SGD"]);
  assert.deepEqual(matchingTagNames(existing, "统计"), ["统计理论"]);
  assert.deepEqual(matchingTagNames(existing, "new label"), []);
  assert.deepEqual(submittedTagNames(["SGD"], "", existing), ["SGD"]);
  assert.equal(matchingTagNames(existing, "").length, 3);
});
