import { test } from "node:test";
import assert from "node:assert/strict";
import { aiErrorRecovery } from "../src/lib/ai-error-recovery";

test("explicit missing configuration and authentication failures suggest settings", () => {
  for (const message of ["未配置 AI 提供方", "Codex CLI 未登录", "模型 fixture-model 不存在", "服务返回 401 Unauthorized", "请在设置中选择提供方并填写模型名称；基础功能不依赖 AI。"])
    assert.equal(aiErrorRecovery(message).kind, "configuration");
});

test("timeouts and temporary network failures keep recovery in the current task", () => {
  for (const message of ["AI 请求超时", "Failed to fetch", "connect ECONNREFUSED", "429 rate limit exceeded"])
    assert.equal(aiErrorRecovery(message).kind, "connection");
});

test("unreadable sources request source changes rather than model settings", () => {
  for (const message of ["PDF 读取失败", "未提取到可用文本", "请重新选择这篇文献中的文字。"])
    assert.equal(aiErrorRecovery(message).kind, "source");
});

test("an output validation error is not misrepresented as broken configuration", () => {
  assert.equal(aiErrorRecovery("模型输出未通过结构校验，请重试。").kind, "request");
});
