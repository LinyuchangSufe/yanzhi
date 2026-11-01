import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StoreError } from "../store-error";
import { codexEnvironment } from "./codex";
import type { ModelConfiguration } from "./request";

export interface ModelOption { id: string; label: string }
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Service-supplied catalog only; a listed model is not an entitlement guarantee. */
export function modelOptions(value: unknown, provider: string): ModelOption[] {
  const body = record(value);
  const entries = provider === "ollama" ? body.models : body.data;
  if (!Array.isArray(entries)) throw new StoreError("服务未返回可识别的模型列表，可手动填写模型 ID", 502);
  const seen = new Set<string>();
  return entries.slice(0, 300).flatMap((value) => {
    const item = record(value);
    const rawId = provider === "codex" ? item.model ?? item.id : provider === "ollama" ? item.name ?? item.model : item.id;
    if (item.hidden === true || typeof rawId !== "string" || /[\x00-\x1f\x7f]/.test(rawId)) return [];
    const id = rawId.trim();
    if (!id || id.length > 300 || seen.has(id)) return [];
    seen.add(id);
    const label = typeof item.displayName === "string" && item.displayName.trim() && item.displayName.length <= 300 && !/[\x00-\x1f\x7f]/.test(item.displayName) ? item.displayName.trim() : id;
    return [{ id, label }];
  });
}

/** Read-only initialize + model/list. It never creates a thread or generates text. */
export async function codexModelCatalog(signal?: AbortSignal): Promise<ModelOption[]> {
  if (signal?.aborted) throw new StoreError("读取模型列表已取消", 499);
  const cwd = await mkdtemp(path.join(os.tmpdir(), "kb-codex-models-"));
  try {
    return await new Promise<ModelOption[]>((resolve, reject) => {
      const child = spawn(process.env.KB_CODEX_BIN || process.env.CODEX_CLI_PATH || "codex", [
        "app-server", "--listen", "stdio://", "-c", "mcp_servers={}", "-c", 'web_search="disabled"',
        "-c", "project_doc_max_bytes=0", "-c", 'approval_policy="never"',
        "-c", "features.hooks=false", "-c", "features.plugins=false", "-c", "features.apps=false",
      ], { cwd, env: codexEnvironment(), shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      let buffer = "", bytes = 0, settled = false, result: ModelOption[] = [], failure: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (kind: NodeJS.Signals) => {
        try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, kind); else child.kill(kind); } catch { /* exited */ }
      };
      const onExit = () => kill("SIGKILL");
      process.once("exit", onExit);
      const stop = (error?: Error) => {
        if (settled) return;
        settled = true; failure = error; clearTimeout(timer); signal?.removeEventListener("abort", cancel);
        child.stdin.end(); kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), 700); killTimer.unref();
      };
      const cancel = () => stop(new StoreError("读取模型列表已取消", 499));
      const timer = setTimeout(() => stop(new StoreError("读取模型列表超时，可手动填写模型 ID", 504)), 15000);
      signal?.addEventListener("abort", cancel, { once: true });
      const send = (value: unknown) => { if (!settled) child.stdin.write(JSON.stringify(value) + "\n"); };
      child.stdin.on("error", () => {});
      child.stderr.resume();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk); buffer += chunk;
        if (bytes > 1_000_000) { stop(new StoreError("模型目录过大，可手动填写模型 ID", 502)); return; }
        let end: number;
        while (!settled && (end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          try {
            const message = record(JSON.parse(line));
            if (message.method && message.id !== undefined) { stop(new StoreError("模型目录请求包含意外操作，已停止", 502)); break; }
            if (message.id !== 1 && message.id !== 2) continue;
            if (message.error) { stop(new StoreError("Codex 未能读取模型目录，请检查登录或手动填写模型 ID", 502)); break; }
            if (message.id === 1) {
              send({ method: "initialized" });
              send({ id: 2, method: "model/list", params: { limit: 100, includeHidden: false } });
            } else { result = modelOptions(message.result, "codex"); stop(); }
          } catch (error) { stop(error instanceof StoreError ? error : new StoreError("Codex 模型目录格式无效", 502)); }
        }
      });
      child.on("error", () => stop(new StoreError("无法启动 Codex，请检查 CLI 安装", 422)));
      child.on("close", () => {
        if (!settled) stop(new StoreError("读取模型目录时 Codex 提前退出", 502));
        // The CLI wrapper can exit before its descendants. Ensure a child that
        // ignored SIGTERM cannot survive after the wrapper's close event.
        kill("SIGKILL");
        clearTimeout(killTimer); process.removeListener("exit", onExit);
        if (failure) reject(failure); else resolve(result);
      });
      if (signal?.aborted) cancel();
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "yanzhi_model_picker", title: "研知", version: "0.1.0" } } });
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

export async function listModelOptions(config: ModelConfiguration, signal?: AbortSignal): Promise<ModelOption[]> {
  if (signal?.aborted) throw new StoreError("读取模型列表已取消", 499);
  if (config.provider === "codex") return codexModelCatalog(signal);
  if (!["ollama", "openai-compatible"].includes(config.provider)) throw new StoreError("请先在 AI 设置中选择模型服务", 422);
  let url: URL;
  try { url = new URL(config.endpoint); }
  catch { throw new StoreError("模型服务地址无效", 400); }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
    (!local && url.protocol !== "https:") || (config.provider === "ollama" && !local)) throw new StoreError("模型服务地址无效", 400);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(config.endpoint.replace(/\/$/, "") + (config.provider === "ollama" ? "/api/tags" : "/models"), {
      method: "GET", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(12000), ...(signal ? [signal] : [])]),
      headers: config.provider === "openai-compatible" && process.env.KB_OPENAI_API_KEY ? { Authorization: "Bearer " + process.env.KB_OPENAI_API_KEY } : {},
    });
    if (!response.ok) { await response.body?.cancel(); throw new StoreError("模型服务未提供可用列表，可手动填写模型 ID", 502); }
    reader = response.body?.getReader();
    if (!reader) throw new StoreError("模型目录为空", 502);
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > 1_000_000) throw new StoreError("模型目录过大", 502);
      chunks.push(value);
    }
    if (signal?.aborted) throw new StoreError("读取模型列表已取消", 499);
    return modelOptions(JSON.parse(Buffer.concat(chunks).toString("utf8")), config.provider);
  } catch (error) {
    if (signal?.aborted) throw new StoreError("读取模型列表已取消", 499);
    if (error instanceof StoreError) throw error;
    throw new StoreError("读取模型列表失败，可手动填写模型 ID", 502);
  } finally { await reader?.cancel().catch(() => {}); }
}
