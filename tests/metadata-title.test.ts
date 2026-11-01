import assert from "node:assert/strict";
import { test } from "node:test";
import { pdfTitlesAgree } from "../src/lib/import/metadata-title";

test("PDF title verification accepts LoRA small caps, inserted spaces and capitalization", () => {
  assert.equal(
    pdfTitlesAgree(
      "L O R A: LOW-RANK ADAPTATION OF LARGE LANGUAGE MODELS",
      "LoRA: Low-Rank Adaptation of Large Language Models",
    ),
    true,
  );
  assert.equal(
    pdfTitlesAgree(
      "Low Rank Adaptation of Large Language Models",
      "LoRA: Low-Rank Adaptation of Large Language Models",
    ),
    true,
  );
});
test("PDF title verification normalizes punctuation and Unicode forms", () => {
  assert.equal(
    pdfTitlesAgree(
      "Ａ Unified Analysis：Stochastic－Gradient Descent",
      "A Unified Analysis: Stochastic Gradient Descent",
    ),
    true,
  );
  assert.equal(
    pdfTitlesAgree(
      "相依数据下的在线学习：理论与方法",
      "相依数据下的在线学习—理论与方法",
    ),
    true,
  );
});
test("PDF title verification rejects different papers despite generic shared words", () => {
  assert.equal(
    pdfTitlesAgree(
      "Adam: A Method for Stochastic Optimization",
      "Attention Is All You Need",
    ),
    false,
  );
  assert.equal(
    pdfTitlesAgree(
      "Scaling Laws for Neural Language Models",
      "Language Models Are Few-Shot Learners",
    ),
    false,
  );
  assert.equal(
    pdfTitlesAgree(
      "Research Method for Quantum Optimization",
      "Research Method for Clinical Diagnosis",
    ),
    false,
  );
  assert.equal(
    pdfTitlesAgree("Research Method", "Research Method for Clinical Diagnosis"),
    false,
  );
  assert.equal(
    pdfTitlesAgree("Research Methods for X", "Research Methods for Y"),
    false,
  );
  assert.equal(
    pdfTitlesAgree("相依数据下的在线学习", "随机图上的渐近统计推断"),
    false,
  );
});
test("PDF title verification rejects short title fragments", () => {
  assert.equal(pdfTitlesAgree("Attention", "Attention Is All You Need"), false);
  assert.equal(
    pdfTitlesAgree(
      "Optimization",
      "An Extensive Survey of Optimization in Deep Learning",
    ),
    false,
  );
});
test("PDF title verification requires actual titles", () => {
  assert.equal(pdfTitlesAgree("", "A Study of Optimization"), false);
  assert.equal(pdfTitlesAgree("Some title", ""), false);
});
