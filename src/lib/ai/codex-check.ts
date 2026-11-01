import { StoreError } from "../db";
import { checkCodex, runCodex, type CodexStatus } from "./codex";

export interface CodexConnectionStatus extends CodexStatus {
  service: "available" | "unavailable" | "not-tested";
  model: string;
  checkedAt: string;
  elapsedMs: number;
  errorStatus?: number;
}

/** No library content or arbitrary instructions enter this explicitly requested probe. */
export async function testCodexConnection(input: {
  model?: string;
  signal?: AbortSignal;
}): Promise<CodexConnectionStatus> {
  const started = Date.now();
  const model = input.model?.trim() || "cli-default";
  const status = await checkCodex(input.signal);
  const finish = (
    result: Pick<CodexConnectionStatus, "service" | "message"> &
      Partial<
        Pick<CodexConnectionStatus, "model" | "errorStatus" | "authenticated">
      >,
  ): CodexConnectionStatus => ({
    ...status,
    model,
    ...result,
    checkedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
  });
  if (!status.installed || !status.authenticated)
    return finish({ service: "not-tested", message: status.message });
  try {
    const result = await runCodex({
      prompt:
        "Connection test only. Reply with exactly KB_CODEX_OK and nothing else. Do not use tools, read files, or access any other resources.",
      model: model === "cli-default" ? undefined : model,
      summary: false,
      maxDurationMs: 45000,
      signal: input.signal,
    });
    if (result.text.trim() !== "KB_CODEX_OK")
      return finish({
        service: "unavailable",
        errorStatus: 502,
        message: "Codex 已返回响应，但测试回复校验失败，请检查模型设置后重试。",
      });
    return finish({
      service: "available",
      model: result.model,
      message:
        "连接测试通过，模型已正确回复。此结果仅代表本次测试；生成时仍受网络和账户额度影响。",
    });
  } catch (error) {
    if (
      input.signal?.aborted ||
      (error instanceof StoreError && error.status === 499)
    )
      throw error;
    const safe = error instanceof StoreError ? error : undefined;
    return finish({
      service: safe?.status === 409 ? "not-tested" : "unavailable",
      errorStatus: safe?.status || 502,
      ...(safe?.status === 422 && /登录|授权已过期/.test(safe.message)
        ? { authenticated: false }
        : {}),
      message:
        safe?.message ||
        "Codex 连接测试失败，请检查 CLI、网络和模型设置后重试。",
    });
  }
}
